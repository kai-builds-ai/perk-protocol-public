# PerkOracle Cranker — Apex Security Audit

**Auditor:** Kai (Apex-level automated audit)
**Date:** 2026-03-24
**Scope:** Off-chain oracle cranker (`oracle-cranker.ts`), SDK client (`client.ts`), on-chain update instruction (`update_perk_oracle.rs`), oracle reader (`oracle.rs`), and spec (`PERK-ORACLE-SPEC.md`).

---

## Executive Summary

The PerkOracle cranker is a well-structured off-chain price aggregation service with multiple layers of defense-in-depth. The on-chain validation is sound, with proper authority checks, staleness enforcement, rate limiting, and a confidence band guard in the reader. However, several issues exist — primarily around the **degraded security posture when only 2 of 3 price sources are active** (Raydium is currently a stub), a **mismatch between the cranker's 10% deviation tolerance and the on-chain 2% confidence band**, and **missing circuit-breaker logic** for gradual price manipulation.

### Severity Summary

| Severity | Count | IDs |
|----------|-------|-----|
| 🔴 High | 2 | H-01, H-02 |
| 🟡 Medium | 3 | M-01, M-02, M-03 |
| 🟢 Low | 4 | L-01, L-02, L-03, L-04 |
| ℹ️ Info | 3 | I-01, I-02, I-03 |

---

## Findings

### 🔴 H-01: Two-Source Degradation — Median Becomes Average, Outlier Rejection Ineffective

**File:** `oracle-cranker.ts` — `aggregatePrice()`, `fetchRaydiumPrices()` (stub)

**Description:**
The Raydium on-chain price source is currently a stub returning an empty map. This means only Jupiter and Birdeye are active. With exactly 2 sources:

1. **The median of 2 values is their arithmetic mean** — `computeMedian([a, b])` returns `(a + b) / 2`. There is no "middle value" to anchor to. The median's manipulation-resistance property (tolerating up to ⌊n/2⌋ - 1 corrupted sources) requires n ≥ 3.

2. **Outlier rejection cannot eliminate either source.** With 2 sources, the median IS the average of both. If both are within 10% of that average, both pass. An attacker compromising one API can shift the median by up to **~5%** (half the deviation threshold) on every tick.

3. **The spec promises "Attacker must compromise 2/3 simultaneously"** — this is currently false. With 2 sources, compromising 1 source gives meaningful price control.

**Impact:** An attacker who compromises a single API endpoint (Jupiter or Birdeye) can systematically shift the oracle price by up to ~5% per tick. On a leveraged perpetuals platform, a 5% price shift at 10x leverage = 50% PnL manipulation. This enables targeted liquidations and position exploitation.

**Recommendation:**
- **Immediately** implement the Raydium on-chain source or add a third independent source (e.g., Orca TWAP, Raydium CLMM).
- Set `minSources: 3` once the third source is live.
- Until then, reduce `maxSourceDeviationPct` to `0.02` (2%) to align with the on-chain confidence band and limit single-source manipulation to ~1%.
- Consider adding a "2-source mode" with tighter constraints (e.g., both sources must agree within 1%).

---

### 🔴 H-02: Deviation/Confidence Mismatch — Cranker Allows 10% Spread, On-Chain Rejects >2%

**File:** `oracle-cranker.ts` — `aggregatePrice()`, `oracle.rs` — `read_perk_oracle_price()`

**Description:**
The cranker's `maxSourceDeviationPct` defaults to `0.10` (10%). It computes confidence as `maxPrice - minPrice` across accepted sources. The on-chain reader enforces `confidence <= price * 200 / 10000` (2% of price).

This means:
- If Jupiter says $100 and Birdeye says $104 (4% spread), the cranker accepts both, computes confidence = $4, and posts it on-chain.
- The `update_perk_oracle` instruction **succeeds** (it does not validate confidence).
- But any instruction that **reads** the oracle (trades, liquidations, etc.) **fails** because $4 > $100 * 0.02 = $2.

**Impact:**
1. **Wasted gas:** The cranker spends SOL posting prices that can never be consumed. In volatile markets where sources diverge 2-10%, this creates a sustained period where the oracle is effectively dead (price written but unreadable).
2. **Silent failure:** The cranker logs "Posted price" and reports success. There is no feedback that the price is unusable. Operators believe the oracle is healthy when it is not.
3. **Effective staleness:** If sources stay 2-10% apart for longer than `max_staleness_seconds`, the last *usable* price goes stale and all trading halts — even though the cranker is actively posting.

**Recommendation:**
- Align the cranker's `maxSourceDeviationPct` with the on-chain confidence band: set default to `0.02` (2%).
- Add a pre-flight check in the cranker: reject aggregated prices where `confidence > price * 0.02` before posting on-chain.
- Add monitoring/alerting when computed confidence exceeds the on-chain band.

---

### 🟡 M-01: No Price Change Circuit Breaker — Gradual Walk Attack

**File:** `oracle-cranker.ts` — `_tickInner()`

