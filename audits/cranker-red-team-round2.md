# Cranker Red Team — Round 2

**Date:** 2026-03-25  
**Auditor:** Kai (subagent)  
**Scope:** All cranker fixes from Round 1 — adversarial analysis  
**Verdict:** 3 critical, 3 medium, 2 low findings  

---

## 1. Rate Limiter Bypass — canSend()/record() Desynchronization

**Severity: MEDIUM**  
**File:** `rate-limiter.ts`, all loop files

### Attack
The rate limiter has a TOCTOU (time-of-check/time-of-use) gap. Every loop does:

```ts
if (limiter && !limiter.canSend()) { ... skip ... }
const sig = await client.updatePerkOracle(...);  // <-- TX could fail here
if (limiter) limiter.record();  // <-- never reached if TX throws
```

**Two problems:**

1. **Under-counting on TX failure:** If `client.updatePerkOracle()` throws, `record()` is never called. The limiter thinks a slot is free, but the RPC already received (and possibly processed) the TX. If Solana accepted the TX but the confirmation timed out, we've sent a TX that isn't rate-limited. Over many failures, the effective rate can exceed `maxTxPerMinute`.

2. **Over-counting race between loops:** All 5 loops share the same `TxRateLimiter` instance. Since Node.js is single-threaded, there's no true race condition on the `canSend()` + `record()` pair within a single tick. BUT — `canSend()` mutates `this.timestamps` (filters stale entries), and the `remaining` getter also mutates it. If any code path reads `remaining` between another loop's `canSend()` and `record()`, the count is temporarily wrong. Not exploitable in current code, but fragile.

### Recommendation
- Call `record()` BEFORE sending the TX (optimistic recording). If the TX fails, optionally un-record. This is safer for a financial system — over-throttling is better than under-throttling.
- Or: wrap `canSend()` + `record()` into a single `tryAcquire(): boolean` method that atomically checks and records.

---

## 2. Market Refresh Race Condition — Array Mutation Mid-Iteration

**Severity: CRITICAL**  
**File:** `cranker.ts` lines 98–105

### Attack
The market refresh does:

```ts
activeMarkets.length = 0;          // ← array is now empty
activeMarkets.push(...freshActive); // ← array is refilled
```

This is **not atomic**. Between `.length = 0` and `.push(...)`, any loop that's currently doing `for (const { address, account } of markets)` will see an empty array (or partially filled array) because:

- Node.js is single-threaded BUT `await` yields the event loop.
- Each loop `await`s between market iterations (e.g., `await client.fetchMarketByAddress(address)`).
- The `setInterval` callback fires during these `await` points.
- A `for...of` loop on an array creates an iterator that reads `.length` and indexes dynamically.

**Concrete scenario:**
1. Liquidation loop is at market index 2 of 5, about to `await client.fetchMarketByAddress(markets[3])`.
2. The `await` yields to the event loop.
3. `setInterval` fires, sets `activeMarkets.length = 0`.
4. The `await` from step 1 resolves, loop continues.
5. `for...of` checks `markets.length` → 0, loop exits immediately.
6. Markets 3 and 4 are **never scanned for liquidations this tick**.

If the `push()` happens to execute between the `length = 0` and the loop's next index check, the loop could also skip to a different market entirely (array reindexed).

### Worst case
A market with positions needing liquidation is consistently skipped during the ~1ms window of the refresh, causing delayed liquidations.

### Recommendation
Replace in-place mutation with atomic swap:
```ts
const fresh = await client.fetchAllMarkets();
const freshActive = fresh.filter((m) => m.account.active);
// Atomic swap: splice replaces entire contents in one operation
activeMarkets.splice(0, activeMarkets.length, ...freshActive);
```
Even `splice` isn't truly atomic for `for...of` iterators though. The real fix is to use a wrapper object:
```ts
const marketRef = { current: activeMarkets };
// In loops: for (const m of marketRef.current) { ... }
// In refresh: marketRef.current = freshActive;  // atomic reference swap
```
This way, loops always iterate a stable snapshot. New markets appear next tick.

---

## 3. Dual-Source Price Oracle Compromise (Divergence = 0%, Price = Fake)

**Severity: CRITICAL**  
**File:** `feeds.ts`

### Attack
The divergence check only compares sources **against each other**, not against any ground truth. If an attacker compromises both Jupiter and Birdeye APIs (or performs a DNS hijack, BGP hijack, or MITM on both):

