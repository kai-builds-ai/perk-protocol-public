# Anchor Architecture Review — Round 3 (Verification)

**Date:** 2026-03-25  
**Reviewer:** Kai (automated architecture reviewer)  
**Scope:** Verify all code changes from Rounds 1–2 are correctly implemented  
**Verdict:** ✅ ALL CHECKS PASS

---

## 1. freeze_perk_oracle.rs

### Clock::get() placement
✅ **PASS** — `Clock::get()?` is called **only inside the `if !frozen` block** (line ~44). When `frozen=true` (freeze path), the entire `if !frozen` block is skipped. No unnecessary CU cost on freeze.

### pre_freeze_price capture ordering
✅ **PASS** — `pre_freeze_bytes` is written from `oracle.price` (line ~35) **before** `oracle.price = 0` (line ~48). The `pre_freeze_price` local is captured at line ~39 from `oracle.price` before any mutations to the price field.

### EMA anchor ordering
✅ **PASS** — `oracle.ema_price = pre_freeze_price` (line ~43) happens **before** `oracle.price = 0` (line ~48). Correct ordering.

### Window reference bytes
✅ **PASS** — Uses `RESERVED_OFFSET_WINDOW_REF_PRICE` (11..19) and `RESERVED_OFFSET_WINDOW_REF_SLOT` (19..27) via named constants. Writes `pre_freeze_price.to_le_bytes()` and `clock.slot.to_le_bytes()` as 8-byte slices. Correct.

### Freeze vs Unfreeze path trace
- **Freeze (`frozen=true`):** Sets `is_frozen = true`, skips `if !frozen` block, logs message. Minimal CU. ✅
- **Unfreeze (`frozen=false`):** Sets `is_frozen = false` → stores pre-freeze price in `_reserved[3..11]` → captures `pre_freeze_price` local → sets `ema_price` to pre-freeze → resets window ref to pre-freeze price + current slot → zeros `price` → sets `unfreeze_pending = 1` → logs message. ✅

**Note:** There's a subtle ordering detail — `oracle.is_frozen = frozen` is set at line ~26 **before** the `if !frozen` block. On unfreeze, `is_frozen` becomes `false` before the rest of the unfreeze logic runs. This is correct — `is_frozen` is the persisted state, and setting it first means the oracle is already marked unfrozen when the pending flag is set. The `update_perk_oracle` handler checks `!is_frozen` and `unfreeze_pending` independently, so this ordering is safe.

---

## 2. liquidate.rs

### INSURANCE_EPOCH_SECONDS import
✅ **PASS** — Used as `crate::constants::INSURANCE_EPOCH_SECONDS` (line ~70). The `crate::constants` module is not directly imported at the top of the file, but Rust's `crate::` path resolution works without a `use` statement. The constant is defined in `constants.rs` as `pub const INSURANCE_EPOCH_SECONDS: i64 = 86400`. Compiles correctly.

### Epoch reset ordering
✅ **PASS** — The insurance epoch reset block (lines ~68-72) happens **BEFORE** `risk::accrue_market_to(market, clock.slot, oracle_price)?` (line ~74). This is correct — the epoch must reset before `accrue_market_to` which may call `use_insurance_buffer`, ensuring the epoch counter is fresh.

### Clock availability
✅ **PASS** — `let clock = Clock::get()?` is at line ~55, well before the epoch reset uses `clock.unix_timestamp` at line ~69. Clock is available.

### Full liquidation flow trace
1. `Clock::get()` ✅
2. `oracle::read_oracle_price_with_fallback(...)` → gets `oracle_price` ✅
3. Insurance epoch reset (if 24h elapsed) ✅
4. `risk::accrue_market_to(market, clock.slot, oracle_price)` ✅
5. `risk::settle_side_effects(position, market)` ✅
6. `warmup::advance_warmup(...)` ✅
7. `risk::is_above_maintenance_margin(...)` → require not above MM ✅
8. `liq_engine::calculate_liquidation(...)` ✅
9. vAMM reverse trade using effective position ✅
10. Deficit computation from raw equity ✅
11. Fee capping to available collateral (H2 R3) ✅
12. `risk::enqueue_adl(...)` — uses insurance buffer here ✅
13. Insurance fee credited AFTER enqueue_adl (M3 Pashov3) ✅
14. OI tracking update, position reset, collateral accounting ✅
15. Liquidator reward transfer (capped to vault balance) ✅
16. Phantom dust clearance, activity slot, finalize resets ✅
17. Conservation invariant check ✅

No logic errors found in the flow.

---

## 3. update_oracle_config.rs

### Circuit breaker bounds
✅ **PASS** — Uses `MIN_CIRCUIT_BREAKER_BPS` (500) and `MAX_CIRCUIT_BREAKER_BPS` (9999) from constants.

### Validation pattern
✅ **PASS** — Pattern matches other fields:
- `0 = disabled` (first require allows 0)
- Otherwise `>= MIN_CIRCUIT_BREAKER_BPS` (lower bound)
- Always `<= MAX_CIRCUIT_BREAKER_BPS` (upper bound, separate require)

This is identical to the `max_price_change_bps` validation pattern. Consistent.

### Frozen check
✅ **PASS** — `require!(ctx.accounts.perk_oracle.is_frozen, PerkError::OracleNotFrozen)` is the first check, before any mutations (M-02 fix).

### Full flow trace
1. Frozen check → reject if not frozen ✅
2. Each `Option` field: validate bounds → write to oracle ✅
3. `max_price_change_bps`: 0 or [100, 9999], stored in `_reserved` via named offsets ✅
4. `min_sources`: [1, 10], stored in `oracle.min_sources` ✅
5. `max_staleness_seconds`: [5, 300], stored in `oracle.max_staleness_seconds` ✅
6. `circuit_breaker_deviation_bps`: 0 or [500, 9999], stored in `_reserved` via named offsets ✅

