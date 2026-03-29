# Anchor Architecture Review — Round 2 (Fix Verification)

Date: 2026-03-25

Reviewer: Kai (automated architecture review)

---

## [ARCH-R2-01] Error Variant Removal Safety

**Category:** IDL / ABI Compatibility  
**Severity:** Info (acceptable for pre-mainnet)  
**Description:** Four error variants were removed from `PerkError`:
- `MarketAlreadyExists`
- `PositionNotFound`
- `PositionAlreadyExists`
- `ReduceOnlyViolation`

**Verification:**
- ✅ **Grep confirms zero usage** — searched all `.rs` files in the program. The only matches are the `// ARCH-05:` comments in `errors.rs` explaining *why* they were removed. No code references these variants.
- ⚠️ **Discriminant shift confirmed** — Anchor assigns sequential error codes (6000+N). Removing 4 variants from the middle shifts all subsequent error codes. This is an **IDL-breaking change** — any existing client parsing error codes by number will misinterpret them after upgrade.
- ✅ **Acceptable for pre-mainnet** — no deployed mainnet program exists yet. IDL will be regenerated on next `anchor build`. All clients/tests must use the new IDL.

**Fix:** N/A — correctly handled. Ensure all test suites and SDK clients are regenerated from the new IDL.

---

## [ARCH-R2-02] UpdateOracleConfigParams Borsh Layout Change

**Category:** Instruction Data / ABI Compatibility  
**Severity:** Info (acceptable for pre-mainnet)  
**Description:** `UpdateOracleConfigParams` changed from a single `u16` field to four `Option<_>` fields. Borsh encoding differs fundamentally (`Option<T>` adds a 1-byte discriminant prefix per field).

**Verification:**
- ✅ **Instruction data only** — `UpdateOracleConfigParams` is `#[derive(AnchorSerialize, AnchorDeserialize)]` and used only as instruction input via `handler(ctx, params)`. It is NOT stored in any account's state struct. Existing on-chain accounts are unaffected.
- ✅ **Old clients incompatible** — confirmed. Old clients sending a bare `u16` will fail deserialization against the new `Option<u16>, Option<u8>, Option<u32>, Option<u16>` layout. This is expected and acceptable pre-mainnet.
- ✅ **IDL regeneration** — Anchor's `#[derive(AnchorSerialize, AnchorDeserialize)]` on the params struct will produce correct IDL types on `anchor build`.
- ✅ **Handler logic correct** — each `Option` field is handled independently with `if let Some(val)`, applying validation before writing. Omitted fields leave oracle config unchanged. Clean pattern.

**Fix:** N/A — correctly implemented as a flexible admin config update.

---

## [ARCH-R2-03] InitPerkOracleParams — New Field Position

**Category:** Instruction Data Layout  
**Severity:** Pass ✅  
**Description:** New field `circuit_breaker_deviation_bps: u16` added to `InitPerkOracleParams`.

**Verification:**
- ✅ **At the END of the struct** — field order in the source is: `min_sources`, `max_staleness_seconds`, `max_price_change_bps`, `circuit_breaker_deviation_bps`. The new field is last.
- ✅ **lib.rs dispatch correct** — `initialize_perk_oracle` in `lib.rs` passes `params: InitPerkOracleParams` directly to the handler. The handler reads `params.circuit_breaker_deviation_bps` and stores it in `_reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS..+2]`. Correct flow.

**Fix:** N/A — correctly placed and wired.

---

## [ARCH-R2-04] Constant Usage Consistency — _reserved Access

**Category:** Code Quality / Safety  
**Severity:** Pass ✅  
**Description:** All `_reserved` byte array accesses must use named `RESERVED_OFFSET_*` constants from `constants.rs`.

**Verification:**
- ✅ **No hardcoded indices in code** — PowerShell search of all `.rs` files for `_reserved[\d` patterns (excluding comments and RESERVED_OFFSET references) returned zero matches.
- ✅ **One comment reference** — `freeze_perk_oracle.rs:34` contains `// ... _reserved[3..11]` as a code comment explaining the C-01 fix. The actual code on the next line uses `RESERVED_OFFSET_PRE_FREEZE_PRICE`. Correct.
- ✅ **All offsets defined** — constants.rs defines: `RESERVED_OFFSET_UNFREEZE_PENDING` (0), `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS` (1), `RESERVED_OFFSET_PRE_FREEZE_PRICE` (3), `RESERVED_OFFSET_WINDOW_REF_PRICE` (11), `RESERVED_OFFSET_WINDOW_REF_SLOT` (19), `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS` (27). Non-overlapping and correctly sized for their types.

**Fix:** N/A — all accesses use named constants.

---

## [ARCH-R2-05] TWAP Cap — Type Consistency

