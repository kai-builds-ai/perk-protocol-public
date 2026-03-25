# Perk Protocol — Cranker Audit (Round 1)

**Auditor:** Kai (automated review)
**Date:** 2026-03-25
**Scope:** `cranker/` directory — all TypeScript files, plus SDK context
**Style:** Pashov-format correctness audit
**Severity Scale:** Critical / High / Medium / Low / Informational

---

## Summary

The cranker is a single-process, multi-loop bot that services Perk Protocol markets: oracle updates, funding rate cranking, liquidation, trigger order execution, and AMM peg maintenance. The code is well-structured and readable. However, several issues range from dead code and missing rate limiting to a potential mark-price math error and silent loop death.

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 3 |
| Medium | 5 |
| Low | 4 |
| Informational | 4 |

---

## High Severity

### [H-01] `maxTxPerMinute` is configured but never enforced

**File:** `config.ts`, all loop files
**Impact:** Runaway transaction spam could drain the cranker wallet or hit RPC rate limits.

`CrankerConfig.maxTxPerMinute` is read from env (default 120), but no loop checks or increments a transaction counter. During high activity (many liquidatable positions, many triggered orders), the cranker will fire unlimited transactions per minute.

**Recommendation:** Implement a shared rate limiter (token bucket or sliding window) that all loops consult before sending a transaction. Example:

```ts
class RateLimiter {
  private timestamps: number[] = [];
  constructor(private maxPerMinute: number) {}
  
  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length >= this.maxPerMinute) {
      const waitMs = 60_000 - (now - this.timestamps[0]);
      await sleep(waitMs);
    }
    this.timestamps.push(Date.now());
  }
}
```

---

### [H-02] Market list is never refreshed — new markets are invisible

**File:** `cranker.ts` (lines 62-64)
**Impact:** Markets created after cranker startup receive no oracle updates, no funding cranks, no liquidations, no trigger execution, and no peg updates until the cranker is manually restarted.

```ts
const markets = await client.fetchAllMarkets();
const activeMarkets = markets.filter((m) => m.account.active);
```

This runs once. Every loop receives the static `activeMarkets` array. A market created 5 minutes after startup will have:
- Stale/missing oracle prices
- No funding rate cranks (funding accrues debt to one side)
- No liquidation coverage
- No trigger order execution
- No peg updates

**Recommendation:** Periodically re-fetch the market list (e.g., every 5 minutes) and pass updated lists to each loop. Each loop should accept a getter function or subscribe to market list changes.

---

### [H-03] Loop crashes are silent and permanent — no restart, no alert

**File:** All loop files (`oracle.ts`, `funding.ts`, `liquidation.ts`, `triggers.ts`, `peg.ts`)
**Impact:** If any loop throws an unhandled error that escapes the `while` loop (e.g., a TypeError from unexpected SDK response shape), it dies silently. The cranker process stays alive (other loops running), but the dead loop's responsibilities are abandoned.

```ts
loop().catch((err) => {
  log.error("Oracle loop crashed", { error: String(err) });
  // ... and then nothing. Loop is dead forever.
});
```

**Recommendation:**
1. Wrap each loop in a restart-with-backoff wrapper.
2. Add a health check (HTTP endpoint or heartbeat file) that monitors all loops.
3. Consider `process.exit(1)` after N loop crashes to let a process manager (PM2, systemd) restart the entire process.

---

## Medium Severity

### [M-01] Peg mark price formula — division by `K_SCALE` needs verification

**File:** `loops/peg.ts`, `computeMarkPrice()`
**Impact:** If the formula is wrong, the peg loop either never triggers (mark price always appears close to oracle) or triggers incorrectly, causing unnecessary or missed AMM updates.

```ts
const numerator = market.quoteReserve.mul(market.pegMultiplier);
const denominator = market.baseReserve.mul(K_SCALE);
return numerator.mul(new BN(PRICE_SCALE)).div(denominator);
```

The architecture doc states: `mark_price = (quote_reserve * peg_multiplier) / base_reserve`

The code divides by `baseReserve * K_SCALE` (1e12 extra). This is only correct if on-chain reserves are stored pre-multiplied by K_SCALE, or if `pegMultiplier` is stored in a scale that compensates. Without the Rust source, this cannot be confirmed.

**Worked example:** If `quoteReserve = 1e9`, `pegMultiplier = 150e6` (150 USD in PEG_SCALE), `baseReserve = 1e9`:
- Architecture formula: `(1e9 * 150e6) / 1e9 = 150e6` ✓ (150 USD in PRICE_SCALE)
- Code formula: `(1e9 * 150e6 * 1e6) / (1e9 * 1e12) = 150` ✗ (150 / 1e6 = 0.00015 USD)

