# E2E Security Test Run Results

**Date:** 2026-03-25 16:37 EDT  
**Environment:** Solana Devnet  
**Program ID:** `5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW`  
**Anchor CLI:** 0.32.1  
**Solana CLI:** 3.0.15

---

## Build Status

### Program Compilation: ✅ SUCCESS
- `perk_protocol.so` compiled successfully (872,760 bytes)
- IDL generated from prior build (78,155 bytes)

### Test Compilation (Rust integration tests): ❌ FAILED
- `programs/perk-protocol/tests/common/mod.rs` has stale imports:
  - `perk_protocol::engine::i128_types` — module not found
  - `perk_protocol::engine::margin` — module not found
- **Impact:** Only affects Rust-level fuzz/integration tests, not the TS E2E suite
- **Fix needed:** Remove or update stale imports in `tests/common/mod.rs`

---

## Deploy Status: ✅ ALREADY DEPLOYED
- Program live on devnet at slot 450990806
- Authority: `6RDXYAgXvmEaeE64r9hLhaaFkcMDiXL3px2GJ5mv3Q39`
- Balance: 6.01 SOL

---

## Test File Update: ✅ COMPLETE
Added realistic token price profiles to `sdk/tests/e2e-security.test.ts`:
- **$VNUT** (The Vaping Squirrel) — crash/recovery profile
- **$CAPTCHA** (captcha.social) — 16900% pump profile  
- **$APES** (Apes Together Strong) — moderate volatility profile

---

## E2E Test Results (9 tests)

| # | Test | Result | Notes |
|---|------|--------|-------|
| 1 | Circuit Breaker Rejects Wild Price Jump (+20%) | ❌ FAIL | Update was accepted — CB didn't trigger |
| 2 | Circuit Breaker Allows When Disabled | ✅ PASS | +100% accepted correctly |
| 3 | Sliding Window Rejects Cumulative Walk | ❌ FAIL | All 4 walk steps accepted — window didn't trigger |
| 4 | Unfreeze Anchoring — EMA Preserved | ❌ FAIL | +30% accepted post-unfreeze; EMA reset to 0 instead of preserved |
| 5 | Oracle Config Update (All Fields) | ❌ FAIL | minSources stayed 1 (expected 3); config update didn't persist |
| 6 | Per-Update Banding Rejects Single Large Move | ✅ PASS | +10% rejected, +4% accepted correctly |
| 7 | Circuit Breaker Rejects Downward Price Jump (-20%) | ❌ FAIL | Update was accepted — CB didn't trigger downward |
| 8 | Per-Update Banding Rejects Downward Move | ✅ PASS | -10% rejected, -4% accepted correctly |
| 9 | Circuit Breaker Exact Boundary (+10%) | ⚠️ INCOMPLETE | Test appeared to hang/timeout after initialization |

**Summary: 3 PASSED, 5 FAILED, 1 INCOMPLETE**

---

## Analysis of Failures

### Circuit Breaker Not Enforcing (Tests 1, 7, 9)
The circuit breaker (EMA deviation check) is not rejecting price updates that exceed the configured deviation threshold. Updates of ±20% pass through when a 10% CB is configured. This suggests:
- The on-chain program may not be implementing EMA-based circuit breaker checks on `update_oracle`
- Or the EMA hasn't accumulated enough history for the check to activate (only 1 prior update)

### Sliding Window Not Triggering (Test 3)
Four cumulative +5% steps (total ~21.5% move) all accepted without window rejection. The sliding window banding mechanism doesn't appear to be enforced on-chain. Possible causes:
- Window tracking not implemented in the deployed program version
- Window period/threshold configuration not being read

### Unfreeze EMA Reset (Test 4)
After freeze → unfreeze, the EMA resets to 0 instead of preserving the pre-freeze value. This is a confirmed bug — the unfreeze instruction zeros out the EMA field rather than anchoring it.

### Config Update Not Persisting (Test 5)
`updateOracleConfig` transaction succeeded but `minSources` remained at 1. Either:
- The config update instruction isn't writing to the correct account fields
- The SDK is reading from a stale/cached account

---

## What's Needed to Fix Failures

1. **Circuit Breaker (on-chain):** Verify the `update_oracle` instruction checks `|new_price - ema| / ema > circuit_breaker_deviation_bps`. May need program update + redeploy.
2. **Sliding Window (on-chain):** Implement or fix cumulative move tracking across a time window. May not be in the current deployed version.
3. **Unfreeze EMA (on-chain):** The `unfreeze_oracle` instruction must copy `ema_price` to a preserved field or skip zeroing it. Program fix required.
4. **Config Update (on-chain/SDK):** Debug whether the `update_oracle_config` instruction correctly writes `min_sources`. Check IDL field ordering.
5. **Rust test imports:** Remove `i128_types` and `margin` imports from `tests/common/mod.rs` to fix `anchor build` IDL generation.

---

## Per-Update Banding: Working ✅
Tests 6 and 8 confirm that single-update banding (rejecting moves > X% in one update) works correctly for both upward and downward moves. This is the most functional security feature in the current deployment.
