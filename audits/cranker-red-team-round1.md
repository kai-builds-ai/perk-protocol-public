# Cranker Red Team Report — Round 1

**Date:** 2026-03-25  
**Auditor:** Kai (AI Red Team)  
**Scope:** `cranker/` directory + SDK client/types  
**Severity Scale:** 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low | ℹ️ Informational

---

## Executive Summary

The cranker is reasonably well-structured with dry-run support, exponential backoff, and circuit breaker awareness. However, there are several exploitable issues ranging from oracle manipulation vectors to denial-of-service amplification and race conditions that could cause financial loss or protocol disruption.

**Critical findings: 2 | High: 4 | Medium: 5 | Low: 3 | Informational: 3**

---

## 🔴 Critical Findings

### CRIT-01: Oracle Price Averaging With Only 2 Sources Enables Manipulation

**File:** `cranker/feeds.ts` lines 89-107  
**Attack:** An attacker who can manipulate **one** of the two price sources (Jupiter or Birdeye) can shift the oracle price by up to 50% of the manipulation amount.

**Details:**
```typescript
if (sources.length === 2) {
  finalPriceUsd = (sources[0].price + sources[1].price) / 2;
  confidenceUsd = Math.abs(sources[0].price - sources[1].price);
}
```

With only 2 sources, the average is trivially manipulable. If Jupiter returns $100 (real) and Birdeye is manipulated to return $200, the oracle feeds $150 — a 50% mispricing. The `confidence` field captures the spread but **nothing in the cranker checks confidence against a threshold before submitting the update**. The on-chain `PriceBandingExceeded` and `OracleCircuitBreakerTripped` errors are caught and logged but relied upon entirely for safety.

**Worse:** If Birdeye API key is not set (`birdeyeApiKey` is optional in config), the cranker falls back to **single-source mode** with Jupiter alone and confidence = 0, making it trivially manipulable by a Jupiter price manipulation (e.g., flash loan attack on Jupiter pools).

**Impact:** Catastrophic mispricing → wrongful liquidations, trigger order executions at bad prices, AMM peg manipulation.

**Recommendation:**
1. Add a **maximum confidence threshold** in the cranker — reject updates where `confidence / price > X%` (e.g., 2%).
2. Require a minimum of 2 sources. If only 1 is available, skip the update rather than feeding a single-source price.
3. Add a third price source (e.g., Pyth, CoinGecko) and use median instead of mean.

---

### CRIT-02: No Staleness Check on Price Sources

**File:** `cranker/feeds.ts`  
**Attack:** If both APIs return cached/stale prices (common during API degradation), the cranker happily feeds them on-chain with `timestamp: Date.now()` — the timestamp reflects when the cranker *fetched*, not when the price was *observed* by the source.

**Details:**
```typescript
return { name: "jupiter", price, timestamp: Date.now() };
```

The Jupiter v2 API and Birdeye API don't always include a last-updated timestamp in their response. The cranker uses `Date.now()` unconditionally, so on-chain staleness checks (via `maxStalenessSeconds`) are bypassed — the on-chain oracle always sees a "fresh" timestamp even if the underlying price data is minutes or hours old.

**Impact:** Stale prices fed as fresh → liquidations, trigger executions, and peg updates based on outdated prices.

**Recommendation:**
1. Parse the actual price timestamp from source APIs where available.
2. Compare source timestamps against each other — if they diverge by >30s, flag as potentially stale.
3. Track the last *actual price change* — if the price hasn't changed across N updates, log a warning and consider skipping.

---

## 🟠 High Findings

### HIGH-01: Unbounded `fetchAll` Calls Enable Memory Exhaustion DoS

**Files:** `cranker/loops/liquidation.ts`, `cranker/loops/triggers.ts`  
**Attack:** An attacker creates thousands of positions or trigger orders on a market. Every liquidation tick calls `client.accounts.userPosition.all(...)` and every trigger tick calls `client.accounts.triggerOrder.all(...)`, fetching **all** accounts into memory.

**Details:**
- Liquidation loop runs every **2 seconds** (default `liquidationIntervalMs`)
- Triggers loop runs every **1 second** (default `triggerIntervalMs`)
- Each tick fetches ALL positions/orders for EVERY active market
- With 10,000 positions per market × 5 markets = 50,000 account deserializations per tick
- At 1-second intervals, this is 50,000 RPC calls worth of data per second

The `getProgramAccounts` RPC call with memcmp filters still returns all matching accounts. On Solana, creating accounts is cheap (~0.002 SOL for rent). An attacker could create thousands of tiny positions to bloat memory.

**Impact:** Cranker OOM crash → all loops stop → no liquidations, no oracle updates, no trigger executions. Protocol becomes unsafe.

