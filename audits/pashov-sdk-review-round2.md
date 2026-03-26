# Pashov-Style SDK Review — Round 2 (Verification)

**Auditor:** Kai (automated Pashov-style reviewer)  
**Date:** 2026-03-25  
**Scope:** SDK client-side validation (ATK-01 fix), error matching (ATK-03 fix), new tests 7-9, existing tests 1-6, constants audit  
**Files reviewed:**
- `sdk/src/client.ts` (initializePerkOracle, updateOracleConfig)
- `sdk/tests/e2e-security.test.ts` (all 9 tests)
- `sdk/src/constants.ts`
- `programs/perk-protocol/src/constants.rs`
- `programs/perk-protocol/src/instructions/update_perk_oracle.rs`

---

## 1. Client-Side Validation (ATK-01 Fix)

### 1.1 `initializePerkOracle` — u16 Range Checks

**PASS** ✅

Both `circuitBreakerDeviationBps` and `maxPriceChangeBps` are checked against `[0, 65535]` before any program call. Lines are explicit:
```ts
if (params.circuitBreakerDeviationBps < 0 || params.circuitBreakerDeviationBps > 65535) { throw ... }
if (params.maxPriceChangeBps < 0 || params.maxPriceChangeBps > 65535) { throw ... }
```

### 1.2 `initializePerkOracle` — Bounds Checks Match On-Chain

**PASS** ✅

| Parameter | SDK Check | On-Chain (constants.rs) | Match |
|-----------|-----------|------------------------|-------|
| `circuitBreakerDeviationBps` | 0 or [500, 9999] | `MIN_CIRCUIT_BREAKER_BPS=500`, `MAX_CIRCUIT_BREAKER_BPS=9999` | ✅ |
| `maxPriceChangeBps` | 0 or [100, 9999] | `MIN_PRICE_CHANGE_BPS=100`, `MAX_PRICE_CHANGE_BPS=9999` | ✅ |
| `minSources` | [1, 10] | `MAX_MIN_SOURCES=10`, implicit min=1 | ✅ |
| `maxStalenessSeconds` | [5, 300] | `MIN_ORACLE_STALENESS_SECONDS=5`, `MAX_ORACLE_STALENESS_SECONDS=300` | ✅ |

### 1.3 `updateOracleConfig` — Null Field Skipping

**PASS** ✅

Every validation block is guarded by `!== null`:
```ts
if (params.circuitBreakerDeviationBps !== null) { ... range check ... }
if (params.maxPriceChangeBps !== null) { ... range check ... }
if (params.minSources !== null) { ... }
if (params.maxStalenessSeconds !== null) { ... }
```

Null fields pass through to the program call unchanged, allowing partial updates. Confirmed in Test 5 where `maxStalenessSeconds: null` and `maxPriceChangeBps: null` are sent and the on-chain values remain unchanged (60s staleness preserved).

### 1.4 `updateOracleConfig` — Bounds Checks Match On-Chain

**PASS** ✅

Same bounds as `initializePerkOracle` but with null-awareness. Combined null+zero guard:
```ts
if (params.circuitBreakerDeviationBps !== null && params.circuitBreakerDeviationBps !== 0) {
    if (... < 500 || ... > 9999) throw ...
}
```

### 1.5 Validation Runs BEFORE Program Call

**PASS** ✅

In both `initializePerkOracle` and `updateOracleConfig`, all validation code appears before the `this.program.methods.*.rpc()` call. An invalid parameter will throw before any transaction is constructed or sent.

---

## 2. Error Matching (ATK-03 Fix)

### 2.1 Exact Error Variant Names

**PASS** ✅

Every catch block matches the exact on-chain error variant:

| Test | Expected Error | Matched String | Correct |
|------|---------------|----------------|---------|
| 1 | Circuit breaker (upward) | `OracleCircuitBreakerTripped` | ✅ |
| 3 | Sliding window banding | `OraclePriceInvalid` | ✅ |
| 4 | CB after unfreeze | `OracleCircuitBreakerTripped` | ✅ |
| 5 | Insufficient sources | `OracleInsufficientSources` | ✅ |
| 6 | Per-update banding (upward) | `OraclePriceInvalid` | ✅ |
| 7 | Circuit breaker (downward) | `OracleCircuitBreakerTripped` | ✅ |
| 8 | Per-update banding (downward) | `OraclePriceInvalid` | ✅ |

