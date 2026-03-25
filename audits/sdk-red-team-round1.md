# SDK & E2E Security Red Team — Round 1

**Date:** 2026-03-25  
**Scope:** SDK types/client, E2E security tests, on-chain oracle instructions + constants  
**Severity scale:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 1 |
| HIGH     | 3 |
| MEDIUM   | 4 |
| LOW      | 3 |
| INFO     | 3 |

---

## CRITICAL

### C-01: Post-Unfreeze Banding Reference Is Zeroed Price — Always Skips Per-Update Check

**Location:** `update_perk_oracle.rs` lines 44-56, `freeze_perk_oracle.rs` line 50

When admin unfreezes, `oracle.price` is set to `0` (line 50 of freeze handler). The very first post-unfreeze update hits the banding check:

```rust
let reference_price = if oracle.price > 0 {
    oracle.price          // <— oracle.price is 0 after unfreeze!
} else {
    // Falls through to pre_freeze_price
    u64::from_le_bytes(pre_freeze_bytes)
};
```

This fallback to `pre_freeze_price` is correct **only if `pre_freeze_price` was stored before zeroing `oracle.price`**. The freeze handler stores it correctly (line 37 stores price, then line 50 zeros it). **However**, on the second post-unfreeze update, `oracle.price` will be the first post-unfreeze price (set at the end of handler, line 121: `oracle.price = params.price`). So per-update banding works normally from update #2 onward.

But there's a subtler issue: the `pre_freeze_price` is **never cleared**. If the oracle gets frozen and unfrozen a second time with `oracle.price == 0` (e.g., unfreeze → no updates → freeze → unfreeze), the stale pre-freeze price from the *first* freeze event is used as the banding reference. This could allow or reject prices based on an arbitrarily old reference.

**Impact:** A multi-freeze cycle without intervening updates could create a stale banding reference that doesn't reflect actual market conditions. A compromised admin could exploit this to bypass banding by engineering a specific freeze/unfreeze sequence.

**Recommendation:** Clear `pre_freeze_price` after the first successful post-unfreeze update (when `unfreeze_pending` is consumed), or re-store it on every freeze.

---

## HIGH

### H-01: `PerkOracleAccount` TS Type Missing All Security Config Fields

**Location:** `sdk/src/types.ts` → `PerkOracleAccount` interface

The TS interface only exposes the named Anchor account fields. All security-critical config stored in `_reserved[0..64]` is invisible to SDK consumers:

| Field | Offset | Type | Accessible from SDK? |
|-------|--------|------|---------------------|
| `unfreezePending` | 0 | u8 | ❌ |
| `maxPriceChangeBps` | 1-2 | u16 LE | ❌ |
| `preFreezePrice` | 3-10 | u64 LE | ❌ |
| `windowRefPrice` | 11-18 | u64 LE | ❌ |
| `windowRefSlot` | 19-26 | u64 LE | ❌ |
| `circuitBreakerDeviationBps` | 27-28 | u16 LE | ❌ |

**Impact:**
- SDK consumers cannot read oracle security configuration (banding limits, circuit breaker threshold)
- Cranker bots cannot inspect window state for debugging
- Test 5 verifies `minSources` and `maxStalenessSeconds` but **cannot verify** that `circuitBreakerDeviationBps` was updated to 2000 — the assertion is missing entirely
- Monitoring/dashboard tools built on the SDK are blind to security config

**Recommendation:** Add a `deserializeReserved()` helper or extend `PerkOracleAccount` with parsed reserved fields. At minimum:

```typescript
interface PerkOracleAccount {
  // ... existing fields ...
  _reserved: number[];  // raw bytes
  // Parsed security config (from _reserved)
  maxPriceChangeBps: number;
  circuitBreakerDeviationBps: number;
  windowRefPrice: BN;
  windowRefSlot: BN;
  preFreezePrice: BN;
  unfreezePending: boolean;
}
```

### H-02: SDK Constants Mismatch — `INSURANCE_EPOCH_CAP_BPS`

**Location:** `sdk/src/constants.ts` vs `programs/.../constants.rs`

| Constant | SDK (TS) | On-chain (Rust) |
|----------|----------|-----------------|
| `INSURANCE_EPOCH_CAP_BPS` | **5000** (50%) | **3000** (30%) |

The Rust comment says "reduced from 50% for better survivability under sustained attack." The SDK still has the old value.

**Impact:** Any SDK consumer using this constant for insurance calculations gets wrong results (overestimates payout cap by 67%).

**Recommendation:** Update `sdk/src/constants.ts` to `3000`.

### H-03: SDK Missing Oracle Security Constants

**Location:** `sdk/src/constants.ts`

The following on-chain constants are not mirrored in the SDK:

```
MIN_PRICE_CHANGE_BPS = 100       // Minimum banding when enabled
MAX_PRICE_CHANGE_BPS = 9999      // Maximum banding
MIN_CIRCUIT_BREAKER_BPS = 500    // Minimum CB when enabled
MAX_CIRCUIT_BREAKER_BPS = 9999   // Maximum CB
CIRCUIT_BREAKER_WINDOW_SLOTS = 50  // Window duration
WINDOW_BAND_MULTIPLIER = 3      // Window = 3x per-update band
```