**Recommendation:**
1. Implement pagination (fetch in batches of 100-500).
2. Add a position count sanity check — if `allPositions.length > MAX_EXPECTED`, log critical alert and process in chunks.
3. Consider using `getMultipleAccounts` with known position PDAs rather than `getProgramAccounts`.

---

### HIGH-02: Liquidation Margin Calculation May Diverge From On-Chain

**File:** `cranker/loops/liquidation.ts`, function `computeMarginRatio`  
**Attack:** The off-chain margin calculation doesn't account for: accumulated funding payments, warmup period effects, fee credits, or haircut adjustments that the on-chain program uses.

**Details:**
The on-chain `UserPositionAccount` has fields the cranker ignores:
- `lastCumulativeFunding` — funding payments owed but not yet settled
- `warmupStartedAtSlot` / `warmupSlope` — warmup period affects effective position size
- `feeCredits` — credited fees that affect margin
- `haircutNumerator` / `haircutDenominator` on market — affects PnL calculation
- `pnl` / `reservedPnl` — stored PnL fields

The cranker's `computeMarginRatio` only uses `depositedCollateral`, `baseSize`, `quoteEntryAmount`, and `oraclePrice`. This simplified calculation can:
1. **Over-estimate margin** (miss a position that should be liquidated) — positions survive longer than they should, increasing bad debt risk.
2. **Under-estimate margin** (try to liquidate a healthy position) — the TX fails on-chain, wasting SOL on transaction fees.

**Impact:** Failed liquidation TXs drain cranker SOL; missed liquidations increase protocol bad debt.

**Recommendation:**
1. Include funding payment calculations in the margin computation.
2. Factor in warmup period effects on effective size.
3. Add a small buffer (e.g., only liquidate if marginRatio < maintenanceMarginBps * 0.95) to account for calculation drift.

---

### HIGH-03: Race Condition Between Liquidation Check and TX Submission

**File:** `cranker/loops/liquidation.ts`  
**Attack:** Between the cranker reading a position as liquidatable and submitting the liquidation TX, the user can:
1. Deposit more collateral
2. Partially close the position
3. Get liquidated by another liquidator (MEV bot)

**Details:**
```typescript
// Step 1: Fetch all positions (stale the moment they're read)
const allPositions = await client.accounts.userPosition.all([...]);
// Step 2: Fetch fresh market (oracle price may have already changed)
const freshMarket = await client.fetchMarketByAddress(address);
// Step 3: For each position, compute margin and submit liquidation
// ... potentially seconds later, the position state has changed
```

The cranker processes positions sequentially. If there are 100 positions to check, the last position is evaluated with data that's potentially seconds old. Each failed TX costs ~5,000 lamports in fees.

**Impact:** Wasted transaction fees, missed liquidation opportunities, MEV extraction by front-runners.

**Recommendation:**
1. Re-fetch position state immediately before submitting liquidation TX.
2. Or accept the race condition but batch multiple liquidations into a single transaction (reduces per-failure cost).
3. Use Jito bundles with tip to prevent front-running.

---

### HIGH-04: Cranker Key Compromise Enables Oracle Manipulation

**File:** `sdk/src/client.ts` — `updatePerkOracle` method  
**Attack:** If the cranker keypair is stolen, the attacker can call `updatePerkOracle` with arbitrary prices, subject to on-chain price banding and circuit breaker constraints. However:

1. **Price banding can be walked**: If `maxPriceChangeBps` is 3000 (30%), an attacker can move the price 30% per update, repeatedly. Over 10 updates they could 10x or 0.1x the price.
2. **Circuit breaker uses EMA**: The EMA lags, so gradual manipulation over minutes can shift it without tripping the breaker.
3. **No rate limiting on-chain**: The cranker authority can submit updates as fast as Solana processes them.

**Impact:** With a compromised key, an attacker could gradually walk oracle prices to extreme values, enabling:
- Wrongful liquidations of all positions on one side
- Trigger order executions at manipulated prices
- AMM peg updates to extreme values

**Recommendation:**
1. Implement on-chain rate limiting (max 1 oracle update per N slots per authority).
2. Add on-chain cumulative drift protection (max X% change over Y minutes).
3. Use a multisig or threshold signature scheme for oracle authority.
4. Monitor oracle updates externally and freeze the oracle if anomalies detected.

---

## 🟡 Medium Findings

### MED-01: No Maximum Divergence Check Between Sources

**File:** `cranker/feeds.ts`  
**Attack:** If Jupiter says $100 and Birdeye says $1,000, the cranker feeds $550 with confidence $900. There's no check like "if sources disagree by > 10%, don't submit."

**Recommendation:** Add a max divergence threshold. If `confidence / price > 5%`, reject the update and log a critical alert.

---

### MED-02: `maxTxPerMinute` Rate Limit Is Defined But Never Enforced