Cross-checked against `update_perk_oracle.rs`:
- `PerkError::OracleCircuitBreakerTripped` — used in CB check ✅
- `PerkError::OraclePriceInvalid` — used in banding check and sliding window check ✅
- `PerkError::OracleInsufficientSources` — used in min sources check ✅

### 2.2 No Silent Fallbacks

**PASS** ✅

Every catch block follows this pattern:
```ts
if (err.message.includes("Should have failed")) throw err;
else if (err.message.includes("<exact_variant>")) { /* expected */ }
else throw new Error(`Expected <variant> but got: ${err.message?.slice(0, 200)}`);
```

No `⚠️` fallbacks, no `console.warn`, no swallowed errors. Any unexpected error variant is re-thrown with context.

### 2.3 "Should have failed!" Sentinel

**PASS** ✅

All tests that expect failure use:
```ts
throw new Error("Should have failed!");
```
...followed by a catch that re-throws if the message contains "Should have failed". This prevents false positives where the transaction succeeds but the test silently passes.

---

## 3. New Tests — Math Verification

### 3.1 Test 7: Circuit Breaker Rejects Downward Price Jump

**PASS** ✅

**Setup:** CB = 1000 bps (10%), banding = 0 (off). Initial price = 100,000.

**Attempt -20% (80,000):**
- On-chain: `old_ema` captured = 100,000 (first update sets EMA = price)
- EMA update runs first: new_ema = (80,000 + 9×100,000) / 10 = 98,000
- CB check uses `old_ema` = 100,000: `deviation = |80,000 - 100,000| = 20,000`
- `deviation_bps = 20,000 × 10,000 / 100,000 = 2,000`
- `2,000 > 1,000` → **OracleCircuitBreakerTripped** ✅
- Transaction reverts → EMA stays at 100,000

**Attempt -8% (92,000):**
- `old_ema` = 100,000 (unchanged — previous tx reverted)
- `deviation = |92,000 - 100,000| = 8,000`
- `deviation_bps = 8,000 × 10,000 / 100,000 = 800`
- `800 ≤ 1,000` → **PASS** ✅

**Note on EMA preservation after revert:** Critical correctness point. The 80,000 update reverted on-chain, so EMA remains 100,000 for the 92,000 attempt. The test correctly relies on this behavior.

### 3.2 Test 8: Per-Update Banding Rejects Downward Move

**PASS** ✅

**Setup:** Banding = 500 bps (5%), CB = 0 (off). Initial price = 100,000.

**Attempt -10% (90,000):**
- `reference_price = oracle.price = 100,000`
- `diff = |90,000 - 100,000| = 10,000`
- `change_bps = 10,000 × 10,000 / 100,000 = 1,000`
- `1,000 > 500` → **OraclePriceInvalid** ✅

**Attempt -4% (96,000):**
- `reference_price = 100,000` (previous tx reverted)
- `diff = |96,000 - 100,000| = 4,000`
- `change_bps = 4,000 × 10,000 / 100,000 = 400`
- `400 ≤ 500` → **PASS** ✅

### 3.3 Test 9: Circuit Breaker Exact Boundary (≤ semantics)

**PASS** ✅

**Setup:** CB = 1000 bps (10%), banding = 0 (off). Initial price = 10,000,000.

**Attempt exactly +10% (11,000,000):**
- `old_ema = 10,000,000`
- `deviation = |11,000,000 - 10,000,000| = 1,000,000`
- `deviation_bps = 1,000,000 × 10,000 / 10,000,000 = 1,000`
- On-chain check: `require!(deviation_bps <= cb_bps as u64, ...)` → `1,000 ≤ 1,000` → **PASS** ✅

This correctly validates the `<=` (less-than-or-equal) semantics on-chain, confirming the boundary is inclusive.

**Integer arithmetic note:** Using 10,000,000 as the base avoids any rounding issues in the bps calculation. Clean division. ✅

---

## 4. Existing Tests (1-6) — Still Correct After Edits?