This suggests the formula is **off by PRICE_SCALE** unless reserves are stored ~1e12 larger than the architecture implies.

**Recommendation:** Verify against on-chain Rust `compute_mark_price()` function. If reserves are stored as `value * K_SCALE^(1/2)` or similar, document this. If not, this is a critical math bug.

---

### [M-02] Oracle backoff logic is dead code

**File:** `loops/oracle.ts`
**Impact:** The intended exponential backoff after failures doesn't work. The cranker hammers the RPC/on-chain at full speed even during sustained errors.

```ts
state.backoffMs = 0; // initialized

// In error handler:
state.consecutiveFailures++;
// backoffMs is never set to anything > 0

// In loop:
if (state.backoffMs > 0) {
  await sleep(state.backoffMs);  // Dead path — never reached
} else {
  await sleep(config.oracleIntervalMs);
}
```

`state.backoffMs` is initialized to 0 and never mutated. The `if (state.backoffMs > 0)` branch is unreachable.

**Recommendation:** Implement actual backoff:
```ts
state.backoffMs = Math.min(state.backoffMs * 2 || 1000, 60_000);
```
And reset to 0 on success (which is already done for `consecutiveFailures` but not `backoffMs`).

---

### [M-03] Error string matching for circuit breaker / banding is fragile

**File:** `loops/oracle.ts`
**Impact:** If the on-chain program changes error names or Anchor changes serialization format, these errors will fall through to the generic error handler, causing unnecessary 60s pauses after 10 occurrences.

```ts
if (errStr.includes("OracleCircuitBreakerTripped")) { ... }
if (errStr.includes("PriceBandingExceeded")) { ... }
```

**Recommendation:** Import the error codes from the IDL and match on error code numbers rather than string names. Anchor errors have stable numeric codes:
```ts
if (parseAnchorError(err)?.code === 6042) { /* circuit breaker */ }
```

---

### [M-04] Expired trigger orders are skipped but never cleaned up

**File:** `loops/triggers.ts`
**Impact:** Expired orders accumulate on-chain forever, consuming rent and slowing down the `all()` query with each cycle. Over time, this degrades performance.

```ts
if (order.expiry.toNumber() < nowSec) {
  log.debug("Trigger order expired", ...);
  continue; // Skipped but not cancelled
}
```

**Recommendation:** Call `client.cancelTriggerOrder()` (or a dedicated cleanup instruction) for expired orders to reclaim rent and reduce scan overhead. Note: only the order owner or a permissionless cleanup instruction can close the account — verify the on-chain program supports permissionless cleanup of expired orders.

---

### [M-05] Price feed `Math.round(price * 1e6)` can lose precision for high-value tokens

**File:** `feeds.ts`
**Impact:** For tokens priced above ~$9,007,199 USD, `price * PRICE_SCALE` exceeds `Number.MAX_SAFE_INTEGER` (2^53). `Math.round()` silently loses precision, and `new BN(result)` receives an imprecise value. This could cause oracle updates to be rejected by on-chain banding checks.

Example: BTC at $90,000 → `90000 * 1e6 = 9e10` — safe. But a token at $10M → `10e6 * 1e6 = 1e13` — still safe. Only an issue above ~$9.007e9 (unlikely for current tokens but worth defending against).

**Recommendation:** Use string-based conversion to avoid floating-point:
```ts
const [whole, frac = ""] = finalPriceUsd.toFixed(6).split(".");
const priceScaled = new BN(whole + frac.padEnd(6, "0"));
```

---

## Low Severity

### [L-01] Graceful shutdown may not wait for in-flight transactions

**File:** `cranker.ts`
**Impact:** The 3-second shutdown timeout may not be enough if a loop is in a 60-second pause (after 10 consecutive failures). Pending transactions may be abandoned.

```ts
setTimeout(() => {
  log.info("Cranker stopped");
  process.exit(0);
}, 3000);
```

**Recommendation:** Track in-flight transactions with a `Promise.all` barrier, or increase timeout to max(loop intervals) + transaction timeout. At minimum, log a warning if force-exiting with pending work.

---

### [L-02] Token account caches grow unboundedly

**File:** `loops/liquidation.ts`, `loops/triggers.ts`
**Impact:** `tokenAccountCache` and `executorAtaCache` are module-level `Map`s that are never cleared. With many collateral mints, these grow without bound. In practice the cardinality is limited (one entry per unique cranker+mint pair), so this is minor.

