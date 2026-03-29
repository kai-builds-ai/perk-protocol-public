# Cranker Audit — Round 3 (Final Verification)

**Date:** 2026-03-25  
**Auditor:** Kai  
**Scope:** All R2 fix verification + new issue scan  
**Files reviewed:** cranker.ts, config.ts, feeds.ts, rate-limiter.ts, logger.ts, loops/{oracle,funding,liquidation,triggers,peg}.ts

---

## R2 Fix Verification

### 1. Atomic Market Refresh ✅ PASS

```ts
activeMarkets.splice(0, activeMarkets.length, ...freshActive);
```

**Verdict:** Correct. `Array.splice` is a single synchronous operation — it clears and refills the array with no intermediate empty state. Since JS is single-threaded and there is no `await` inside splice, no loop can observe a partially-updated array. All loops hold a reference to the same `activeMarkets` array, so they automatically see fresh data on their next iteration.

### 2. Oracle Loop Re-derives Markets Each Tick ✅ PASS

```ts
const perkOracleMarkets = markets.filter(m => m.account.oracleSource === OracleSource.PerkOracle);
const uniqueMints = new Map<string, PublicKey>();
for (const m of perkOracleMarkets) { ... }
```

**Verdict:** Correct. `filter()` creates a new array from the shared reference, so the derived `perkOracleMarkets` is an independent snapshot. The `Map`-based dedup is synchronous — no risk of mid-iteration mutation. Performance: filter + Map over a small array (<100 markets typical) is negligible at 10s intervals.

### 3. Liquidation Sort by Margin Ratio ✅ PASS

```ts
scored.sort((a, b) => a.ratio - b.ratio);
```

**Verdict:** Correct. Ascending sort — lowest margin ratio (most underwater) first. Then truncated to `MAX_ACCOUNTS` (5000).

**Edge case analysis:**
- `ratio = 0` (underwater) → sorts to front ✅
- `ratio = Infinity` (empty position) → sorts to end ✅
- `NaN` → **cannot occur**: `computeMarginRatio` returns only `Infinity`, `0`, or a finite positive number. No division by zero (guarded by `isZero()` checks), no NaN paths.

**Margin ratio math review:**
- `notional = |baseSize| * oraclePrice / PRICE_SCALE` ✅
- Long PnL: `currentValue - quoteEntryAmount` ✅
- Short PnL: `quoteEntryAmount - currentValue` ✅
- `equity = collateral + pnl` ✅
- `ratio = equity * BPS_DENOMINATOR / notional / BPS_DENOMINATOR` ✅
- `ratioScaled.toNumber()` is safe — practical range is 0–100 (mapped to 0–1,000,000 before final division), well within `MAX_SAFE_INTEGER`.

### 4. Rate Limiter TOCTOU — `record()` Before TX ✅ PASS (with caveat)

All 5 loops call `record()` before the async TX send:

| Loop | canSend → record gap | Verdict |
|------|---------------------|---------|
| oracle.ts | No await between | ✅ |
| funding.ts | No await between | ✅ |
| liquidation.ts | No await between | ✅ |
| peg.ts | No await between | ✅ |
| **triggers.ts** | **`await getOrCacheExecutorAta()` between canSend and record** | ⚠️ |

**Caveat (triggers.ts):** There is an `await` between `canSend()` and `record()`:
```ts
if (limiter && !limiter.canSend()) { ... break; }
const executorAta = await getOrCacheExecutorAta(...);  // ← yield point
if (limiter) limiter.record();
```
Another loop could interleave at this yield point and consume rate limit capacity. After the first call per collateral mint, the ATA is cached and the lookup is synchronous (`Promise.resolve`-like), but on the very first invocation it's a real async gap.

**Severity: LOW.** Only affects the first trigger execution per collateral mint per process lifetime. The conservative fix would be to move `record()` before the ATA lookup, or pre-cache ATAs at startup.

---

## R1 Fix Verification

### 5. Market Refresh Interval (5 min) ✅ PASS

300s is appropriate. Markets are created/deactivated rarely (governance actions). More frequent polling would waste RPC quota. Less frequent would delay discovery of new markets.

**Note:** The `setInterval` handle is never cleared on shutdown. Harmless — `process.exit(0)` fires 3s after shutdown signal.

### 6. Crash Recovery in All Loops ✅ PASS

All 5 loops implement identical `runWithRestart` pattern:
```ts
while (state.running) {
  try { await loop(); }
  catch (err) { log.error("...crashed, restarting in 10s"); await sleep(10_000); }
}
```
Verified in: oracle.ts ✅, funding.ts ✅, liquidation.ts ✅, triggers.ts ✅, peg.ts ✅

Additionally, all loops have per-iteration try/catch with consecutive failure counting and 60s pause after 10 failures.

### 7. Divergence Threshold Math (feeds.ts) ✅ PASS

```ts
const divergencePct = Math.abs(s[0].price - s[1].price) / Math.min(s[0].price, s[1].price);
```

Uses `min()` as denominator — maximizes the divergence percentage (conservative). Default threshold 5% is configurable via `PERK_MAX_DIVERGENCE_PCT`. Throws on breach rather than silently continuing.

### 8. Safe Price Scaling ✅ PASS

```ts
function safeScalePrice(priceUsd: number): BN {
  const scaled = Math.round(priceUsd * PRICE_SCALE);
  if (scaled <= 0) throw ...
  if (scaled > Number.MAX_SAFE_INTEGER) throw ...
  return new BN(scaled);
}
```