**Impact:** SDK consumers calling `initializePerkOracle` or `updateOracleConfig` with invalid values (e.g., `circuitBreakerDeviationBps: 100`) get a confusing on-chain error instead of a clear client-side validation error. No way to compute valid ranges without reading Rust source.

**Recommendation:** Mirror these constants and add client-side validation in `initializePerkOracle()` and `updateOracleConfig()`.

---

## MEDIUM

### M-01: Test 5 Doesn't Verify Circuit Breaker Config Was Updated

**Location:** `e2e-security.test.ts` Test 5, ~line 295

After `updateOracleConfig({ circuitBreakerDeviationBps: 2000, ... })`, the test verifies:
```typescript
if (oracle.minSources !== 3) { throw ... }        // ✅ checked
if (oracle.maxStalenessSeconds !== 60) { throw ... } // ✅ checked
// circuitBreakerDeviationBps → NOT CHECKED ❌
```

The test claims to verify "All Fields" but only checks 2 of the 4 configurable fields. This is directly caused by H-01 (missing `_reserved` parsing in SDK types).

**Recommendation:** Add a helper to parse `_reserved` bytes and assert `circuitBreakerDeviationBps === 2000` and `maxPriceChangeBps === 500` (unchanged).

### M-02: No Test for Price Decrease Direction

**Location:** `e2e-security.test.ts` — all tests

Every banding/circuit breaker test walks price **upward**. No test verifies that downward moves are equally constrained. The on-chain code uses `abs(diff)` so it should be symmetric, but:

- If someone introduced a signed-vs-unsigned bug in the diff calculation, only downward tests would catch it
- The `if params.price > reference_price` branch is tested; the `else` branch (downward) is never exercised in the E2E suite

**Recommendation:** Add a test with 100_000 → 90_000 (−10% exceeds 5% band) → rejected, then 100_000 → 96_000 (−4%) → accepted.

### M-03: Test Error Matching Is Overly Broad

**Location:** `e2e-security.test.ts` — multiple tests

Test 3 catches errors with:
```typescript
err.message.includes("price")
```

This matches **any** error containing "price" — including unrelated errors like "Invalid price feed", "price must be positive", deserialization errors containing field names, etc. A test could pass for the wrong reason.

Test 4 catches:
```typescript
err.message.includes("circuit")
```

This would match "circuit" in any context, not just `OracleCircuitBreakerTripped`.

**Recommendation:** Match against the specific Anchor error code number (e.g., `6042` for `OracleCircuitBreakerTripped`) which is stable across versions, or at minimum use the full error name: `err.message.includes("OracleCircuitBreakerTripped")`.

### M-04: Test 3 Fragile Under Slow Devnet — Window Could Expire

**Location:** `e2e-security.test.ts` Test 3

The sliding window is 50 slots (`CIRCUIT_BREAKER_WINDOW_SLOTS`). The test makes 4 walk updates with `sleep(2000)` between each. At normal devnet speed (~400ms/slot), each sleep ≈ 5 slots, so the whole walk takes ~20 slots. Well within the 50-slot window.

But devnet can degrade to 1-2s/slot during congestion. If slots are 2s each, the `sleep(2000)` + tx confirmation (~2-4s) means each step takes ~4-6s = 2-3 slots. The walk completes in ~12 slots — still safe.

However, if any step hits a retry or rate limit (429) and takes 30+ seconds, the window could expire (50 slots * 0.4s = 20s). The window would reset, and the cumulative check would restart from the new reference — potentially causing the test to **fail to trip the cumulative limit** and produce a false failure.

**Recommendation:** After each successful step, fetch the oracle and log `last_slot`. Before the final step, verify that `current_slot - window_ref_slot < 50`. If the window expired, log a warning and skip the test rather than reporting false failure.

---

## LOW

### L-01: No Test for Unauthorized Oracle Update (Missing Access Control E2E)

**Location:** `e2e-security.test.ts` — missing test

The on-chain constraint `has_one = authority` on `UpdatePerkOracle` prevents non-authorized wallets from updating the oracle. No E2E test verifies this. While this is a basic Anchor constraint and is unlikely to break, oracle authority is the most critical access control in the system.

**Recommendation:** Add a test where a non-authority wallet calls `updatePerkOracle` and verify it's rejected with an `ConstraintHasOne` or `Unauthorized` error.

### L-02: No Test for Config Validation Boundaries

**Location:** `e2e-security.test.ts` — missing test

The on-chain code validates:
- `circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS (500)` when non-zero
- `max_price_change_bps >= MIN_PRICE_CHANGE_BPS (100)` when non-zero
- All values ≤ their respective maximums