1. Jupiter returns $1,000 for SOL (real: $150)
2. Birdeye returns $1,000 for SOL
3. Divergence: 0% → passes check
4. Cranker pushes $1,000 to the on-chain oracle
5. All short positions get liquidated. Attacker profits.

The `minPriceSources: 2` check ensures both are present, but doesn't help if both are wrong.

### Why this matters
Jupiter and Birdeye both ultimately source prices from Solana DEXes. A single massive wash-trade on a low-liquidity market could move both feeds simultaneously. This isn't even a sophisticated attack — it's basic oracle manipulation.

### Mitigations not present in the code
- No comparison to on-chain oracle price (Pyth/Switchboard) as a third reference
- No maximum price-change-per-tick limit (circuit breaker for velocity)
- No TWAP — a single-point price is used directly
- No volume/liquidity sanity check

### Recommendation
Add a **price velocity check**: reject updates where the price moved more than X% from the last accepted price within Y seconds. This limits damage even if both sources are compromised:
```ts
const lastAccepted = lastAcceptedPrices.get(tokenMint);
if (lastAccepted) {
  const velocity = Math.abs(newPrice - lastAccepted.price) / lastAccepted.price;
  const elapsed = (Date.now() - lastAccepted.timestamp) / 1000;
  if (velocity > 0.10 && elapsed < 60) {
    throw new Error(`Price moved ${(velocity*100).toFixed(1)}% in ${elapsed.toFixed(0)}s — circuit breaker`);
  }
}
```
Also consider adding Pyth or Switchboard as a third source.

---

## 4. Frozen API Detection Bypass via Micro-Oscillation

**Severity: MEDIUM**  
**File:** `feeds.ts` lines 10, 130–142

### Attack
The frozen detection checks:
```ts
if (last && Math.abs(last.price - finalPriceUsd) < 0.0001) {
  last.sameCount++;
```

An attacker (or buggy API) that alternates between $100.0000 and $100.0001 will:
- Tick 1: $100.0000 → sameCount = 1
- Tick 2: $100.0001 → `abs(100.0000 - 100.0001) = 0.0001`, which is NOT `< 0.0001` → **resets** to `{ price: 100.0001, sameCount: 1 }`
- Tick 3: $100.0000 → reset again
- `sameCount` never reaches 5.

The API could be completely frozen at $100 (real price: $50) and never trigger the warning by toggling the least significant digit.

### Also noted
- The frozen detection only **logs a warning** — it doesn't reject the price. So even if `sameCount >= 5`, the stale price is still pushed to the oracle.
- The threshold of 5 consecutive fetches at 10s intervals = 50 seconds of stale data before even a warning.

### Recommendation
1. **Make it blocking, not just a warning** — after N consecutive same-price fetches, refuse to update the oracle.
2. **Track a rolling window** instead of consecutive count. If 8 out of 10 recent prices are within ε, flag it.
3. **Use absolute timestamps from the API**, not just the price value. If Jupiter's response always has the same internal timestamp, it's frozen regardless of the price value.

---

## 5. Margin Buffer — 5% Safety Factor Creates Bad Debt Window

**Severity: MEDIUM**  
**File:** `liquidation.ts` line 77

### Attack / Risk Analysis
```ts
const LIQUIDATION_SAFETY_FACTOR = 0.95;
// ...
if (marginRatio >= maintenanceRatio * LIQUIDATION_SAFETY_FACTOR) continue;
```

With `MAINTENANCE_MARGIN_BPS = 500` (5%), the effective threshold is:
- On-chain: liquidatable below 5.00% margin
- Cranker: only attempts liquidation below 5.00% × 0.95 = **4.75% margin**

**The gap: positions between 4.75% and 5.00% margin are ignored by the cranker.**

In a fast crash:
1. Position drops from 6% → 4.8% margin. Cranker skips it (above 4.75%).
2. Next tick (2 seconds later), position is at 3%. Cranker attempts liquidation.
3. But in that 2-second window, the position could have gone from 4.8% → negative (underwater).
4. Bad debt is created.

**Max bad debt from the buffer:**
- A position at exactly 4.75% margin has 0.25% less collateral buffer than the on-chain threshold.
- For a $1M notional position, that's $2,500 of delayed liquidation.
- In a 50% crash (e.g., LUNA-style), the position could go from 4.75% → -45.25% margin in one price update. That's $452,500 in bad debt that might have been caught at 5%.

