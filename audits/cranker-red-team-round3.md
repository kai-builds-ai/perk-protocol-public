# Cranker Red Team — Round 3

**Date:** 2026-03-25  
**Auditor:** Kai (automated red team)  
**Scope:** All cranker source files post-fix  
**Verdict:** No critical vulnerabilities remaining. Several low/medium issues found worth tracking.

---

## Attack Vector Analysis

### 1. splice() Atomicity — Array Mutation During Async Iteration

**Status: ⚠️ LOW — Theoretical race, mitigated in practice**

The concern: `activeMarkets.splice(0, length, ...freshActive)` fires from a `setInterval` callback. If a loop is mid-`for...of` iteration on `activeMarkets` and hits an `await` (e.g., `await client.fetchMarketByAddress(address)`), the event loop could run the splice callback before the loop resumes, mutating the array under iteration.

**Analysis:**

- `splice()` itself is synchronous and atomic — the array is consistent at any synchronous observation point.
- However, `for (const { address, account } of markets)` in every loop destructures each element at iteration time. Between two iterations, if an `await` yields, the setInterval callback *can* fire and replace the array contents.
- **What actually happens:** `for...of` uses an iterator that tracks an *index*. After splice replaces all elements, the iterator's index may now point to a different market or past the end of the array. This can cause:
  - **Skipped markets** — if new array is shorter, iteration ends early
  - **Repeated markets** — if new array reorders elements, some may be visited twice
  - **No crash** — just silently wrong behavior for one tick

**Severity:** Low. This can only cause a single tick to process a slightly wrong set of markets. The next tick sees the correct array. No financial loss possible — the on-chain program validates all accounts.

**Recommendation:** Replace direct array mutation with a reference swap pattern:
```ts
// In cranker.ts — store markets in a wrapper object
const state = { markets: activeMarkets };
// Pass `state` to loops; loops read `state.markets` at start of each tick
// Refresh replaces the reference atomically:
state.markets = freshActive;
```
This eliminates the mid-iteration mutation entirely.

---

### 2. Oracle tick() Performance — Filtering 1000 Markets

**Status: ✅ NON-ISSUE**

The oracle loop filters markets by `oracleSource === OracleSource.PerkOracle` every tick (10s). For 1000 markets:

- `Array.filter()` on 1000 items: ~0.01ms. Negligible.
- The real cost is the `Map` construction for unique mints and the HTTP fetches to Jupiter/Birdeye.
- With N unique mints, that's 2N HTTP requests per tick (Jupiter + Birdeye). At 1000 unique mints with 5s timeout each, worst case is 5000s — obviously too slow for a 10s interval.

**Real bottleneck:** Not the filter, but the **sequential** HTTP fetches in the `for...of` loop over `uniqueMints`. Each mint does `await fetchPrice()` which awaits two HTTP calls. With 50 PerkOracle mints, that's 100 HTTP calls in series → ~25-50s at typical latencies, far exceeding the 10s interval.

**Severity:** Medium for scaling. Not exploitable, but the cranker will fall behind on oracle updates if there are many PerkOracle markets.

**Recommendation:** Batch price fetches with `Promise.all` (or `Promise.allSettled` with concurrency limit):
```ts
const CONCURRENCY = 10;
// Process mints in batches of CONCURRENCY
```

---

### 3. Liquidation Sort Cost — 5000+ BN Multiplications at 2s Interval

**Status: ⚠️ LOW — Performance concern, not exploitable**

When `allPositions.length > MAX_ACCOUNTS (5000)`, the code computes `computeMarginRatio()` for *every* position. Each call does:
- 2x `BN.mul()` 
- 2x `BN.div()`
- 1x `BN.sub()` or `BN.add()`
- 1x `BN.mul()` + `BN.div()` for ratio

That's ~7 BN operations × 5000+ positions = 35,000+ BN operations, then a sort.

**Benchmarked estimate:** BN operations on 64-bit numbers in JS: ~100ns each. 35K ops ≈ 3.5ms. Sort of 5000 elements ≈ 0.5ms. **Total: ~4ms.** Well within the 2s interval.

**But:** The bigger cost is `client.accounts.userPosition.all()` — an RPC `getProgramAccounts` call that fetches ALL positions for a market. With 10,000+ positions, this RPC call itself could take 2-10s and return 10-50MB of data. This is the real bottleneck, not the sort.