Bounds: rejects prices that round to ≤ 0 (too small) or exceed `MAX_SAFE_INTEGER` after scaling (too large). At `PRICE_SCALE = 1e6`, safe range is $0.000001 – $9,007,199,254. Covers all reasonable token prices.

### 9. Peg Formula ✅ PASS

```ts
markPrice = quoteReserve * pegMultiplier / baseReserve
```

Comment confirms on-chain `vamm::calculate_mark_price` does `quote * peg / base`. No K_SCALE division (correctly removed in R1). `pegMultiplier` is stored in `PRICE_SCALE`, so result is in `PRICE_SCALE`. Matches.

**Divergence calculation:**
```ts
const divergence = diff.muln(10000).div(oraclePrice).toNumber() / 10000;
```
Precision: 0.01% granularity. Threshold is 0.5%. Sufficient. No BN overflow risk (`muln(10000)` on a price diff is bounded).

### 10. Frozen API Detection ✅ PASS (with note)

Tracks consecutive identical prices per token. Warns at 5+ consecutive matches (using 0.0001 tolerance for float comparison).

**Note:** The detection **only warns** — it does not reject stale prices or throw. If both Jupiter and Birdeye freeze simultaneously (returning identical stale data), the cranker will continue posting stale oracle prices. See NEW-3 below.

---

## NEW Issues Found

### NEW-1: Dead Global `running` Flag — INFORMATIONAL

```ts
// cranker.ts
let running = true;
// ...
const shutdown = (): void => {
  running = false;  // ← set but never read
  for (const loop of loops) { loop.stop(); }
};
```

The global `running` flag is set to `false` on shutdown but no code reads it. Each loop has its own `state.running` flag toggled by `loop.stop()`. The global is dead code.

**Impact:** None. Just noise.

### NEW-2: Triggers TOCTOU on First ATA Lookup — LOW

(Covered in R2 Fix #4 above.) The `await getOrCacheExecutorAta()` between `canSend()` and `record()` in triggers.ts creates a small race window on first invocation per collateral mint.

**Recommendation:** Move `record()` before the ATA lookup, or pre-warm the ATA cache at startup.

### NEW-3: Frozen API Detection Is Warn-Only — LOW

feeds.ts detects when a price is unchanged for 5+ consecutive fetches but only logs a warning. It does not escalate (reject the price, increase confidence band, etc.). In a scenario where an upstream API returns cached/stale data, the cranker would continue posting potentially stale oracle prices.

**Recommendation:** Consider adding a configurable `maxStaleFetches` threshold (e.g., 20) that triggers a rejection/throw, forcing the oracle loop to skip the update until the price moves.

### NEW-4: Trigger Orders Not Priority-Sorted Before Truncation — LOW

When trigger orders exceed `MAX_TRIGGER_ACCOUNTS` (5000), the code truncates with `allOrders.length = MAX_TRIGGER_ACCOUNTS` — taking the first 5000 in arbitrary RPC return order. Unlike liquidation (which sorts by margin ratio), there's no urgency-based prioritization.

**Impact:** If a market has >5000 pending trigger orders, some triggered orders may be delayed arbitrarily.

**Recommendation:** For v1, this is acceptable — 5000 trigger orders per market is extreme. If needed later, sort by `|oraclePrice - triggerPrice| / triggerPrice` descending (most deeply triggered first).

### NEW-5: Funding Loop Skips Inactive Markets via Cached State — INFORMATIONAL

The funding, liquidation, and triggers loops iterate `markets` and check `account.active`. This `account` object comes from the last market refresh (via splice). Between refreshes (up to 5 min), a market deactivated on-chain would still be iterated.

**Impact:** Minimal. The on-chain instruction would reject operations on inactive markets with a program error, caught by the per-iteration try/catch.

---

## Summary

| ID | Issue | Severity | Status |
|----|-------|----------|--------|
| R2-1 | Atomic market refresh | — | ✅ Verified correct |
| R2-2 | Oracle re-derives each tick | — | ✅ Verified correct |
| R2-3 | Liquidation sort direction | — | ✅ Verified correct |
| R2-4 | Rate limiter TOCTOU | — | ✅ Verified (4/5 clean, triggers has minor gap) |
| R1-5 | Market refresh interval | — | ✅ Appropriate |
| R1-6 | Crash recovery | — | ✅ All 5 loops |
| R1-7 | Divergence math | — | ✅ Conservative |
| R1-8 | Safe price scaling | — | ✅ Bounds checked |
| R1-9 | Peg formula | — | ✅ Matches on-chain |
| R1-10 | Frozen API detection | — | ✅ Present (warn-only) |
| NEW-1 | Dead `running` global | INFORMATIONAL | Cleanup |
| NEW-2 | Triggers TOCTOU on first ATA | LOW | Minor race window |
| NEW-3 | Frozen API is warn-only | LOW | Consider escalation |
| NEW-4 | Trigger orders not sorted | LOW | Acceptable for v1 |
| NEW-5 | Cached active state between refreshes | INFORMATIONAL | On-chain rejects |

**Overall verdict:** All R1 and R2 fixes are correctly implemented. No high or critical issues found. The 5 new findings are all LOW/INFORMATIONAL — none are blockers. The cranker is ready for deployment.