**File:** `cranker/config.ts` (defined), all loops (never checked)  
**Details:** The config has `maxTxPerMinute: 120` but no loop checks this. Under load (many liquidations + triggers + oracle updates), the cranker could blow through RPC rate limits or exhaust SOL faster than expected.

**Recommendation:** Implement a shared transaction counter/semaphore across all loops.

---

### MED-03: Expired Trigger Orders Still Fetched Every Tick

**File:** `cranker/loops/triggers.ts`  
**Attack:** An attacker creates thousands of trigger orders with past expiry dates. They're never executable but the cranker fetches and evaluates them every tick (every 1 second). The orders persist on-chain until explicitly cancelled.

**Impact:** Wasted RPC bandwidth and CPU cycles. Amplifies HIGH-01 (memory exhaustion).

**Recommendation:** Filter expired orders early, or better yet, handle expired order cleanup (if the on-chain program supports it).

---

### MED-04: Floating Point Precision Loss in Price Conversion

**File:** `cranker/feeds.ts`  
**Details:**
```typescript
const priceScaled = new BN(Math.round(finalPriceUsd * PRICE_SCALE));
```

For very small prices (e.g., memecoins at $0.000001), `finalPriceUsd * 1_000_000 = 1.0`, which rounds correctly. But for prices like $0.0000001234, `0.0000001234 * 1_000_000 = 0.1234`, which rounds to 0 — a **zero price** would be fed on-chain.

For very large prices (e.g., BTC at $100,000), `100000 * 1_000_000 = 100_000_000_000`, which exceeds `Number.MAX_SAFE_INTEGER` (2^53). JavaScript's `Math.round` would lose precision.

**Recommendation:** Use string-to-BN conversion with explicit decimal handling instead of floating-point multiplication. Or validate that the scaled price is non-zero and within safe integer bounds.

---

### MED-05: Market List Is Static — New Markets Require Restart

**File:** `cranker/cranker.ts`  
**Details:** Markets are fetched once at startup:
```typescript
const markets = await client.fetchAllMarkets();
const activeMarkets = markets.filter((m) => m.account.active);
```

If a new market is created or a market is deactivated after the cranker starts, the cranker won't pick it up until restarted.

**Impact:** New markets have no oracle updates, liquidations, or trigger processing until manual restart. Deactivated markets continue to be checked (wasted resources).

**Recommendation:** Periodically re-fetch the market list (e.g., every 5 minutes).

---

## 🟢 Low Findings

### LOW-01: Shutdown Timer Is Fixed at 3 Seconds

**File:** `cranker/cranker.ts`  
**Details:** `setTimeout(() => process.exit(0), 3000)` — if a long RPC call is in-flight, it may not complete before exit. Could leave a transaction in an ambiguous state.

**Recommendation:** Track in-flight transactions and wait for them to confirm or timeout.

---

### LOW-02: Token Account Cache Never Invalidated

**Files:** `cranker/loops/liquidation.ts`, `cranker/loops/triggers.ts`  
**Details:** The `tokenAccountCache` / `executorAtaCache` maps grow forever. If the cranker runs for weeks with many markets, this is a minor memory leak. More importantly, if an ATA is closed and recreated at a different address (unlikely but possible), the cached address would be stale.

**Recommendation:** Add TTL or size bounds to the cache.

---

### LOW-03: Console Error Logging May Lose Context in Production

**File:** `cranker/logger.ts`  
**Details:** Errors are logged as `console.error(JSON.stringify(entry))`. In production, if stderr is not captured, error context is lost. Also, no external alerting mechanism.

**Recommendation:** Add webhook/PagerDuty integration for error-level logs. Consider structured logging to a service (e.g., Datadog, Sentry).

---

## ℹ️ Informational

### INFO-01: Keypair Loaded from Plaintext JSON File

**File:** `cranker/config.ts`  
**Details:** `loadKeypair` reads a JSON file containing the secret key. If the server is compromised, the key is trivially extractable. This is standard for Solana bots but worth noting.

**Recommendation:** Consider HSM, AWS KMS, or at minimum encrypted-at-rest with a passphrase.

---

### INFO-02: No Health Check Endpoint

**Details:** The cranker has no HTTP endpoint for monitoring. If it silently hangs (e.g., stuck in a 60-second pause), external monitors can't detect it.

**Recommendation:** Add a simple HTTP health endpoint that reports loop status and last successful tick timestamps.

---

### INFO-03: `updateAmm` Is Permissionless

**File:** `sdk/src/client.ts`  
**Details:** The `updateAmm` instruction only requires a `caller` signer — anyone can call it. This is by design (permissionless peg updates) but means an attacker could spam peg updates to force the AMM to track a manipulated oracle price faster than intended.

**Recommendation:** Ensure on-chain rate limiting on peg updates (e.g., max once per N slots).

---