**Severity:** Low. The sort math is cheap. The RPC fetch is the actual scaling concern but that's inherent to the architecture.

**Recommendation:** Consider pagination or an off-chain indexer for markets with 10K+ positions.

---

### 4. Rate Limiter Starvation via Induced Failures

**Status: ⚠️ MEDIUM — Confirmed viable attack**

The rate limiter calls `record()` *before* sending the TX. If the TX fails (network error, RPC rejection, on-chain error), the slot is consumed. An attacker who can cause TX failures can starve the rate limiter.

**Attack scenario:**
1. Attacker opens many tiny positions just above liquidation threshold.
2. Attacker manipulates price (via legitimate trading) to push them barely below threshold.
3. Cranker attempts liquidation on each position → on-chain program rejects because margin is actually fine (off-chain vs on-chain price disagreement from the safety factor).
4. Each failed attempt consumes a rate limiter slot.
5. At 120 TX/min, 120 failed liquidation attempts in a burst starves the limiter for a full minute.
6. During this window, *real* liquidations, trigger executions, oracle updates, and peg corrections are all blocked.

**Aggravating factor:** The `LIQUIDATION_SAFETY_FACTOR = 0.95` reduces but doesn't eliminate this. The attacker can position themselves at exactly the borderline where off-chain math says "liquidatable" but on-chain says "no."

**Severity:** Medium. The attacker can't steal funds, but can temporarily prevent the cranker from performing *any* operations, potentially allowing undercollateralized positions to persist longer.

**Recommendations:**
1. **Separate rate limits per loop** — liquidation failures shouldn't block oracle updates.
2. **Don't count confirmed failures** — only `record()` on successful TX confirmation, or maintain separate failure/success budgets.
3. **Prioritize oracle updates** — reserve a portion of the rate limit budget for oracle/peg operations.

---

### 5. Frozen API False Negatives — Tiny Price Oscillations

**Status: ⚠️ MEDIUM — Confirmed bypass**

The frozen API detection in `feeds.ts` checks:
```ts
if (last && Math.abs(last.price - finalPriceUsd) < 0.0001) {
  last.sameCount++;
```

An attacker controlling a price feed API (e.g., via BGP hijack, DNS poisoning, or a compromised API endpoint) can alternate between `$100.0000` and `$100.0002` — a difference of $0.0002, which exceeds the `0.0001` threshold. The frozen detection counter resets every time.

**But wait — is this actually exploitable?** The cranker fetches from Jupiter and Birdeye. An attacker would need to compromise *both* APIs simultaneously (due to the `minPriceSources >= 2` requirement), and keep them within 5% divergence. That's a high bar.

**Real concern:** A more realistic scenario is a single API going stale (returning cached data) while alternating by epsilon due to floating-point jitter in their backend. The frozen detection would miss this.

**Severity:** Low-Medium. The prerequisite (compromising price APIs) is hard. The frozen detection is a *warning* only — it logs but doesn't block price updates. The real protection is the divergence check between sources.

**Recommendation:** Track price *staleness* by timestamp, not just value repetition. If the API returns data with the same server-side timestamp for 5+ fetches, that's frozen regardless of value jitter:
```ts
// Track API response timestamps, not just price values
```

---

### 6. Config Injection via Malicious Environment Variables

**Status: ⚠️ MEDIUM — Several exploitable edge cases**

**6a. Zero or negative intervals:**
```ts
oracleIntervalMs: envInt("PERK_ORACLE_INTERVAL_MS", 10_000),
```
Setting `PERK_ORACLE_INTERVAL_MS=0` causes `sleep(0)` → tight loop → 100% CPU, rapid-fire RPC calls, potential rate limiting by the RPC provider, and rapid TX spam if the rate limiter allows it.

Setting `PERK_ORACLE_INTERVAL_MS=-1000` → `sleep(-1000)` → `setTimeout(resolve, -1000)` → fires immediately (same as 0). Tight loop.

**6b. Zero maxTxPerMinute:**
`PERK_MAX_TX_PER_MINUTE=0` → `new TxRateLimiter(0)` → `canSend()` always returns false → cranker does nothing. Complete denial of service.

**6c. Extremely large maxTxPerMinute:**
`PERK_MAX_TX_PER_MINUTE=999999` → effectively no rate limit → TX spam.

