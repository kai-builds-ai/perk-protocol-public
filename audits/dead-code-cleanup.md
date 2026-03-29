# Dead Code Cleanup Summary
Date: 2026-03-25

## Files Deleted

### 1. `engine/margin.rs`
**Reason:** All margin check functions migrated to `risk.rs` (functions like `is_above_maintenance_margin`, `is_above_initial_margin`). The file was an orphan — not declared in `engine/mod.rs` and had zero imports across the codebase.

### 2. `state/i128_types.rs`
**Reason:** Defined BPF-safe `I128`/`U128` wrapper types that were never imported or used outside the file. Was not declared in `state/mod.rs`.

## Dead Fields Annotated (NOT removed — Borsh layout preserved)

In `state/market.rs`:
- `haircut_numerator: u128` — initialized to 1 in `create_market`, never read. `haircut_ratio()` in `risk.rs` computes dynamically from vault/c_tot.
- `haircut_denominator: u128` — same as above.
- `cumulative_long_funding: i128` — initialized to 0, never read. Funding is now applied through K-coefficients in `accrue_market_to`.
- `cumulative_short_funding: i128` — same as above.

**Note:** Fields are kept in the struct with `// DEAD FIELD` comments to preserve Borsh serialization layout. They can be repurposed for future features without a migration.

## Verification
- `cargo check`: ✅ Clean compile
- Grep verification: Zero references to deleted modules across entire codebase