**However:** The buffer exists for a good reason — to prevent failed TX spam from off-chain/on-chain price disagreement. This is a legitimate tradeoff.

### Recommendation
- Make the safety factor configurable via env var (e.g., `PERK_LIQUIDATION_SAFETY_FACTOR`), defaulting to 0.95.
- Consider a two-tier approach: attempt liquidation at 4.75%, but send with higher priority (more compute units / priority fee) for positions below 3%.
- Add monitoring/alerting when positions are in the 4.75%–5.00% zone.

---

## 6. Crash Recovery — Silent State Corruption

**Severity: LOW**  
**File:** All loop files (`runWithRestart` pattern)

### Attack / Risk
The restart pattern catches crashes at the `loop()` level:
```ts
while (state.running) {
  try {
    await loop();
  } catch (err) {
    log.error("... crashed, restarting in 10s", ...);
    await sleep(10_000);
  }
}
```

But what if a function **returns normally** but leaves state corrupted? Examples:

1. **Oracle loop:** `uniqueMints` is computed once at startup from the initial markets list. After a market refresh adds new markets with PerkOracle, the oracle loop never processes them because `uniqueMints` is a closed-over `Map` that's never updated.

2. **Funding loop:** If `client.crankFunding()` succeeds on-chain but the response parsing throws, `consecutiveFailures` increments even though the funding was cranked. After 10 such "phantom failures," the loop pauses 60 seconds unnecessarily.

3. **Token account cache:** `tokenAccountCache` and `executorAtaCache` are module-level Maps. If the cranker wallet's ATA is closed (e.g., by another program), the cache returns a stale address. All subsequent liquidation/trigger TXs fail with "account not found" until the process restarts.

### The oracle loop `uniqueMints` bug is actually the most dangerous:
```ts
// In startOracleLoop:
const perkOracleMarkets = markets.filter(...);
const uniqueMints = new Map<string, PublicKey>();
for (const m of perkOracleMarkets) { ... }
```
`markets` is the shared mutable array. `perkOracleMarkets` is a **snapshot** taken at loop start. `uniqueMints` is derived from that snapshot. When new PerkOracle markets are added via the 5-minute refresh, the oracle loop **will never update their prices**. Those markets will have stale/zero oracle prices, potentially blocking liquidations and trigger orders.

### Recommendation
- Re-derive `perkOracleMarkets` and `uniqueMints` at the start of each `tick()`, not once at loop creation.
- Add cache invalidation (TTL or size limit) for token account caches.
- Consider a health check that verifies loop iteration counts are progressing.

---

## 7. Safe Price Scaling — Edge Cases

**Severity: LOW**  
**File:** `feeds.ts` (`safeScalePrice`)

### Analysis
```ts
function safeScalePrice(priceUsd: number): BN {
  const scaled = Math.round(priceUsd * PRICE_SCALE);
  if (scaled <= 0) { throw ... }
  if (scaled > Number.MAX_SAFE_INTEGER) { throw ... }
  return new BN(scaled);
}
```

**What it catches:**
- `Math.round(0.0000004 * 1_000_000) = 0` → caught by `scaled <= 0` ✅
- Negative prices → caught by `scaled <= 0` ✅ (if price is negative enough to round to ≤ 0)
- Very large prices → caught by MAX_SAFE_INTEGER check ✅

**What it misses:**

1. **Small negative prices:** If an API bug returns `-0.001`, then `Math.round(-0.001 * 1_000_000) = -1000`. This is `<= 0` → caught. ✅ Actually fine.

2. **NaN from API:** If `priceUsd` is `NaN`, then `Math.round(NaN * 1_000_000) = NaN`. `NaN <= 0` is `false`. `NaN > MAX_SAFE_INTEGER` is `false`. **NaN passes both checks!** `new BN(NaN)` creates a BN with value 0. This bypasses the zero check and pushes a zero price to the oracle.

3. **Infinity:** `Math.round(Infinity * 1_000_000) = Infinity`. `Infinity <= 0` is `false`. `Infinity > MAX_SAFE_INTEGER` is `true` → caught. ✅

### The NaN path:
```
API returns undefined → parseFloat(undefined) → NaN
→ fetchJupiterPrice returns { price: NaN }
→ !isFinite(NaN) → true → returns null  ← CAUGHT in fetch function
```
Actually the individual fetch functions check `isFinite()`, so NaN is caught there. But if someone adds a third source that doesn't check `isFinite()`, `safeScalePrice` won't catch it.