**Recommendation:** Either document the expected cardinality bound or add a TTL/LRU eviction policy.

---

### [L-03] Trigger order double-execution attempt within 1-second window

**File:** `loops/triggers.ts`
**Impact:** The trigger loop runs every 1 second. If `executeTriggerOrder` is submitted in cycle N but hasn't confirmed by cycle N+1, the order still appears in the `all()` scan and will be attempted again. The on-chain program will reject the duplicate (order account closed), wasting a transaction fee.

**Recommendation:** Maintain a short-lived in-memory set of recently-executed order addresses (TTL ~10s) and skip them:
```ts
const recentlyExecuted = new Set<string>();
// After successful execution:
recentlyExecuted.add(orderAddress.toBase58());
setTimeout(() => recentlyExecuted.delete(orderAddress.toBase58()), 10_000);
```

---

### [L-04] Funding loop uses stale `account` data for initial time check

**File:** `loops/funding.ts`
**Impact:** After the first successful funding crank, the initial `account.lastFundingTime` is stale (still the value from startup). Every subsequent tick passes the initial check and triggers an unnecessary RPC call to `fetchMarketByAddress`, which then correctly rejects. This wastes RPC quota.

**Recommendation:** Update the local market reference after a successful crank, or fetch fresh data unconditionally (simpler, since the interval is 60s).

---

## Informational

### [I-01] No health monitoring endpoint

The cranker has no HTTP health endpoint, no metrics, and no way for external monitoring to verify it's operational. For a production-critical service, this is a significant observability gap.

**Recommendation:** Add a simple HTTP server (e.g., port from env) exposing:
- `/health` — returns 200 if all loops are alive
- `/metrics` — loop iteration counts, last success timestamps, error counts

---

### [I-02] Feeds don't propagate source timestamps

**File:** `feeds.ts`
**Impact:** Both `fetchJupiterPrice` and `fetchBirdeyePrice` use `Date.now()` as the timestamp rather than the API response's actual price timestamp. This means staleness detection based on `PriceSource.timestamp` would be inaccurate. Currently no consumer checks staleness, but it's a footgun for future use.

---

### [I-03] `dryRun` mode doesn't simulate the full path

When `dryRun` is true, loops skip the transaction but also skip post-tx logic (resetting `consecutiveFailures`, etc.). This means dry-run testing doesn't fully exercise the success path.

---

### [I-04] No compute budget / priority fee configuration

The cranker doesn't set `ComputeBudgetProgram.setComputeUnitPrice` or `setComputeUnitLimit`. On congested networks, cranker transactions will be deprioritized. The `PerkClient` supports `preInstructions` for this purpose, but the cranker doesn't use it.

**Recommendation:** Add configurable priority fees (env var), and construct the `PerkClient` with appropriate `preInstructions`:
```ts
const client = new PerkClient({
  connection,
  wallet,
  programId,
  preInstructions: [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFee }),
  ],
});
```

---

## Positive Observations

1. **Error isolation per-market within loops** — One market failing doesn't block processing of other markets. Each market is wrapped in its own try/catch.
2. **Re-fetching before mutation** — The funding loop re-fetches the market before cranking to avoid double-cranks. Good defensive pattern.
3. **Pyth-fed market filtering** — The oracle loop correctly filters to `PerkOracle` markets only, avoiding interference with Pyth-fed markets.
4. **Deduplication of token mints** — Oracle loop deduplicates by mint, avoiding redundant price fetches for markets sharing an oracle.
5. **Dry-run mode** — Useful for testing in production without sending transactions.
6. **Trigger condition logic** — All six trigger conditions (StopLoss/TakeProfit/Limit × Long/Short) are correct per the architecture spec.
7. **Liquidation margin math** — The `computeMarginRatio` function correctly handles long/short PnL direction and the underwater case (returns 0).
8. **Price feed validation** — `feeds.ts` correctly rejects `!isFinite`, `<= 0`, missing fields, and API errors for both Jupiter and Birdeye sources.

---

## Recommended Priority

1. **[H-02]** Market list refresh — highest operational risk, silent failure mode
2. **[H-03]** Loop crash recovery — second highest, same silent failure pattern
3. **[M-01]** Peg formula verification — potentially wrong math, needs Rust cross-reference
4. **[H-01]** Rate limiting — wallet drain risk under load
5. **[I-04]** Priority fees — critical for mainnet reliability
6. Everything else in descending severity order