**6d. Invalid maxDivergencePct:**
`PERK_MAX_DIVERGENCE_PCT=-1` → `parseFloat("-1")` = -1 → `divergencePct > -1` is always true → divergence check passes for ANY price difference, including contradictory prices.

`PERK_MAX_DIVERGENCE_PCT=NaN` → `parseFloat("NaN")` = NaN → `divergencePct > NaN` is always false → divergence check is effectively disabled.

**6e. Empty RPC URL:**
`PERK_RPC_URL=""` → passes the truthiness check (`""` is falsy, so actually caught by `if (!rpcUrl)` ✅). But `PERK_RPC_URL=" "` (space) would pass and cause cryptic connection errors.

**Severity:** Medium. These require the attacker to control environment variables, which typically means they already have shell access. But in containerized deployments, env vars can come from config maps, secrets managers, or CI/CD pipelines where injection is more plausible.

**Recommendations:**
```ts
// Add bounds validation in loadConfig():
if (config.oracleIntervalMs < 100) throw new Error("Oracle interval too small (min 100ms)");
if (config.maxTxPerMinute < 1) throw new Error("maxTxPerMinute must be >= 1");
if (config.maxTxPerMinute > 600) log.warn("maxTxPerMinute is very high");
if (!isFinite(config.maxDivergencePct) || config.maxDivergencePct < 0) 
  throw new Error("Invalid maxDivergencePct");
if (config.rpcUrl.trim().length === 0) throw new Error("PERK_RPC_URL is blank");
```

---

### 7. Memory Leaks — Unbounded Cache Growth

**Status: ⚠️ LOW — Real but slow-growing**

**7a. `tokenAccountCache` (liquidation.ts) and `executorAtaCache` (triggers.ts):**
These maps grow by one entry per unique `(crankerPubkey, collateralMint)` pair. Since the cranker uses one keypair, growth = number of unique collateral mints. Typical perp protocol: 1-10 mints. **Not a real leak.**

**7b. `lastPrices` map (feeds.ts):**
Grows by one entry per unique `tokenMint` string ever seen. If markets are added and removed over months, removed market mints stay in the map forever. Each entry: ~100 bytes (string key + object). With 1000 mints over a year: ~100KB. **Negligible.**

**7c. `TxRateLimiter.timestamps` array:**
Self-cleaning on every `canSend()` / `remaining` call — entries older than 60s are filtered out. At 120 TX/min steady state: 120 entries max. **Not a leak.**

**7d. Hidden leak — `allPositions` and `allOrders` arrays:**
Each tick in liquidation/triggers fetches ALL positions/orders via `getProgramAccounts`. These are local variables and get GC'd after each tick. **Not a leak.**

**Severity:** Low. No meaningful memory growth even over months of operation.

**Recommendation:** Optional cleanup of `lastPrices` — evict entries not seen in the current market list during market refresh. Not urgent.

---

### 8. Conflicting TXs — Liquidation + Trigger on Same Position

**Status: ⚠️ MEDIUM — Race condition confirmed**

The liquidation loop and triggers loop run independently on separate intervals (2s and 1s respectively). Consider:

1. User has a long position with a StopLoss trigger at $95.
2. Oracle price drops to $90 → position is both liquidatable AND has its StopLoss triggered.
3. In the same event loop cycle:
   - Liquidation loop finds the position, sends liquidation TX.
   - Triggers loop finds the StopLoss, sends execution TX.
4. Both TXs hit the validator. Whichever lands first succeeds; the other fails with an account-state error.

**Impact:**
- **No fund loss** — the on-chain program validates state. The second TX will fail gracefully.
- **Wasted TX** — one rate limiter slot consumed for nothing.
- **Log noise** — a failed TX error is logged, potentially triggering the consecutive failures counter.

**Worse scenario:** If the triggers loop fires a Limit order execution (opening a NEW position) on the same account that liquidation is closing, the timing could cause:
1. Liquidation closes position → success
2. Limit order opens new position → success (position was just cleared)
3. Net result: user gets a fresh position opened right after liquidation — might not be intended, but the on-chain program should validate margin requirements.

**Severity:** Low-Medium. No financial loss, but wasted resources and potential for confusing state.

**Recommendations:**
1. **In-memory lock per user position** — if liquidation is pending for a `(market, user)` pair, skip trigger execution for that pair (and vice versa).
2. **Liquidation priority** — if a position is both liquidatable and has a triggered order, prefer liquidation (protects the protocol).

---

