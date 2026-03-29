# Risk Engine Hardening + Code Cleanup — Audit Fix Summary

**Date:** 2026-03-25  
**Scope:** ATK-07, ATK-08, ATK-09, ARCH-01, ARCH-05

---

## Fix 1: Insurance Epoch Cap Reduction (ATK-09)

**File:** `constants.rs`  
**Change:** `INSURANCE_EPOCH_CAP_BPS` reduced from `5000` (50%) to `3000` (30%)  
**Rationale:** Limits per-epoch insurance fund drainage under sustained attack, improving fund survivability.

## Fix 2: Dynamic Insurance Floor (ATK-09)

**File:** `engine/risk.rs` → `use_insurance_buffer()`  
**Change:** Insurance floor is now `max(configured_floor, ins_bal / 5)` instead of just `configured_floor`  
**Rationale:** Preserves at least 20% of the insurance fund as a reserve floor. Originally implemented as `vault_balance / 5`, but red team review caught that vault_balance >> insurance_fund_balance typically, which would lock the entire fund. Fixed to use insurance balance directly.

## Fix 3: TWAP Single-Trade Cap (ATK-07)

**Files modified:**
- `instructions/open_position.rs`
- `instructions/close_position.rs`
- `instructions/execute_trigger_order.rs`
- `instructions/update_amm.rs`

**Change:** All TWAP accumulator updates now cap the volume weight at `market.k / 10` (10% of vAMM invariant) via `core::cmp::min(weight, max_twap_weight)`.  
**Rationale:** A single massive trade can no longer dominate the volume-weighted TWAP, preventing mark price manipulation that feeds into funding rate calculations.

## Fix 4: protocol_fee_vault Documentation (ARCH-01)

**File:** `instructions/initialize_protocol.rs`  
**Change:** Updated the `/// CHECK:` comment on `protocol_fee_vault` (UncheckedAccount) to document why no validation is needed — it's vestigial, never used for CPI transfers, and only set during admin-only one-time init.

## Fix 5: Remove Unused Error Variants (ARCH-05)

**File:** `errors.rs`  
**Removed variants (replaced with explanatory comments):**
- `PositionNotFound` — handled by PDA derivation (account does not exist = not found)
- `PositionAlreadyExists` — handled by PDA uniqueness (init fails if exists)
- `ReduceOnlyViolation` — unused, other errors cover this case
- `MarketAlreadyExists` — handled by PDA uniqueness (init fails if exists)

**Verification:** `Select-String` across entire `programs/` tree confirmed zero references to any of these variants outside `errors.rs`.

## Fix 6: Stricter Liquidation Oracle Freshness (ATK-08)

**File:** `instructions/liquidate.rs`  
**Change:** Oracle result now captures both `.price` and `.timestamp`. Added a 5-second staleness check (`MAX_LIQUIDATION_ORACLE_AGE = 5`) specific to liquidations, vs the normal 15-second staleness in the oracle reader.  
**Rationale:** Reduces the window for stale-price liquidation exploitation. Liquidators must submit transactions with fresh oracle data, making it harder to exploit delayed price feeds.

---

## Notes

- All changes are minimal and surgical — no function signatures modified
- All types are compatible (u128 arithmetic where applicable)
- Error variant removal was verified via codebase-wide search before deletion
- Oracle `OraclePrice` struct already had a `timestamp: i64` field; the liquidate handler just wasn't using it