**Description:**
The cranker has no memory of previously posted prices. Each tick is fully independent. An attacker who controls one API source (with 2-source mode) can shift the price by up to ~5% each tick (every 3 seconds). Over 10 ticks (30 seconds), the price could be walked ~50% from its true value — all while staying within the per-tick deviation threshold.

The on-chain instruction also has no price banding (explicitly by design per the spec: "memecoins need to move freely"). While this is reasonable for legitimate volatility, it provides no defense against a compromised source gradually walking the price.

**Impact:** Systematic price manipulation over multiple ticks, enabling targeted liquidations.

**Recommendation:**
- Add cranker-side rate-of-change monitoring: track the last N posted prices and alert/halt if the cumulative change over a rolling window exceeds a configurable threshold (e.g., >20% over 60 seconds).
- This preserves memecoin volatility support (genuine 50% pumps happen over minutes, not seconds) while catching source manipulation.
- Consider using the on-chain EMA as a sanity anchor — if the new price deviates significantly from the EMA, require extra source agreement.

---

### 🟡 M-02: No Response Schema Validation — Malformed API Responses Could Cause Unexpected Behavior

**File:** `oracle-cranker.ts` — `fetchJupiterPrices()`, `fetchBirdeyePrices()`

**Description:**
API responses are cast to expected types via `as { data: ... }` with no runtime validation. A compromised or buggy API could return unexpected shapes:

- Jupiter: `entry.price` is typed as `string` but `parseFloat` handles most cases. However, `parseFloat("Infinity")` returns `Infinity`, which passes `isFinite()` — wait, no, `isFinite(Infinity) === false`. ✅ That's handled.
- Birdeye: `entry.value` is consumed directly as `number`. If the API returns a string `"NaN"` or an object, JavaScript type coercion could produce unexpected results (though `isFinite` guards against NaN/Infinity).
- Neither fetcher validates that `json.data` exists or is an object. If the API returns `{ data: null }` or `{}`, the code accesses `json.data?.[key]` which safely returns `undefined`. ✅

**Residual risk is low** due to the `isFinite` and `> 0` guards, but defense-in-depth argues for explicit validation.

**Impact:** Low probability, but a specially crafted API response could potentially bypass the numeric guards in an unforeseen way.

**Recommendation:**
- Add explicit runtime type checks (e.g., `typeof price === 'number'` for Birdeye, `typeof entry.price === 'string'` for Jupiter) before processing.
- Consider using a lightweight schema validator (zod, etc.) for API responses.

---

### 🟡 M-03: Spec Drift — `PerkOraclePrice.price` Type Mismatch

**File:** `PERK-ORACLE-SPEC.md` vs `state/perk_oracle.rs`

**Description:**
The spec declares `price: i64` (signed) and `ema_price: i64` (signed), but the on-chain struct uses `price: u64` and `ema_price: u64` (unsigned). The unsigned types are actually **better** (impossible to represent negative prices), but the spec is misleading.

The `update_perk_oracle` instruction takes `price: u64` in its params, which means the cranker's `new BN(scaledPrice)` (where `scaledPrice` is always positive due to upstream filters) is correct. But if anyone reads the spec and writes an alternative client expecting `i64`, they could introduce sign-extension bugs.

**Impact:** Documentation/implementation divergence could cause bugs in future integrations.

**Recommendation:** Update `PERK-ORACLE-SPEC.md` to reflect the actual `u64` types.

---

### 🟢 L-01: `Math.round()` Precision for High-Value Assets Near MAX_ORACLE_PRICE

**File:** `oracle-cranker.ts` — `_tickInner()`

**Description:**
`Math.round(result.price * PRICE_SCALE)` uses JavaScript floating-point arithmetic. For prices up to ~$1M/token (the MAX_ORACLE_PRICE ceiling = 1e12 scaled), the multiplication `1_000_000 * 1_000_000 = 1e12` is within `Number.MAX_SAFE_INTEGER` (2^53 ≈ 9e15), so integer precision is preserved.

However, for fractional sub-cent prices (memecoins at $0.000001), the scaled value is `1`, losing sub-unit precision. This is inherent to the 6-decimal scaling and not a bug per se, but operators should be aware.

**Impact:** Negligible for realistic price ranges. Prices below $0.0000005 would round to 0 and be rejected by on-chain `price > 0` check. ✅

**Recommendation:** Document the minimum representable price ($0.000001) in the spec. Consider warning operators if a token's price approaches this floor.

---

### 🟢 L-02: `new BN()` from Number — Safe but Fragile

**File:** `oracle-cranker.ts` — `_tickInner()`

**Description:**
`new BN(scaledPrice)` and `new BN(scaledConfidence)` construct BN from JavaScript numbers. The `@coral-xyz/anchor` BN (bn.js) constructor accepts numbers but truncates to 53-bit precision. As analyzed in L-01, the max value is ~1e12, well within safe range.

However, if `Math.round()` returns `-0` (possible for very small negative floats, though upstream filters prevent this), `new BN(-0)` behaves as `new BN(0)`, which would be rejected on-chain. ✅