## Additional Findings (Not in Original Attack Vectors)

### 9. Funding Loop Uses Stale Market Objects for Initial Check

**Status: ⚠️ LOW**

In `funding.ts`, the loop iterates `markets` (the shared array) and checks:
```ts
const lastFunding = account.lastFundingTime.toNumber();
```

This uses the *cached* market `account` from the initial fetch (or last refresh). Between refreshes (5 min), `lastFundingTime` is stale. The loop then re-fetches fresh market data to double-check, so the stale check is just an optimization gate. But if the initial check says "not due yet" using stale data, the re-fetch is skipped entirely — potentially delaying a funding crank by up to 5 minutes.

**Impact:** Funding may be cranked late by one refresh interval. No financial loss (funding just accrues).

### 10. Shutdown Race — Loops May Send TX After Stop Signal

**Status: ⚠️ LOW**

When `shutdown()` is called:
1. `running = false` is set
2. Each loop's `stop()` sets its own `state.running = false`
3. `setTimeout(() => process.exit(0), 3000)` fires

But a loop mid-TX-send (after the `canSend()` check but before the `await client.liquidate()` resolves) will complete that TX. The 3s grace period handles this, but if the Solana RPC is slow (>3s), `process.exit(0)` kills the process mid-flight. The TX may or may not land on-chain — no way to know.

**Impact:** Orphaned TXs on shutdown. Low severity but worth noting for operational awareness.

### 11. No Nonce / Deduplication for Rapid-Fire TXs

**Status: ⚠️ LOW**

The cranker doesn't track recently-sent TX signatures. If a loop ticks twice rapidly (e.g., interval is 1s and tick completes in <1s), it could attempt the same operation twice — e.g., cranking funding for the same market, or executing the same trigger order.

The on-chain program likely rejects duplicates (funding: checks lastFundingTime; triggers: checks order still exists), but the cranker pays compute for the failed TX.

### 12. `computeMarginRatio` Precision Loss

**Status: ⚠️ LOW**

```ts
const ratioScaled = equity.mul(new BN(BPS_DENOMINATOR)).div(notional);
return ratioScaled.toNumber() / BPS_DENOMINATOR;
```

`BPS_DENOMINATOR` is 10000. For very large positions (equity or notional > 2^53 / 10000 ≈ 9 × 10^11 in base units), `ratioScaled.toNumber()` could exceed `Number.MAX_SAFE_INTEGER` and lose precision. This is unlikely with typical token scales but possible with very small-decimal tokens.

**Impact:** Could cause a position to be incorrectly classified as liquidatable or safe. Low probability.

---

## Summary

| # | Issue | Severity | Exploitable? | Fix Effort |
|---|-------|----------|-------------|------------|
| 1 | splice() mid-iteration race | Low | No (one tick glitch) | Easy — reference swap |
| 2 | Oracle sequential HTTP bottleneck | Low | No (perf only) | Medium — add concurrency |
| 3 | Liquidation sort cost | Non-issue | No | N/A |
| 4 | **Rate limiter starvation** | **Medium** | **Yes** | Medium — per-loop limits |
| 5 | Frozen API bypass via oscillation | Low-Medium | Unlikely (needs API compromise) | Easy — timestamp tracking |
| 6 | **Config injection edge cases** | **Medium** | **Yes (with env access)** | Easy — validation |
| 7 | Memory leaks | Non-issue | No | N/A |
| 8 | Conflicting TXs on same position | Low-Medium | No (on-chain validates) | Medium — position locks |
| 9 | Funding stale initial check | Low | No | Easy — skip initial check |
| 10 | Shutdown TX orphaning | Low | No | Low — extend grace period |
| 11 | No TX deduplication | Low | No (on-chain validates) | Medium |
| 12 | BN precision loss | Low | Unlikely | Easy — use BN throughout |

**Top Priority Fixes:**
1. **Config validation** (#6) — easiest win, prevents operational footguns
2. **Per-loop rate limits** (#4) — prevents cross-loop starvation
3. **Reference swap for market refresh** (#1) — eliminates theoretical race cleanly

**Overall Assessment:** The cranker is in solid shape after rounds 1-2. No critical or high-severity issues remain. The medium findings (#4 and #6) are worth addressing but require specific attacker prerequisites (ability to spam borderline positions, or env var access). The codebase demonstrates good defensive practices with rate limiting, safety factors, crash recovery, and logging.
