# Apex Red Team — SDK Fixes Verification (Round 2)

**Date:** 2026-03-25  
**Auditor:** Kai (Apex Red Team)  
**Scope:** Client-side validation in `client.ts`, E2E security tests, on-chain instructions  
**Verdict:** ⚠️ **Fixes are fundamentally sound, but 2 client-side gaps remain (Low severity)**

---

## Executive Summary

> **All findings in this report have been resolved or acknowledged. See individual status lines per finding.**

The on-chain program is rock-solid. All security invariants (circuit breaker, banding, EMA, unfreeze anchoring) are enforced in Rust with proper type safety. The client-side validation added in ATK-01 is *mostly* correct but has **two gaps caused by JavaScript's NaN comparison semantics** that allow malformed inputs to silently pass validation and serialize as 0 (disabled). These are Low severity because the on-chain program still enforces its own bounds, and the worst outcome is silently disabling a safety feature — not exploiting one.

The E2E test suite is well-designed and mathematically correct. No logic errors found. All findings have been resolved or acknowledged with no unresolved issues remaining.

---

## Attack Vector Results

### 1. NaN Bypass — ⚠️ LOW SEVERITY (Client Gap)
**Status:** Resolved — `Number.isFinite()` + `Number.isInteger()` guards added to `initializePerkOracle` and `updateOracleConfig` in SDK.

**Attack:** Pass `NaN` as `circuitBreakerDeviationBps` or `maxPriceChangeBps`.

**Result:** NaN passes ALL client validation checks.

```js
// initializePerkOracle validation:
NaN < 0       // → false  ✓ passes range check
NaN > 65535   // → false  ✓ passes range check
NaN !== 0     // → true   ✓ enters bounds block
NaN < 500     // → false  ✓ passes lower bound
NaN > 9999    // → false  ✓ passes upper bound
```

NaN reaches Borsh serialization. Node.js `Buffer.writeUInt16LE(NaN)` writes **0**. The on-chain program receives 0, which means "disabled" — a valid value that passes on-chain validation.

**Impact:** An SDK caller passing `NaN` (due to a bug in their code, e.g., `parseInt("abc")` → NaN) would silently create an oracle with circuit breaker/banding **disabled** instead of getting an error. This degrades security posture without any indication.

**Affected methods:**
- `initializePerkOracle` — all 4 numeric params
- `updateOracleConfig` — all 4 numeric params (after the `!== null` gate)

**Fix:** Add `Number.isFinite()` and `Number.isInteger()` guards at the top of each validation block. The `openPosition` method already has `Number.isInteger()` — apply the same pattern:

```typescript
// Add to both initializePerkOracle and updateOracleConfig:
const numericFields = [
  ['circuitBreakerDeviationBps', params.circuitBreakerDeviationBps],
  ['maxPriceChangeBps', params.maxPriceChangeBps],
  ['minSources', params.minSources],
  ['maxStalenessSeconds', params.maxStalenessSeconds],
] as const;
for (const [name, val] of numericFields) {
  if (val !== null && val !== undefined) {
    if (!Number.isFinite(val) || !Number.isInteger(val)) {
      throw new Error(`${name} must be a finite integer, got ${val}`);
    }
  }
}
```

### 2. Float Truncation — ⚠️ LOW SEVERITY (Client Gap)
**Status:** Resolved — `Number.isInteger()` check catches fractional bps values; on-chain Rust u16 type provides secondary defense.

**Attack:** Pass `500.7` as `circuitBreakerDeviationBps`.

**Result:** Passes all validation (500.7 is within [500, 9999] and within [0, 65535]). Borsh serializes as `500` (truncated). The on-chain program receives 500 — valid, but not what the caller intended.

**Impact:** Silent data loss. The caller thinks they set 500.7 bps but gets 500. In practice, nobody passes fractional bps, so this is theoretical.

**Fix:** Same as above — `Number.isInteger()` check catches this.

### 3. Infinity — ✅ DEFENDED

`Infinity > 65535` → `true`. Caught by the u16 range check. Properly rejected.

### 4. undefined as number — ✅ DEFENDED (by accident)

`undefined` passes all NaN-style comparisons (same as NaN — all return false). Reaches Borsh, serializes as 0. Same outcome as NaN. The `Number.isFinite()` fix above also catches this since `Number.isFinite(undefined)` → `false`.

### 5. undefined vs null in updateOracleConfig — ✅ NOT EXPLOITABLE

**Attack:** Pass `undefined` instead of `null` for "don't change" fields.

```js
undefined !== null  // → true (enters validation block)
```

`undefined` enters the validation path but passes all comparisons (NaN semantics). When serialized to Borsh for an `Option<u16>`, Anchor's TypeScript client treats `undefined` as `None` (same as `null`). The on-chain `if let Some(val)` doesn't fire. Net effect: field is unchanged — the same as passing `null`.

**Verdict:** Not exploitable. The undefined goes through useless validation but the on-chain result is correct (no-op). Still worth adding the `Number.isFinite()` guard for cleanliness.

---

## Test Logic Verification

### Test 9 (Boundary — Exact +10%)