---

## 4. initialize_perk_oracle.rs

### Circuit breaker validation
✅ **PASS** — Same pattern as `update_oracle_config`:
```rust
require!(
    params.circuit_breaker_deviation_bps == 0
        || params.circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS,
    PerkError::InvalidAmount
);
require!(params.circuit_breaker_deviation_bps <= MAX_CIRCUIT_BREAKER_BPS, PerkError::InvalidAmount);
```

### Validation before _reserved writes
✅ **PASS** — All validation (lines ~52-68) happens **before** `oracle._reserved = [0u8; 64]` (line ~83) and subsequent writes. The validation block covers: min_sources, max_staleness, price_banding, circuit_breaker — all checked before any account mutation.

### Full flow trace
1. Validate min_sources [1, 10] ✅
2. Validate max_staleness [5, 300] ✅
3. Validate max_price_change_bps: 0 or [100, 9999] ✅
4. Validate circuit_breaker_deviation_bps: 0 or [500, 9999] ✅
5. Init account fields (bump, token_mint, authority, zeros...) ✅
6. `_reserved = [0u8; 64]` — clean slate ✅
7. Write max_price_change_bps to `_reserved[1..3]` via `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS` ✅
8. Write circuit_breaker_deviation_bps to `_reserved[27..29]` via `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS` ✅

---

## 5. Supporting Files Verification

### constants.rs
✅ **PASS** — All constants correctly defined:
- `INSURANCE_EPOCH_SECONDS: i64 = 86400` (24h)
- `MIN_CIRCUIT_BREAKER_BPS: u16 = 500` (5%)
- `MAX_CIRCUIT_BREAKER_BPS: u16 = 9999` (99.99%)
- `RESERVED_OFFSET_*` constants: non-overlapping, correctly sized:
  - `[0]`: unfreeze_pending (u8)
  - `[1..3]`: max_price_change_bps (u16 LE)
  - `[3..11]`: pre_freeze_price (u64 LE)
  - `[11..19]`: window_ref_price (u64 LE)
  - `[19..27]`: window_ref_slot (u64 LE)
  - `[27..29]`: circuit_breaker_bps (u16 LE)
  - `[29..64]`: unused (35 bytes)
- Total used: 29 bytes of 64. No overlaps. ✅

### errors.rs
✅ **PASS** — All referenced error variants exist:
- `OracleNotFrozen` ✅
- `OracleFrozen` ✅
- `InvalidAmount` ✅
- `OraclePriceInvalid` ✅
- `OracleCircuitBreakerTripped` ✅
- `OracleGapTooLarge` ✅
- Removed variants (`PositionNotFound`, `PositionAlreadyExists`, `ReduceOnlyViolation`, `MarketAlreadyExists`) are gone with ARCH-05 comments. ✅

### lib.rs
✅ **PASS** — All instruction entry points correctly wired:
- `freeze_perk_oracle` → `instructions::freeze_perk_oracle::handler(ctx, frozen)` ✅
- `liquidate` → `instructions::liquidate::handler(ctx)` ✅
- `update_oracle_config` → `instructions::update_oracle_config::handler(ctx, params)` ✅
- `initialize_perk_oracle` → `instructions::initialize_perk_oracle::handler(ctx, params)` ✅

### engine/oracle.rs
✅ **PASS** — `read_perk_oracle_price` correctly:
- Checks `!is_frozen` ✅
- Checks `price > 0` (catches post-unfreeze zeroed price) ✅
- Checks staleness against `max_staleness_seconds` ✅
- Checks confidence band ✅

### engine/risk.rs (use_insurance_buffer)
✅ **PASS** — `use_insurance_buffer` uses `INSURANCE_EPOCH_CAP_BPS` for epoch cap calculation. The epoch tracking (`insurance_epoch_start`, `insurance_epoch_payout`) is correctly used. The epoch reset in `liquidate.rs` properly zeros `insurance_epoch_payout` and updates `insurance_epoch_start`.

---

## 6. Grep Verification

| Check | Result |
|-------|--------|
| No hardcoded `_reserved` byte indices in instructions | ✅ PASS — Only one comment reference `_reserved[3..11]` in freeze_perk_oracle.rs. All code accesses use `RESERVED_OFFSET_*` constants. |
| No hardcoded `_reserved` byte indices in engine | ✅ PASS — No `_reserved` access in engine files. |
| No references to removed error variants | ✅ PASS — `PositionNotFound`, `PositionAlreadyExists`, `ReduceOnlyViolation`, `MarketAlreadyExists` not referenced anywhere in instructions or engine. |
| `MIN_CIRCUIT_BREAKER_BPS` used consistently | ✅ PASS — Defined once in constants.rs (500), used in initialize_perk_oracle.rs and update_oracle_config.rs with identical validation pattern. |
| `MAX_CIRCUIT_BREAKER_BPS` used consistently | ✅ PASS — Defined once in constants.rs (9999), used in initialize_perk_oracle.rs and update_oracle_config.rs with identical validation pattern. |

---

## Summary

All Round 1–2 fixes are correctly implemented. No logic errors, no stale references, no hardcoded magic numbers. The code is ready for final review / deploy.

| Area | Status |
|------|--------|
| freeze_perk_oracle.rs | ✅ All 4 checks pass |
| liquidate.rs | ✅ All 3 checks pass |
| update_oracle_config.rs | ✅ All 3 checks pass |
| initialize_perk_oracle.rs | ✅ All 2 checks pass |
| Full instruction flow traces | ✅ All 4 flows verified |
| Grep verification | ✅ All 5 checks pass |