### 4.1 Test 1: Circuit Breaker Rejects Wild Price Jump (Upward)

**PASS** ✅

- Initial: 50,000. CB = 1000 bps (10%).
- +20% (60,000): deviation = 10,000, bps = 10,000 × 10,000 / 50,000 = 2,000 > 1,000 → FAIL ✅
- +8% (54,000): deviation = 4,000, bps = 4,000 × 10,000 / 50,000 = 800 ≤ 1,000 → PASS ✅
- Error matching: `OracleCircuitBreakerTripped` ✅

### 4.2 Test 2: Circuit Breaker Allows When Disabled

**PASS** ✅

- CB = 0 (disabled), banding = 0.
- +100% jump (50,000 → 100,000) accepted. No protection active. ✅
- No catch blocks — purely positive path. ✅

### 4.3 Test 3: Sliding Window Rejects Cumulative Walk

**PASS** ✅

- Banding = 500 bps (5%), CB = 0. Initial: 100,000.
- Walk: 105,000 → 110,250 → 115,762 → 121,550
- Per-update checks pass (~5% each step), but sliding window (3× = 15% = 1500 bps max) catches cumulative:
  - Step 3 (115,762): window diff = 15,762, bps = 1,576 > 1,500 → **OraclePriceInvalid** ✅
- Test expects `hitCumulativeLimit` to be true. ✅
- Error matching: `OraclePriceInvalid` ✅
- `CIRCUIT_BREAKER_WINDOW_SLOTS = 50` (~20s). Test sleeps 2s between steps (~5 slots each), well within window. ✅

### 4.4 Test 4: Unfreeze Anchoring — EMA Preserved

**PASS** ✅

- Banding = 3000 bps (30%), CB = 1000 bps (10%).
- EMA established ~100,000 area (3 updates: 100,000, 100,100, 100,200).
- Freeze → unfreeze → +30% (130,000) fails (CB trips: 30% > 10%) → +8% (108,000) passes.
- Error matching: `OracleCircuitBreakerTripped` ✅

### 4.5 Test 5: Oracle Config Update (All Fields)

**PASS** ✅

- Init with minSources=1, update to minSources=3, circuitBreakerDeviationBps=2000.
- `maxStalenessSeconds: null` preserved at 60s — verified by assert. ✅
- Update with numSources=2 fails → `OracleInsufficientSources` ✅
- Update with numSources=3 passes ✅
- Error matching: `OracleInsufficientSources` ✅

### 4.6 Test 6: Per-Update Banding Rejects Single Large Move (Upward)

**PASS** ✅

- Banding = 500 bps (5%), CB = 0. Initial: 100,000.
- +10% (110,000): bps = 1,000 > 500 → FAIL ✅
- +4% (104,000): bps = 400 ≤ 500 → PASS ✅
- Error matching: `OraclePriceInvalid` ✅

### 4.7 Did Error Matching Changes Break Existing Tests?

**PASS** ✅

The ATK-03 fix replaced generic error handling with exact variant matching. All 6 existing tests use the same strict pattern as the new tests: match exact variant, re-throw sentinel, throw on unexpected. No behavioral change — only stronger assertions.

---

## 5. Constants Audit — SDK vs On-Chain

### 5.1 Matched Constants (All Values Agree)

**PASS** ✅