## Attack Scenario Analysis

### Scenario 1: Oracle Manipulation via Single-Source Degradation

**Preconditions:** Birdeye API key not configured (or Birdeye returns an error).  
**Attack:**
1. Attacker manipulates Jupiter pool prices via flash loan (inflate/deflate a pool).
2. Cranker fetches from Jupiter only (single source, confidence = 0).
3. Manipulated price is fed on-chain.
4. Attacker has positions that benefit from the manipulation (e.g., shorts that get a lower oracle price to avoid liquidation, or longs that trigger take-profit at inflated price).

**Likelihood:** Medium — Jupiter v2 API aggregates across DEXes, but thin-liquidity tokens are vulnerable.  
**Impact:** High — direct financial loss.

### Scenario 2: Cranker SOL Drain via Liquidation Griefing

**Preconditions:** None.  
**Attack:**
1. Attacker opens positions on multiple markets, sitting just above the maintenance margin.
2. Price moves slightly — positions flicker between liquidatable and safe.
3. Cranker detects them as liquidatable (off-chain calculation may differ from on-chain).
4. Cranker submits liquidation TXs — most fail because on-chain check disagrees or position was modified.
5. Each failed TX costs ~5,000 lamports. At 2-second intervals with 100 flickering positions, that's ~250,000 lamports/second = ~0.9 SOL/hour.

**Likelihood:** Medium  
**Impact:** Medium — cranker eventually runs out of SOL and stops functioning.

### Scenario 3: DoS via Trigger Order Flooding

**Preconditions:** Low cost to create trigger orders.  
**Attack:**
1. Attacker creates 10,000 trigger orders with trigger prices far from current market (never triggered).
2. Every tick (1 second), the cranker fetches all 10,000 orders, deserializes them, and checks each.
3. RPC node may rate-limit `getProgramAccounts` calls.
4. If multiple markets are flooded, cranker becomes unresponsive.

**Likelihood:** Medium (depends on on-chain order creation costs)  
**Impact:** High — all cranker functions halt during DoS.

### Scenario 4: Compromised Cranker Key — Oracle Walk Attack

**Preconditions:** Attacker obtains cranker keypair.  
**Attack:**
1. Attacker submits oracle updates, moving price 30% each time (within `maxPriceChangeBps`).
2. Wait for on-chain cooldown (if any), repeat.
3. After 5 updates: price is at ~3.7x original (1.3^5).
4. All shorts are liquidated. Attacker profits from their own long positions.

**Likelihood:** Low (requires key compromise)  
**Impact:** Critical — total protocol loss.

---

## Summary Table

| ID | Severity | Title | Exploitable? |
|---|---|---|---|
| CRIT-01 | 🔴 Critical | Oracle averaging with 2 sources enables manipulation | Yes |
| CRIT-02 | 🔴 Critical | No staleness check on price sources | Yes |
| HIGH-01 | 🟠 High | Unbounded fetchAll enables memory exhaustion | Yes |
| HIGH-02 | 🟠 High | Margin calculation diverges from on-chain | Yes |
| HIGH-03 | 🟠 High | Race condition in liquidation flow | Yes |
| HIGH-04 | 🟠 High | Compromised key enables oracle walk attack | Conditional |
| MED-01 | 🟡 Medium | No max divergence check between sources | Yes |
| MED-02 | 🟡 Medium | maxTxPerMinute never enforced | Yes |
| MED-03 | 🟡 Medium | Expired orders amplify DoS | Yes |
| MED-04 | 🟡 Medium | Float precision loss in price scaling | Edge case |
| MED-05 | 🟡 Medium | Static market list requires restart | Operational |
| LOW-01 | 🟢 Low | Fixed shutdown timer | Minor |
| LOW-02 | 🟢 Low | Token account cache never invalidated | Minor |
| LOW-03 | 🟢 Low | No external alerting | Operational |
| INFO-01 | ℹ️ Info | Plaintext keypair file | Standard |
| INFO-02 | ℹ️ Info | No health check endpoint | Operational |
| INFO-03 | ℹ️ Info | Permissionless updateAmm | By design |

---

## Recommended Priority Order

1. **CRIT-01 + MED-01**: Add confidence threshold + max divergence check + require ≥2 sources
2. **CRIT-02**: Implement proper staleness detection
3. **HIGH-01 + MED-03**: Add pagination/limits to fetchAll calls
4. **HIGH-02**: Align margin calculation with on-chain logic
5. **HIGH-03**: Add pre-submission position re-fetch or use Jito bundles
6. **MED-02**: Implement shared TX rate limiter
7. **HIGH-04**: On-chain cumulative drift protection + monitoring
8. **MED-04**: Use safe integer conversion for prices
9. **MED-05**: Periodic market list refresh
10. Everything else

---

*End of Round 1 Red Team Report*