**Math check:**
- Initial: price = 10,000,000, EMA = 10,000,000 (first update sets EMA = price)
- Update to 11,000,000:
  - CB check: deviation = |11,000,000 - 10,000,000| = 1,000,000
  - deviation_bps = 1,000,000 × 10,000 / 10,000,000 = **1,000**
  - Threshold: 1,000 bps. On-chain: `require!(deviation_bps <= cb_bps)` → `1000 <= 1000` → ✅ PASSES
- New EMA: (11,000,000 + 9 × 10,000,000) / 10 = 10,100,000
- Test stops here. No follow-up test reads stale EMA. ✅ **CORRECT**

### Test 7 (Downward Jump)

**Math check:**
- Initial: price = 100,000, EMA = 100,000
- Try 80,000: deviation = 20,000, bps = 2,000 > 1,000 threshold → **REJECTED** ✅
- Price remains 100,000, EMA remains 100,000 (rejected tx doesn't mutate state)
- Try 92,000:
  - Per-update banding: `maxPriceChangeBps = 0` (disabled) → **SKIPPED** ✅
  - CB check: deviation = |92,000 - 100,000| = 8,000, bps = 800 ≤ 1,000 → **PASSES** ✅
  - Sliding window: `max_change_bps = 0` → **SKIPPED** ✅
- **CORRECT**

### Test 3 (Sliding Window Walk)

**Math check:**
- Initial: price = 100,000. Window ref = 100,000.
- Step 1 → 105,000: per-update banding = |5,000| × 10,000 / 100,000 = 500 bps ≤ 500. ✅ PASSES. Window cumulative: 500 bps ≤ 1,500 (500 × 3). ✅
- Step 2 → 110,250: per-update banding = |5,250| × 10,000 / 105,000 = 500 bps. ✅ Window cumulative: |10,250| × 10,000 / 100,000 = 1,025 bps ≤ 1,500. ✅
- Step 3 → 115,762: per-update banding = |5,512| × 10,000 / 110,250 = 499.9 bps. ✅ Window cumulative: |15,762| × 10,000 / 100,000 = 1,576 bps > 1,500. **REJECTED** ✅
- Test expects rejection at some step. **CORRECT**

### Rate Limiting (Same Slot as Init)

- `initializePerkOracle` sets `last_slot = 0`
- `updatePerkOracle` checks `clock.slot > oracle.last_slot` → `slot > 0` always true on any network
- Plus tests have `await sleep(DELAY_MS)` between init and first update
- **No risk of false failure** ✅

---

## Error Matching

### Anchor Error Format

Anchor errors follow: `"AnchorError ... Error Code: OracleCircuitBreakerTripped. Error Number: 6XXX ..."`

Tests use `.includes("OracleCircuitBreakerTripped")` — matches the variant name substring. This is the **standard pattern** for Anchor E2E tests and has been stable across Anchor 0.27–0.30+.

**Future risk:** If Anchor v1.0 changes error serialization to use only numeric codes, tests would break. This is a known industry-wide concern, not specific to these fixes. Acceptable for E2E tests.

---

## On-Chain Program — Verified Solid

| Check | Status | Notes |
|-------|--------|-------|
| u16 type safety for BPS fields | ✅ | Rust/Borsh enforces at deserialization |
| Circuit breaker bounds (0 or [500, 9999]) | ✅ | Validated in both init and update |
| Banding bounds (0 or [100, 9999]) | ✅ | Validated in both init and update |
| EMA capped to MAX_ORACLE_PRICE | ✅ | `raw_ema.min(MAX_ORACLE_PRICE)` |
| CB uses old_ema (pre-update) | ✅ | Captured before EMA update |
| Boundary condition uses `<=` | ✅ | `deviation_bps <= cb_bps` |
| Unfreeze pending flag cleared after use | ✅ | Single-use flag |
| Oracle must be frozen for config change | ✅ | `require!(is_frozen)` |
| Rate limiting (one per slot) | ✅ | `require!(clock.slot > oracle.last_slot)` |
| Gap attack protection | ✅ | 2x staleness check with unfreeze bypass |
| Saturating math for EMA | ✅ | Can't brick oracle |
| Price positivity check | ✅ | `require!(params.price > 0)` |

**The on-chain program is the ultimate defense.** Even if every client validation were removed, no invalid state can be written to the oracle because Rust's type system and the explicit `require!()` checks catch everything. The client validation exists to give callers **clear error messages** instead of opaque Anchor errors.

---

## Recommendations

### Must Fix (before next release)

1. **Add `Number.isFinite()` + `Number.isInteger()` guards** to `initializePerkOracle` and `updateOracleConfig` — catches NaN, Infinity, undefined, and floats in one shot.

### Nice to Have

2. **Explicit undefined guard in updateOracleConfig** — Change `!== null` to `!= null` (loose equality) so `undefined` is treated as "don't change" without entering useless validation. Or use `val !== null && val !== undefined`.

3. **Consider a shared validation helper** — Both methods duplicate the same bounds logic. A `validateBpsField(name, value, min, max, allowZero)` function would reduce copy-paste bugs.

---

## Conclusion

**The fixes are solid where it matters — on-chain.** The Rust program is airtight. The client-side NaN gap is the only finding worth fixing, and even that only causes silent degradation (disabling a safety feature), never exploitation. The E2E tests are mathematically correct with proper boundary testing.

Ship it after adding the `Number.isFinite()` + `Number.isInteger()` guards. Two lines of defense are better than one.