**Impact:** Currently safe due to upstream guards. Fragile if guards are loosened.

**Recommendation:** Use string conversion for robustness: `new BN(scaledPrice.toString())` or `new BN(String(scaledPrice))`.

---

### 🟢 L-03: `tickInProgress` Guard Is Effective but Non-Atomic

**File:** `oracle-cranker.ts` — `tick()`

**Description:**
The `tickInProgress` boolean prevents re-entrant ticks. Since Node.js is single-threaded, the check-and-set (`if (!this.tickInProgress) return; this.tickInProgress = true;`) is atomic within the synchronous portion. The `try/finally` ensures the flag is always cleared. This is correct for single-process operation.

**Impact:** No issue in normal operation. If the cranker were ever run in a multi-threaded context (e.g., worker threads), this would be a race condition.

**Recommendation:** Current implementation is fine. Document that the cranker must run single-threaded.

---

### 🟢 L-04: Per-Source Confidence Is Always 0

**File:** `oracle-cranker.ts` — `fetchJupiterPrices()`, `fetchBirdeyePrices()`

**Description:**
Both fetchers set `confidence: 0` in their `PriceSource` objects. The per-source confidence is never used in `aggregatePrice()` — confidence is derived purely from cross-source spread. This means per-source uncertainty (e.g., thin order book on Jupiter) is invisible to the aggregation.

**Impact:** Low — the cross-source confidence metric is a reasonable proxy. But if both sources get their price from the same underlying thin pool, both could be simultaneously wrong without high cross-source spread.

**Recommendation:** Consider incorporating Jupiter's reported liquidity or Birdeye's volume data into per-source confidence for future robustness.

---

### ℹ️ I-01: API Failure Handling Is Graceful

**File:** `oracle-cranker.ts` — `_tickInner()`

**Observation:** Each source fetch is wrapped in `.catch()` that logs the error and returns an empty map. If all sources fail, `aggregatePrice` returns null due to `minSources` check, and no update is posted. On-chain staleness eventually kicks in and halts trading. This is correct fail-closed behavior. ✅

---

### ℹ️ I-02: On-Chain Validation Is Sound

**File:** `update_perk_oracle.rs`, `oracle.rs`

**Observation:** The on-chain checks are comprehensive and correctly ordered:
- Authority (`has_one = authority`) ✅
- Not frozen ✅
- Price > 0 and <= MAX_ORACLE_PRICE ✅
- Min sources met ✅
- Rate limit (slot-based) ✅
- Gap attack prevention (2x staleness) ✅
- Reader-side confidence band (2%) ✅
- Staleness on read ✅
- All arithmetic uses `checked_*` operations ✅

The EMA update is correct: `(price + 9 * old_ema) / 10` is a standard α=0.1 EMA. First-update initialization to the raw price is correct.

---

### ℹ️ I-03: Zero/Negative Price Defense-in-Depth

**Observation:** There are **four** independent layers preventing a zero or negative price from reaching on-chain state:
1. Per-source: `isFinite(price) && price > 0` ✅
2. Aggregation: `valid.filter(s => isFinite(s.price) && s.price > 0)` ✅
3. Scaling: `Math.round(0 * 1e6) = 0`, and `new BN(0)` would be posted, but:
4. On-chain: `require!(params.price > 0)` ✅

Negative prices are impossible because all source prices are positive floats, the aggregation preserves positivity, `Math.round` of a positive produces non-negative, and unsigned `u64` cannot be negative.

---

## Summary of Recommendations (Priority Order)

| Priority | Action | Addresses |
|----------|--------|-----------|
| **P0** | Implement Raydium (or third) price source to restore 3-source median security | H-01 |
| **P0** | Reduce `maxSourceDeviationPct` from 10% to 2% to align with on-chain confidence band | H-02 |
| **P1** | Add cranker-side pre-flight confidence check: reject if `confidence > price * 0.02` | H-02 |
| **P1** | Add price rate-of-change circuit breaker in the cranker | M-01 |
| **P2** | Add runtime schema validation for API responses | M-02 |
| **P2** | Update spec to reflect `u64` types (not `i64`) | M-03 |
| **P3** | Use `new BN(scaledPrice.toString())` for safety | L-02 |
| **P3** | Document minimum representable price ($0.000001) | L-01 |

---

## Conclusion

The PerkOracle system has a **solid on-chain security model** with comprehensive validation, fail-closed behavior, and proper defense-in-depth for zero/negative/stale prices. The cranker code is clean and well-structured.

The primary risk is the **current 2-source operational reality** (H-01), which degrades the median-based aggregation from Byzantine-fault-tolerant to single-point-of-failure. Combined with the **10% vs 2% deviation mismatch** (H-02), there is a window where a single compromised API source can either manipulate prices by ~5% or cause silent oracle unavailability.

**With the Raydium source implemented and `maxSourceDeviationPct` reduced to 2%, the system's security properties would be significantly strengthened.**

---

*End of audit report.*