No E2E test verifies that invalid values are rejected. For example:
- `circuitBreakerDeviationBps: 100` (below 500 minimum) → should fail
- `maxPriceChangeBps: 50` (below 100 minimum) → should fail
- `maxPriceChangeBps: 10001` (above 9999 maximum) → should fail

**Recommendation:** Add a boundary validation test.

### L-03: No Test for Circuit Breaker + Banding Interaction

**Location:** `e2e-security.test.ts` — missing test

Tests 1-2 isolate circuit breaker (banding=0). Tests 3, 6 isolate banding (CB=0). Test 4 enables both but only triggers CB. No test verifies that banding can independently reject when CB passes, or vice versa, when both are active simultaneously.

**Recommendation:** Create a test with both enabled (e.g., banding=500bps/5%, CB=2000bps/20%). Post a price that passes CB (<20% from EMA) but fails per-update banding (>5% from last price). Verify the banding error is returned, not CB.

---

## INFO

### I-01: `InitPerkOracleParams` SDK Passes `number` for `u8`/`u16`/`u32` Without Bounds Checking

**Location:** `sdk/src/client.ts` → `initializePerkOracle()`, `updateOracleConfig()`

The TS type uses `number` for fields that serialize to `u8` (`minSources`), `u16` (`maxPriceChangeBps`, `circuitBreakerDeviationBps`), and `u32` (`maxStalenessSeconds`). No client-side validation exists. Passing `minSources: 256` would overflow `u8` during Borsh serialization with unpredictable results.

Compare with `openPosition()` which has thorough client-side validation for `leverage` and `maxSlippageBps`. The oracle methods lack equivalent guards.

**Recommendation:** Add client-side bounds checks in `initializePerkOracle()` and `updateOracleConfig()`, similar to the pattern in `openPosition()`.

### I-02: Anchor `camelCase` ↔ `snake_case` Mapping Is Correct

Verified: Anchor's IDL generator auto-converts Rust `snake_case` field names to `camelCase` in the generated TS client. The SDK passes `{ maxPriceChangeBps, minSources, ... }` which Anchor serializes as `{ max_price_change_bps, min_sources, ... }` per the IDL. Field ordering is determined by the IDL (matches Rust declaration order), not by JS object key order. **No mismatch found.**

### I-03: `number | null` → Borsh `Option<T>` Serialization Is Correct

Verified: Anchor's TS client serializes `null` as Borsh `None` (0x00 prefix) and `number` as `Some(value)` (0x01 prefix + encoded value). The `UpdateOracleConfigParams` type in SDK correctly uses `number | null` for all optional fields. **No mismatch found.**

---

## Missing Test Coverage Summary

| Scenario | Tested? | Risk |
|----------|---------|------|
| Circuit breaker rejects upward jump | ✅ Test 1 | — |
| Circuit breaker disabled allows jump | ✅ Test 2 | — |
| Sliding window rejects cumulative walk | ✅ Test 3 | — |
| Unfreeze preserves EMA for CB | ✅ Test 4 | — |
| Config update changes fields | ✅ Test 5 (partial) | M-01 |
| Per-update banding rejects single jump | ✅ Test 6 | — |
| **Downward price banding** | ❌ | M-02 |
| **CB + banding interaction** | ❌ | L-03 |
| **Window expiry resets reference** | ❌ | Medium risk |
| **Config validation rejects bad values** | ❌ | L-02 |
| **Non-authority update rejected** | ❌ | L-01 |
| **First update can be any price (no band)** | ❌ | Design decision but untested |
| **Multi-freeze cycle stale ref** | ❌ | C-01 |
| **EMA behavior near MAX_ORACLE_PRICE** | ❌ | Low risk (capped) |

---

## Test 3 Math Verification ✅

Walked the math to confirm the test is logically correct:

| Step | Price | Per-Update Δ | Per-Update BPS | Window Δ from 100k | Window BPS | Result |
|------|-------|-------------|----------------|---------------------|------------|--------|
| Init | 100,000 | — | — | — | — | Accept (sets window ref) |
| 1 | 105,000 | 5,000 / 100,000 | 500 ≤ 500 ✅ | 5,000 / 100,000 | 500 ≤ 1,500 ✅ | Accept |
| 2 | 110,250 | 5,250 / 105,000 | 500 ≤ 500 ✅ | 10,250 / 100,000 | 1,025 ≤ 1,500 ✅ | Accept |
| 3 | 115,762 | 5,512 / 110,250 | 499 ≤ 500 ✅ | 15,762 / 100,000 | 1,576 > 1,500 ❌ | **Reject** |

Window max = `maxPriceChangeBps (500) × WINDOW_BAND_MULTIPLIER (3) = 1,500 bps (15%)`.  
Step 3 passes per-update (499 bps ≤ 500) but fails window (1,576 bps > 1,500). Test correctly expects rejection at this step.

**Edge case note:** Step 1 per-update is exactly 500 bps (the limit). Integer division: `5000 * 10000 / 100000 = 500`. Uses `<=` comparison, so boundary value passes. This is correct but tight — if the on-chain code used `<` instead of `<=`, this test would fail for the wrong reason.