**Category:** Type Safety  
**Severity:** Pass ✅  
**Description:** TWAP cap logic in `open_position.rs`, `close_position.rs`, `execute_trigger_order.rs`, and `update_amm.rs` must have consistent u128 types.

**Verification:**
- ✅ **`market.k`** — `u128` (confirmed in `state/market.rs:35`)
- ✅ **`market.k / 10`** — `u128` (u128 division produces u128)
- ✅ **`trade_notional` / `trade_notional_for_twap` / `close_notional_for_twap`** — all are return values of `vamm::calculate_notional(u128, u64) -> Result<u128>`, so `u128`
- ✅ **`peg_twap_weight` in update_amm.rs** — explicitly typed as `u128` (`let peg_twap_weight: u128 = 1_000_000`)
- ✅ **`core::cmp::min(trade_notional, max_twap_weight)`** — both `u128`, compiles correctly
- ✅ **`capped_twap_weight` used in `.saturating_mul`** — `(mark_price as u128).saturating_mul(capped_twap_weight)` — both `u128`, correct
- ✅ **Accumulator fields** — `mark_price_accumulator: u128` and `twap_volume_accumulator: u128` (confirmed in state). `.saturating_add()` on `u128` is correct.

**Fix:** N/A — all types are consistent u128 throughout.

---

## [ARCH-R2-06] Liquidation Handler — OracleResult Usage

**Category:** Correctness  
**Severity:** Pass ✅  
**Description:** Liquidation handler now captures full `OraclePrice` struct for timestamp access.

**Verification:**
- ✅ **`OraclePrice` has `timestamp: i64` field** — confirmed in `engine/oracle.rs:17`
- ✅ **`oracle_result`** — `let oracle_result = oracle::read_oracle_price_with_fallback(...)` captures the full struct
- ✅ **`oracle_price`** — `let oracle_price = oracle_result.price` extracts the price for all subsequent operations
- ✅ **`oracle_result.timestamp`** — used for staleness check: `clock.unix_timestamp.saturating_sub(oracle_result.timestamp)` compared against `MAX_LIQUIDATION_ORACLE_AGE` (5 seconds). Correct.
- ✅ **Rest of handler** — all subsequent code uses `oracle_price` (u64), not `oracle_result`. No type confusion.

**Fix:** N/A — correctly decomposed. The stricter 5-second freshness check (ATK-08) is a good security improvement.

---

## [ARCH-R2-07] Insurance Buffer Type Safety

**Category:** Type Safety / Arithmetic  
**Severity:** Pass ✅  
**Description:** `use_insurance_buffer` in `risk.rs` uses dynamic insurance floor calculation.

**Verification:**
- ✅ **`ins_bal`** — `market.insurance_fund_balance as u128` — u64 → u128 widening, safe
- ✅ **`ins_bal / 5`** — u128 division, safe (no divide-by-zero, denominator is constant 5)
- ✅ **`core::cmp::max(market.insurance_floor, ins_bal / 5)`** — both u128 (`insurance_floor` is u128 type confirmed by usage). `core::cmp::max` on same types, correct.
- ✅ **`ins_bal.saturating_sub(dynamic_floor)`** — both u128, saturating subtraction prevents underflow, correct
- ✅ **`epoch_cap` calculation** — `(ins_bal * INSURANCE_EPOCH_CAP_BPS as u128) / 10_000` — u128 arithmetic, INSURANCE_EPOCH_CAP_BPS is u16 (3000), product fits in u128 easily
- ✅ **`core::cmp::min(available, epoch_remaining)`** — both u128, correct
- ✅ **Final `pay` deduction** — `(ins_bal - pay) as u64` — safe because `pay <= ins_bal` and `ins_bal` originated from a u64 cast, so result fits in u64

**Fix:** N/A — arithmetic is sound throughout.

---

## Summary

| Check | Status |
|-------|--------|
| ARCH-R2-01: Error variant removal | ✅ Pass (IDL-breaking, acceptable pre-mainnet) |
| ARCH-R2-02: UpdateOracleConfigParams layout | ✅ Pass (instruction data only, acceptable pre-mainnet) |
| ARCH-R2-03: InitPerkOracleParams field order | ✅ Pass |
| ARCH-R2-04: _reserved constant usage | ✅ Pass |
| ARCH-R2-05: TWAP cap type consistency | ✅ Pass |
| ARCH-R2-06: Liquidation oracle_result usage | ✅ Pass |
| ARCH-R2-07: Insurance buffer type safety | ✅ Pass |

**Overall verdict: All 7 checks PASS.** The code changes follow Anchor best practices, maintain type safety, and don't introduce account validation issues. The two IDL-breaking changes (error discriminant shift and UpdateOracleConfigParams layout) are acceptable for pre-mainnet status — just ensure all clients/SDKs/tests regenerate from the new IDL after `anchor build`.