### Recommendation
Add an explicit `isFinite()` check in `safeScalePrice`:
```ts
if (!isFinite(priceUsd) || !isFinite(scaled) || scaled <= 0) {
  throw new Error(...);
}
```
Belt-and-suspenders. Cheap insurance.

---

## 8. fetchAll Cap at 5000 — Random Truncation of Critical Positions

**Severity: CRITICAL**  
**File:** `liquidation.ts` lines 79–84, `triggers.ts` lines 101–106

### Attack
```ts
if (allPositions.length > MAX_ACCOUNTS) {
  log.warn(...);
  allPositions.length = MAX_ACCOUNTS;
}
```

Solana's `getProgramAccounts` returns accounts in **no guaranteed order**. The order depends on the RPC node's internal storage (typically account address order, which is effectively random relative to margin ratios).

**Scenario:**
1. Market has 8,000 positions.
2. 50 positions are critically underwater (margin < 1%) — these need immediate liquidation.
3. Those 50 happen to have account addresses that sort after index 5,000.
4. Cranker truncates to first 5,000. The 50 critical positions are silently dropped.
5. Bad debt accumulates.

**This is not hypothetical** — for a market with thousands of positions, the probability that ALL critical positions fall within the first 5,000 (by account address order) decreases with market size.

### Also
The truncation method `allPositions.length = MAX_ACCOUNTS` is a silent mutation. The subsequent `for` loop processes 5,000 positions with no indication that critical ones were dropped.

### For trigger orders
Same issue — if a user's stop-loss order is beyond index 5,000, it simply won't execute. The user has no way to know their order is being ignored.

### Recommendation
**Option A (preferred):** Fetch all accounts but process incrementally using `getProgramAccounts` with `dataSlice` to fetch only the margin-relevant fields first, sort by margin ratio, then fetch full data for the most critical positions:
```ts
// Pseudo-code
const summaries = await fetchPositionSummaries(market); // light fetch: just collateral, baseSize, entry
summaries.sort((a, b) => a.marginRatio - b.marginRatio); // most endangered first
const toProcess = summaries.slice(0, MAX_ACCOUNTS);
```

**Option B:** Use pagination via the `before`/`after` cursors in `getProgramAccounts` dataSlice to ensure full coverage across multiple ticks.

**Option C (minimum):** At least log the total count prominently and emit a metric. If `allPositions.length > MAX_ACCOUNTS`, this should be an alert, not just a warning.

---

## Summary Table

| # | Finding | Severity | Exploitable? | Fix Complexity |
|---|---------|----------|-------------|----------------|
| 1 | Rate limiter TOCTOU (under-count on TX failure) | Medium | Indirectly (causes over-sending) | Low — `tryAcquire()` method |
| 2 | Market refresh race — loops see empty array | Critical | Yes (missed liquidations) | Low — reference swap |
| 3 | Dual-source oracle manipulation (0% divergence, fake price) | Critical | Yes (requires compromising 2 APIs) | Medium — add velocity/TWAP |
| 4 | Frozen API bypass via micro-oscillation | Medium | Yes (trivial for malicious API) | Low — rolling window + blocking |
| 5 | 5% margin buffer → missed liquidations in fast crashes | Medium | Indirectly (economic loss) | Low — configurable + two-tier |
| 6 | Oracle loop never picks up new PerkOracle markets | Low* | Yes (stale oracle prices) | Low — re-derive each tick |
| 7 | NaN passes safeScalePrice (defense-in-depth gap) | Low | No (caught upstream currently) | Trivial — add isFinite() |
| 8 | Random truncation of positions at 5000 cap | Critical | Yes (missed liquidations) | Medium — sort by margin ratio |

*Finding 6 is marked Low because it requires new markets to be added post-startup, but upgrading to Medium is justified since market refresh was specifically added as Fix 1.

---

## Top 3 Priorities

1. **Fix the market refresh race** (#2) — easiest to fix, highest likelihood of occurring. Use reference swap pattern.
2. **Fix the fetchAll truncation** (#8) — sort by margin ratio before truncating. Critical positions must be processed first.
3. **Fix the oracle loop stale uniqueMints** (#6) — re-derive `perkOracleMarkets` and `uniqueMints` inside `tick()`, not at loop startup. Without this, Fix 1 (market refresh) is partially broken for oracle updates.