| SDK Constant | SDK Value | Rust Constant | Rust Value | Match |
|---|---|---|---|---|
| `MIN_LEVERAGE` | 200 | `MIN_LEVERAGE` | 200 | ✅ |
| `MAX_LEVERAGE` | 2000 | `MAX_LEVERAGE` | 2000 | ✅ |
| `MIN_TRADING_FEE_BPS` | 3 | `MIN_TRADING_FEE_BPS` | 3 | ✅ |
| `MAX_TRADING_FEE_BPS` | 100 | `MAX_TRADING_FEE_BPS` | 100 | ✅ |
| `LIQUIDATION_FEE_BPS` | 100 | `LIQUIDATION_FEE_BPS` | 100 | ✅ |
| `MAINTENANCE_MARGIN_BPS` | 500 | `MAINTENANCE_MARGIN_BPS` | 500 | ✅ |
| `CREATOR_FEE_SHARE_BPS` | 1000 | `CREATOR_FEE_SHARE_BPS` | 1000 | ✅ |
| `PRICE_SCALE` | 1,000,000 | `PRICE_SCALE` | 1,000,000 | ✅ |
| `POS_SCALE` | 1,000,000 | `POS_SCALE` | 1,000,000 | ✅ |
| `ADL_ONE` | 1,000,000 | `ADL_ONE` | 1,000,000 | ✅ |
| `K_SCALE` | 1e12 | `K_SCALE` | 1e12 | ✅ |
| `MIN_INITIAL_K` | 1e18 | `MIN_INITIAL_K` | 1e18 | ✅ |
| `DEFAULT_MARKET_CREATION_FEE` | 1,000,000,000 | `DEFAULT_MARKET_CREATION_FEE` | 1,000,000,000 | ✅ |
| `FUNDING_RATE_PRECISION` | 1,000,000 | `FUNDING_RATE_PRECISION` | 1,000,000 | ✅ |
| `MAX_FUNDING_DT` | 65535 | `MAX_FUNDING_DT` | 65535 | ✅ |
| `FUNDING_RATE_CAP_BPS` | 10 | `FUNDING_RATE_CAP_BPS` | 10 | ✅ |
| `PEG_UPDATE_COOLDOWN_SLOTS` | 100 | `PEG_UPDATE_COOLDOWN_SLOTS` | 100 | ✅ |
| `AMM_PEG_THRESHOLD_BPS` | 50 | `AMM_PEG_THRESHOLD_BPS` | 50 | ✅ |
| `ORACLE_STALENESS_SECONDS` | 15 | `ORACLE_STALENESS_SECONDS` | 15 | ✅ |
| `INSURANCE_EPOCH_SECONDS` | 86400 | `INSURANCE_EPOCH_SECONDS` | 86400 | ✅ |
| `INSURANCE_EPOCH_CAP_BPS` | 3000 | `INSURANCE_EPOCH_CAP_BPS` | 3000 | ✅ |
| `WARMUP_PERIOD_SLOTS` | 1000 | `WARMUP_PERIOD_SLOTS` | 1000 | ✅ |
| `MIN_REMAINING_POSITION_SIZE` | 100 | `MIN_REMAINING_POSITION_SIZE` | 100 | ✅ |
| `MAX_TRIGGER_ORDER_AGE_SECONDS` | 2,592,000 | `MAX_TRIGGER_ORDER_AGE_SECONDS` | 2,592,000 | ✅ |
| `DUST_THRESHOLD` | 1000 | `DUST_THRESHOLD` | 1000 | ✅ |
| `MIN_RECLAIM_DELAY_SLOTS` | 1000 | `MIN_RECLAIM_DELAY_SLOTS` | 1000 | ✅ |
| `MAX_TRIGGER_ORDERS` | 8 | `MAX_TRIGGER_ORDERS_PER_USER` | 8 | ✅ |
| `BPS_DENOMINATOR` | 10,000 | `BPS_DENOMINATOR` | 10,000 | ✅ |
| `MIN_NONZERO_MM_REQ` | 10,000 | `MIN_NONZERO_MM_REQ` | 10,000 | ✅ |
| `MIN_NONZERO_IM_REQ` | 20,000 | `MIN_NONZERO_IM_REQ` | 20,000 | ✅ |
| `LIQUIDATOR_SHARE_BPS` | 5000 | `LIQUIDATOR_SHARE_BPS` | 5000 | ✅ |
| `TRIGGER_EXECUTION_FEE_BPS` | 1 | `TRIGGER_EXECUTION_FEE_BPS` | 1 | ✅ |
| `MIN_DEPOSIT_AMOUNT` | 1,000 | `MIN_DEPOSIT_AMOUNT` | 1,000 | ✅ |
| `MIN_A_SIDE` | 1,000 | `MIN_A_SIDE` | 1,000 | ✅ |
| `MIN_ORACLE_STALENESS_SECONDS` | 5 | `MIN_ORACLE_STALENESS_SECONDS` | 5 | ✅ |
| `MAX_ORACLE_STALENESS_SECONDS` | 300 | `MAX_ORACLE_STALENESS_SECONDS` | 300 | ✅ |
| `MAX_MIN_SOURCES` | 10 | `MAX_MIN_SOURCES` | 10 | ✅ |
| `MAX_ORACLE_PRICE` | 1e12 | `MAX_ORACLE_PRICE` | 1e12 | ✅ |
| `MIN_PRICE_CHANGE_BPS` | 100 | `MIN_PRICE_CHANGE_BPS` | 100 | ✅ |
| `MAX_PRICE_CHANGE_BPS` | 9999 | `MAX_PRICE_CHANGE_BPS` | 9999 | ✅ |
| `MIN_CIRCUIT_BREAKER_BPS` | 500 | `MIN_CIRCUIT_BREAKER_BPS` | 500 | ✅ |
| `MAX_CIRCUIT_BREAKER_BPS` | 9999 | `MAX_CIRCUIT_BREAKER_BPS` | 9999 | ✅ |
| `CIRCUIT_BREAKER_WINDOW_SLOTS` | 50 | `CIRCUIT_BREAKER_WINDOW_SLOTS` | 50 | ✅ |
| `WINDOW_BAND_MULTIPLIER` | 3 | `WINDOW_BAND_MULTIPLIER` | 3 | ✅ |

