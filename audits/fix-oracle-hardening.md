# Oracle Security Hardening — Fix Summary

**Date:** 2026-03-25
**Findings addressed:** ARCH-04, ATK-01, ATK-02, ATK-08, INV-02

## Changes

### 1. `_reserved` Offset Constants (ARCH-04) — `constants.rs`

Added centralized named constants for the `_reserved[64]` field layout in `PerkOraclePrice`:

| Constant | Offset | Type | Purpose |
|---|---|---|---|
| `RESERVED_OFFSET_UNFREEZE_PENDING` | 0 | u8 | Unfreeze bypass flag |
| `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS` | 1 | u16 LE | Per-update price band |
| `RESERVED_OFFSET_PRE_FREEZE_PRICE` | 3 | u64 LE | Pre-freeze price for post-unfreeze banding |
| `RESERVED_OFFSET_WINDOW_REF_PRICE` | 11 | u64 LE | Sliding window reference price |
| `RESERVED_OFFSET_WINDOW_REF_SLOT` | 19 | u64 LE | Sliding window reference slot |
| `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS` | 27 | u16 LE | EMA circuit breaker threshold |

Also added `CIRCUIT_BREAKER_WINDOW_SLOTS` (50 slots, ~20s) and `WINDOW_BAND_MULTIPLIER` (3x).

All hardcoded `_reserved` byte indices across 4 instruction files were replaced with these constants.

### 2. Circuit Breaker — EMA Deviation Check (ATK-01/ATK-08) — `update_perk_oracle.rs`

- Captures `old_ema = oracle.ema_price` **before** the EMA update computation.
- After EMA update, checks `|price - old_ema| / old_ema` against `circuit_breaker_deviation_bps`.
- If deviation exceeds threshold → `PerkError::OracleCircuitBreakerTripped`.
- Disabled when `cb_bps == 0` or `old_ema == 0` (first update).

### 3. Sliding Window Banding (ATK-02) — `update_perk_oracle.rs`

- When `max_price_change_bps > 0`, tracks cumulative price movement over a sliding window (`CIRCUIT_BREAKER_WINDOW_SLOTS` = 50 slots).
- Window reference price/slot stored in `_reserved[11..27]`.
- Within window: cumulative deviation capped at `max_change_bps * WINDOW_BAND_MULTIPLIER` (3x the per-update band).
- Window expired: resets reference to current price/slot.
- First update: initializes window reference.

### 4. New Error Variant — `errors.rs`

Added `OracleCircuitBreakerTripped` for the EMA circuit breaker check.

### 5. Expanded `update_oracle_config` (INV-02) — `update_oracle_config.rs`

`UpdateOracleConfigParams` now uses `Option<T>` fields and supports:
- `max_price_change_bps: Option<u16>` — per-update price band
- `min_sources: Option<u8>` — minimum source count
- `max_staleness_seconds: Option<u32>` — staleness threshold
- `circuit_breaker_deviation_bps: Option<u16>` — EMA circuit breaker

Each field is validated with the same bounds as `initialize_perk_oracle` and only applied when `Some`. **Breaking change** to Borsh instruction data layout (acceptable pre-mainnet).

### 6. Initialize Circuit Breaker — `initialize_perk_oracle.rs`

`InitPerkOracleParams` now includes `circuit_breaker_deviation_bps: u16` (0 = disabled). Stored in `_reserved[27..29]` at initialization. **Breaking change** to Borsh instruction data layout (acceptable pre-mainnet).

## Files Modified

| File | Changes |
|---|---|
| `constants.rs` | +10 constants (offsets, window config) |
| `errors.rs` | +1 error variant (`OracleCircuitBreakerTripped`) |
| `instructions/initialize_perk_oracle.rs` | New param field, offset constants for _reserved writes |
| `instructions/update_perk_oracle.rs` | Offset constants, old_ema capture, circuit breaker, sliding window |
| `instructions/freeze_perk_oracle.rs` | Offset constants for _reserved accesses, added `use crate::constants::*` |
| `instructions/update_oracle_config.rs` | Option params, new fields, offset constants, wildcard import |