### 5.2 SDK-Only Constants (Not in constants.rs)

| Constant | Value | Assessment |
|---|---|---|
| `LEVERAGE_SCALE` | 100 | SDK convenience for display (200/100 = "2x"). Not enforced on-chain. **Acceptable.** |
| `DEFAULT_TRADING_FEE_BPS` | 30 | SDK default suggestion. Not an on-chain constant. **Acceptable.** |
| `MAX_FUNDING_ITERATIONS` | 50 | SDK cranker loop limit. Not an on-chain constant. **Acceptable.** |

### 5.3 Rust-Only Constants (Not Mirrored to SDK)

Notable omissions (all acceptable — internal implementation details):
- `ORACLE_CONFIDENCE_BPS`, `PEG_SCALE`, `DEFAULT_FUNDING_PERIOD`, `DEFAULT_MAX_LEVERAGE`
- Percolator normative bounds (`MAX_VAULT_TVL`, `MAX_POSITION_ABS_Q`, etc.)
- Reserved field offset constants
- `MIN_WARMUP_PERIOD_SLOTS`, `MIN/MAX_TOKEN_DECIMALS`

These are not needed by SDK consumers. No mismatches found.

### 5.4 Type Differences

Two constants have different Rust types but identical values:
- `MAX_TRADING_FEE_BPS`: SDK `number` (100) vs Rust `u64` (100)
- `MIN_NONZERO_MM_REQ` / `MIN_NONZERO_IM_REQ`: SDK `number` vs Rust `u128`

These are safe — JavaScript numbers can represent these values exactly. **No issue.**

---

## Summary

| Item | Verdict |
|---|---|
| **1.1** u16 range checks (initializePerkOracle) | **PASS** ✅ |
| **1.2** Bounds match on-chain (initializePerkOracle) | **PASS** ✅ |
| **1.3** Null field skipping (updateOracleConfig) | **PASS** ✅ |
| **1.4** Bounds match on-chain (updateOracleConfig) | **PASS** ✅ |
| **1.5** Validation before program call | **PASS** ✅ |
| **2.1** Exact error variant names | **PASS** ✅ |
| **2.2** No silent fallbacks | **PASS** ✅ |
| **2.3** Sentinel re-throw | **PASS** ✅ |
| **3.1** Test 7 math (downward CB) | **PASS** ✅ |
| **3.2** Test 8 math (downward banding) | **PASS** ✅ |
| **3.3** Test 9 math (boundary ≤) | **PASS** ✅ |
| **4.1-4.6** Tests 1-6 still correct | **PASS** ✅ |
| **4.7** Error changes didn't break existing tests | **PASS** ✅ |
| **5.1** Constants values match | **PASS** ✅ |
| **5.2-5.4** SDK-only / Rust-only / type diffs | **PASS** ✅ |

**Overall: ALL CHECKS PASS. No issues found. The ATK-01 and ATK-03 fixes are correct and complete.**
