# General Protocol Review — Round 3

**Date:** 2025-03-25  
**Reviewer:** Senior Protocol Review (General)  
**Scope:** All `.rs` source files in `perk-protocol/programs/perk-protocol/src/`  
**Context:** Post multiple rounds of security fixes (ATK-XX, INV-XX, ARCH-XX, Pashov, Apex, R2–R4)

---

## Code Quality & Consistency

### Fix Tag Formatting
Fix tags are **generally consistent** across the codebase: `H1`, `H2`, `C1`, `M1`, `ATK-01`, `ARCH-05`, etc. with round qualifiers like `(R3)`, `(R4)`, `(Pashov2)`, `(Pashov3)`, `(Apex R2)`.

**Minor inconsistencies:**
- Some tags use parenthetical auditor: `H1 (Pashov3)`, while others use colon: `H5 fix:`. Not a bug, but a style inconsistency.
- `C1 (R3)` vs `C1 fix:` — the fix vs the tag reference style varies. A uniform pattern like `[FIX C1-R3]` would be cleaner.

### Stale Comments
1. **`create_market.rs` line comment**: "Parameters (immutable after creation; trading_fee_bps and max_leverage are admin-updatable via admin_update_market)" — the parenthetical note is accurate after the M4 and H4 Pashov2 fixes. ✅
2. **`constants.rs`**: `INSURANCE_EPOCH_CAP_BPS: u16 = 3000` has comment "30% — reduced from 50% for better survivability under sustained attack". Accurate. ✅
3. **`market.rs`**: `haircut_numerator` and `haircut_denominator` fields are still present on Market but are **never written to or read from** in any instruction or engine code. The actual haircut computation uses `haircut_ratio()` which computes from `pnl_matured_pos_tot` and `vault_balance`. **These are dead fields.**

### Dead Code
| Item | Location | Status |
|------|----------|--------|
| `Market.haircut_numerator` / `haircut_denominator` | `state/market.rs` | **Dead fields** — initialized to 1 in `create_market`, never read or updated. Should be removed or documented as deprecated. |
| `Market.cumulative_long_funding` / `cumulative_short_funding` | `state/market.rs` | **Dead fields** — initialized to 0, never updated. Funding is now purely K-coefficient-based. These were from the pre-Percolator legacy funding model. |
| `split_fee()` in `vamm.rs` | `engine/vamm.rs` | Used in `open_position` and `execute_trigger_order` (non-reduce-only path). `compute_fee_split()` is used in close paths. Both exist — the duplication is intentional (different callsite needs), but having two fee-split functions (`split_fee` and `compute_fee_split`) with slightly different semantics is confusing. `split_fee` returns `Result`, `compute_fee_split` returns tuple with panic-free unwrap_or. |
| `I128` / `U128` types in `i128_types.rs` | `engine/i128_types.rs` | **Potentially dead** — these BPF-safe wrapper types are defined and exported but never used in any instruction or engine code. The codebase uses raw `i128`/`u128` everywhere. If targeting SBF (Solana BPF), the alignment issue these solve is real, but the types need to actually be used in account structs or removed. |
| `margin::margin_ratio_bps()` | `engine/margin.rs` | Called nowhere in the codebase. Only `is_above_initial_margin` and `is_above_maintenance_margin` are used. |
| `margin::compute_unrealized_pnl()` | `engine/margin.rs` | Called nowhere. PnL is computed via K-diff in `settle_side_effects`. |
| `margin::initial_margin_required()` | `engine/margin.rs` | Called nowhere. IM checks go through `risk::is_above_initial_margin()` which computes internally. |
| `margin::maintenance_margin_required()` | `engine/margin.rs` | Called nowhere. MM checks go through `risk::is_above_maintenance_margin()`. |
| `margin::enforce_post_trade_margin()` | `engine/margin.rs` | Called nowhere. Post-trade checks use `risk::is_above_initial_margin()` directly. |
| `margin::validate_position_bounds()` | `engine/margin.rs` | Called nowhere. Position bounds are checked via `market.max_position_size`. |

**Verdict:** The entire `margin.rs` module is essentially dead code. All margin checks have been migrated to `risk.rs` functions. The module should be removed or clearly marked as deprecated. This is a significant code hygiene issue.

### TODO/FIXME
No `TODO` or `FIXME` comments found in the codebase. ✅

---

## Design Coherence

### PerkOracle Integration
The PerkOracle system integrates cleanly with the rest of the protocol:
- `read_oracle_price()` dispatches by `OracleSource` enum — `PerkOracle` is a first-class source.
- `validate_perk_oracle_mint()` prevents cross-token oracle attacks at market creation and fallback setup.
- `read_oracle_price_with_fallback()` tries primary → fallback with proper address validation.
- Circuit breaker + sliding window + per-update banding provide defense-in-depth.

**One concern:** The `_reserved` field is used as a poor man's struct for storing `max_price_change_bps`, `pre_freeze_price`, `window_ref_price`, `window_ref_slot`, `circuit_breaker_bps`, and `unfreeze_pending`. This works but is fragile:
- Offsets are defined as constants in `constants.rs` (good).
- But any mistake in offset math or field width causes silent data corruption.
- **Recommendation:** On next account migration, promote these to proper struct fields.

### Risk Engine Faithfulness
The Percolator port is thorough. Key spec sections are referenced in comments:
- `accrue_market_to` (§5.4) ✅
- `settle_side_effects` (§5.3) ✅
- `enqueue_adl` (§5.6) ✅
- `touch_account_full` (§10.1) ✅
- Haircut (§3.3), equity formulas (§3.4) ✅
- Conservation (§3.1) ✅
- Three-phase recovery (DrainOnly → ResetPending → Normal) ✅

**L1 (R4) iteration cap** in `accrue_market_to` caps funding sub-steps at 50 iterations, which is pragmatic for CU. The partial catch-up mechanism (recording remaining_dt) is sound — it spreads catch-up across multiple calls.

### Instruction Consistency — `finalize_pending_resets`
All instructions that modify market state call `finalize_pending_resets(market)`:
| Instruction | Calls finalize_pending_resets? |
|-------------|-------------------------------|
| deposit | ✅ |
| withdraw | ✅ |
| open_position | ✅ |
| close_position | ✅ |
| liquidate | ✅ |
| crank_funding | ✅ |
| update_amm | ✅ |
| execute_trigger_order | ✅ |
| reclaim_empty_account | ✅ |
| claim_fees | ❌ — but doesn't modify risk state, only transfers tokens |
| admin_update_market | ❌ — only modifies config fields |
| admin_pause | ❌ — only modifies paused flag |

**Verdict:** All instructions that touch the risk engine call `finalize_pending_resets`. Admin/config instructions correctly skip it. ✅

### Conservation Check Consistency
All instructions that move tokens in/out of the vault run `check_conservation()`:
| Instruction | Has conservation check? |
|-------------|------------------------|
| deposit | ✅ |
| withdraw | ✅ |
| open_position | ❌ (no token movement, only internal fee accounting) |
| close_position | ✅ |
| liquidate | ✅ |
| execute_trigger_order | ✅ |
| claim_fees | ✅ |
| reclaim_empty_account | ❌ (no vault token transfer — account closed, dust swept internally) |

**Finding [GEN-01] — open_position missing conservation check:** `open_position` deducts fees from `deposited_collateral` and `c_tot` but never calls `check_conservation()`. While no vault tokens move (fees stay in vault), the internal accounting change (c_tot decrease, claimable_fees increase) should maintain conservation. The conservation formula `V >= C_tot + I + claimable` is reduced on both sides equally when fees are deducted from c_tot and added to claimable... actually, let me trace this:

- `c_tot -= fee` and `claimable += fee` → net change to `c_tot + claimable` = 0. Conservation is preserved by construction. ✅ But adding the explicit check costs nothing and provides defense-in-depth. Worth adding.

**Status:** Acknowledged — Conservation preserved by construction (c_tot and claimable offset); no token movement occurs in open_position.

### Instruction-Oracle-Active Consistency
All instructions that read oracle price and make financial decisions check `market.active`:
| Instruction | Checks market.active? | Reads oracle? |
|-------------|----------------------|---------------|
| deposit | ✅ | ✅ |
| withdraw | ❌ | ✅ |
| open_position | ✅ | ✅ |
| close_position | ❌ | ✅ |
| liquidate | ❌ | ✅ |
| crank_funding | ✅ | ✅ |
| update_amm | ✅ | ✅ |
| execute_trigger_order | ✅ | ✅ |
| reclaim_empty_account | ❌ | ✅ |

**Finding [GEN-02] — withdraw, close_position, liquidate, reclaim_empty_account don't check market.active:**
**Status:** Acknowledged — Intentional design; users must always be able to exit positions and recover funds from inactive markets.
This is **intentional and correct**. Users must always be able to:
- Withdraw collateral from inactive markets
- Close positions in inactive markets
- Be liquidated in inactive markets (prevents bad debt accumulation)
- Reclaim empty accounts in inactive markets

`active` flag blocks new capital deployment (deposit, open, trigger execution for opens), not capital recovery. ✅

---

## Security Gaps

### 1. Saturating Math Hiding Failures

**[GEN-03] — `total_long_position` / `total_short_position` use `saturating_sub`:**
**Status:** Acknowledged — Informational counters not used in risk math; saturating_sub is the safe default.
In `close_position.rs`, `liquidate.rs`, and `execute_trigger_order.rs`, position counter decrements use `saturating_sub`:
```rust
market.total_long_position = market.total_long_position.saturating_sub(close_size as u128);
```
If the tracking counters are ever off (e.g., due to epoch-mismatch zeroing in `settle_side_effects`), this silently goes to 0 instead of erroring. These counters are informational (not used in risk math — `oi_eff_long_q`/`oi_eff_short_q` are), so `saturating_sub` is acceptable. **Low risk, informational.**

**[GEN-04] — `total_positions` uses `saturating_sub` in close and liquidate:**
**Status:** Acknowledged — Same as GEN-03; informational counter, saturating_sub is acceptable.
Same analysis — informational counter, not used in risk math. **Low risk.**

**[GEN-05] — Insurance epoch payout tracking uses `saturating_add`:**
**Status:** Acknowledged — Saturation extremely unlikely (requires >u64::MAX single payout); negligible risk.
```rust
market.insurance_epoch_payout = market.insurance_epoch_payout
    .saturating_add(core::cmp::min(pay, u64::MAX as u128) as u64);
```
If this saturates, the epoch cap becomes ineffective for the remainder of the epoch (further payouts would appear to have no headroom). The `core::cmp::min(pay, u64::MAX)` cast makes saturation extremely unlikely (would need >u64::MAX single payout). **Negligible risk.**

### 2. Access Control Audit

| Instruction | Access Control | Correct? |
|-------------|---------------|----------|
| initialize_protocol | Admin signs + init | ✅ |
| create_market | Anyone (permissionless) | ✅ (creation fee gates spam) |
| initialize_position | Anyone | ✅ |
| deposit | Position authority | ✅ |
| withdraw | Position authority + has_one | ✅ |
| open_position | Position authority + has_one | ✅ |
| close_position | Position authority + has_one | ✅ |
| place_trigger_order | Position authority + has_one | ✅ |
| cancel_trigger_order | Position authority + has_one | ✅ |
| execute_trigger_order | Anyone (permissionless cranker) | ✅ |
| liquidate | Anyone (permissionless) | ✅ |
| crank_funding | Anyone (permissionless) | ✅ |
| update_amm | Anyone (permissionless) | ✅ |
| claim_fees | Creator or admin (checked in handler) | ✅ |
| reclaim_empty_account | Anyone (permissionless) + rent goes to position owner | ✅ |
| admin_pause | has_one = admin | ✅ |
| admin_update_market | Protocol admin constraint | ✅ |
| propose_admin | Protocol admin constraint | ✅ |
| accept_admin | Pending admin signs | ✅ |
| admin_withdraw_sol | Protocol admin constraint | ✅ |
| initialize_perk_oracle | has_one = admin | ✅ |
| update_perk_oracle | has_one = authority | ✅ |
| freeze_perk_oracle | has_one = admin | ✅ |
| transfer_oracle_authority | Authority or admin | ✅ |
| update_oracle_config | has_one = admin + frozen required | ✅ |
| admin_set_fallback_oracle | has_one = admin | ✅ |

**No access control gaps found.** ✅

### 3. Token Transfer Failure Analysis
All token transfers use Anchor CPI (`token::transfer`), which propagates errors via `Result`. No silent failures possible — CPI failure = transaction revert. ✅

### 4. Specific Security Concerns

**[GEN-06] — `withdraw.rs` has a double-signer pattern:**
**Status:** Acknowledged — Functionally correct; redundant signer is a minor UX friction, not a security issue.
```rust
pub authority: Signer<'info>,
pub user: Signer<'info>,
```
With constraints `user.key() == user_position.authority` and `has_one = authority`. This requires **two signatures** that must both equal `user_position.authority`. In practice, the caller passes the same account for both. This is functionally correct but the `authority` signer is redundant — `user` already proves identity. Not a security issue, just unnecessary UX friction (client must pass the same key twice).

**[GEN-07] — `close_position` applies swap AFTER fee deduction but marks for slippage BEFORE:**
**Status:** Acknowledged — Close operations have no slippage parameter by design; user is exiting an existing position.
In `close_position`, the vAMM swap is simulated, then fees are charged from collateral, then `apply_swap` is called. There's no slippage check in close_position (unlike open_position which checks `max_slippage_bps`). This is acceptable — close operations have no slippage parameter, and the user is exiting an existing position.

**[GEN-08] — `liquidate.rs` — OI update gap after enqueue_adl:**
**Status:** Acknowledged — Correct by design; enqueue_adl is the authoritative OI manager during liquidation.
After `enqueue_adl` decrements `oi_eff_{side}_q` for the liquidated side, the instruction then calls `attach_effective_position(position, market, 0)` which doesn't touch OI. The OI decrement happens inside `enqueue_adl` (step 1), and the opposing side's OI is handled by A/K adjustment (also inside enqueue_adl). The `update_oi_delta` helper is NOT called in liquidate because `enqueue_adl` handles OI directly. **This is correct** — enqueue_adl is the authoritative OI manager during liquidation.

**[GEN-09] — Potential double-decrement of stored_pos_count:**
**Status:** Acknowledged — Separate counters (stored_pos_count vs stale_account_count); verified no double-decrement.
In `settle_side_effects` epoch-mismatch branch, `stale_account_count` is decremented. In `set_position_basis_q`, `stored_pos_count` is decremented when clearing basis. These are separate counters. In the epoch-mismatch path, the flow is:
1. `set_position_basis_q(position, market, 0)` → decrements `stored_pos_count_{side}`
2. `set_stale_count(market, side, new_stale)` → decrements `stale_account_count_{side}`

And in `begin_full_drain_reset`, `set_stale_count(market, side, spc)` sets stale count to `stored_pos_count`. So after the full sequence, stale_count tracks how many accounts still need to settle through the epoch mismatch. This is correct. ✅

**[GEN-10] — Window reference not updated on successful within-window update:**
**Status:** Acknowledged — Correct behavior; window measures cumulative drift from start, per-update drift covered by banding.
In `update_perk_oracle.rs`, when the sliding window check passes (price is within bounds), the `window_ref_price` and `window_ref_slot` are **not** updated. The window reference stays at the start-of-window price. This means the window bounds are measured from the window start, not from the previous update. This is the correct behavior — it measures cumulative drift over the window period, not per-update drift (which is already covered by `max_price_change_bps`). ✅

---

## CU Analysis

### Circuit Breaker + Sliding Window in `update_perk_oracle`
The added logic:
1. EMA update: 3 arithmetic ops (saturating)
2. Circuit breaker: 1 subtraction + 1 multiplication + 1 division + 1 comparison
3. Sliding window: 2 byte reads (8 bytes each) + 1 subtraction + 1 comparison + potentially 1 multiplication + 1 division

**Total additional cost: ~15-20 BPF instructions.** With a base CU budget of 200,000, this is negligible (<0.01%). **No concern.**

### Insurance Epoch Check in `liquidate`
The added branch:
```rust
let epoch_elapsed = clock.unix_timestamp.saturating_sub(market.insurance_epoch_start);
if epoch_elapsed >= INSURANCE_EPOCH_SECONDS { ... }
```
**Cost: 2 arithmetic ops + 1 branch + potentially 2 writes.** Negligible. Liquidation's CU cost is dominated by `accrue_market_to` (funding loop), `settle_side_effects` (K-diff settlement), and vAMM simulation (constant-product math). **No concern.**

### Unbounded Loops
1. **`accrue_market_to` funding loop**: Capped at `MAX_FUNDING_ITERATIONS = 50` (L1 R4 fix). Each iteration is ~20 BPF ops. Maximum: ~1000 ops. **Bounded.** ✅
2. **`integer_sqrt` (Newton's method)**: Converges in O(log n) iterations for 128-bit input. Maximum ~64 iterations for u128::MAX. **Bounded.** ✅
3. **`div_rem_u256`**: Loop iterations bounded by `shift` which is ≤256 (bit width). **Bounded.** ✅

**No unbounded loops or recursive calls found.** ✅

### CU-Heavy Instructions
The most expensive instruction is likely `liquidate` or `execute_trigger_order` (reduce-only path with full close), which chain:
`accrue_market_to` → `settle_side_effects` → `advance_warmup` → vAMM sim → `enqueue_adl` → `check_and_clear_phantom_dust` → `finalize_pending_resets`

Each of these is O(1) (no loops except the bounded funding loop). Worst-case CU should be well under 200,000. **No concern for default CU limits.**

---

## Client Impact

### Error Discriminant Shift
`ARCH-05` removed 3 error variants from `PerkError`:
- `PositionNotFound` (was between `NotLiquidatable` predecessor)
- `PositionAlreadyExists`
- `ReduceOnlyViolation`

These removals shift the discriminants of all subsequent variants. Clients parsing error codes by numeric value will break. **This requires IDL regeneration and client SDK update.**

**Finding [GEN-11]:** No migration notes file found in the repo documenting this breaking change. Recommend creating `MIGRATION.md` or adding to release notes.

**Status:** Acknowledged — Breaking changes documented in SDK release notes and IDL changelog; clients regenerate IDL on upgrade.

### Params Struct Changes
1. **`AdminUpdateMarketParams`** — added `max_leverage: Option<u32>` (H4 Pashov2). Backward-compatible (Option field, existing clients can pass None).
2. **`InitPerkOracleParams`** — added `circuit_breaker_deviation_bps: u16` (ATK-05 R2). **Breaking** — all clients creating PerkOracles must now supply this field.
3. **`UpdateOracleConfigParams`** — added `circuit_breaker_deviation_bps: Option<u16>`. Backward-compatible (Option).
4. **`CreateMarketParams`** — unchanged. ✅
5. **`TriggerOrderParams`** — unchanged. ✅
6. **`SetFallbackOracleParams`** — unchanged. ✅

### Breaking Changes Summary
| Change | Breaking? | Migration |
|--------|-----------|-----------|
| Error variant removal (ARCH-05) | **Yes** | Regenerate IDL, update error parsing in all clients |
| `InitPerkOracleParams` new field | **Yes** | Update oracle creation calls |
| `AdminUpdateMarketParams.max_leverage` | No (Option) | No action |
| `UpdateOracleConfigParams.circuit_breaker_deviation_bps` | No (Option) | No action |
| `M3 fix: market_creation_fee` on Protocol | No (new field, backward compat with realloc) | No action for existing markets |
| `M5 fix: pending_admin` on Protocol | No (new field) | No action |
| Fallback oracle accounts on all oracle-reading instructions | **Yes** | All transaction builders must include fallback_oracle account |

**Finding [GEN-12]:** The fallback oracle pattern requires **every instruction that reads price** to pass `fallback_oracle` as an account.
**Status:** Resolved — All SDK instruction methods and cranker loops now pass `fallbackOracle` (SystemProgram.programId as sentinel when unconfigured). This is a significant client-side change affecting: deposit, withdraw, open_position, close_position, liquidate, execute_trigger_order, reclaim_empty_account, crank_funding, update_amm. Clients must be updated to pass a valid account (or any account when no fallback is configured).

---

## Recommended Tests

### Circuit Breaker Tests
1. **First update with circuit breaker enabled** — EMA=0, should not trip (old_ema check guards this)
2. **Normal update within CB bounds** — price within `cb_bps` of EMA, should pass
3. **Update exceeding CB bounds** — price deviates > `cb_bps` from EMA, should revert with `OracleCircuitBreakerTripped`
4. **CB disabled (cb_bps=0)** — large price deviation should pass
5. **EMA recovery after gradual price move** — 10 updates each at the banding limit, verify EMA tracks and CB doesn't false-trigger
6. **Post-unfreeze CB behavior** — verify EMA is preserved as pre-freeze price, first update is bounded by CB

### Sliding Window Tests
7. **First update initializes window** — verify ref_price and ref_slot are set
8. **Within-window updates within band** — cumulative change < `3 * max_price_change_bps`, should pass
9. **Within-window update exceeding cumulative band** — should revert with `OraclePriceInvalid`
10. **Window expiry** — update after `CIRCUIT_BREAKER_WINDOW_SLOTS`, should start new window
11. **Window + per-update banding interaction** — update that passes per-update band but fails cumulative, and vice versa
12. **Post-unfreeze window reset** — verify window is anchored to pre-freeze price

### Edge Cases
13. **First oracle update ever** — price=0 → first valid price. Verify EMA initialization, window initialization, no banding check (no reference)
14. **Post-unfreeze first update** — verify gap check bypass (unfreeze_pending=1), banding against pre-freeze price, then second update is normal
15. **Epoch boundary in insurance** — payout at cap, then epoch rolls over, new payouts allowed
16. **Liquidation when insurance epoch is exhausted** — deficit goes through enqueue_adl (implicit haircut)
17. **accrue_market_to with >50 iterations of debt** — verify partial catch-up with `last_market_slot` tracking
18. **Conservation check after every instruction** — fuzz test depositing, opening, closing, liquidating, claiming in rapid sequence, verify `V >= C_tot + I + claimable` always holds
19. **Phantom dust clearance bilateral** — both sides go to zero OI simultaneously via dust
20. **settle_side_effects with epoch mismatch** — verify base_size is zeroed, stale count decremented, position re-initialized
21. **Partial close leaving exactly MIN_REMAINING_POSITION_SIZE** — boundary test
22. **Fee exceeds collateral on close** — verify fee_credits debt path and insurance routing
23. **reclaim_empty_account with unsettled PnL** — verify settle/convert/resolve runs before emptiness check
24. **Trigger order at max age boundary** — order at exactly `MAX_TRIGGER_ORDER_AGE_SECONDS` should pass, +1 should fail

---

## Overall Assessment

**The protocol is in strong shape after multiple audit rounds.** The Percolator risk engine port is faithful and thorough. The defense-in-depth approach (circuit breaker + sliding window + per-update banding + gap detection + freeze/unfreeze cycle) on the oracle is well-designed. Conservation invariants are checked at all the right places. Access control is correct throughout.

### Key Strengths
- **K-coefficient PnL model** is clean and avoids the common vAMM-derived-PnL pitfalls
- **Deferred reset pattern** (H4 fix) correctly handles the enqueue_adl → begin_full_drain_reset ordering issue
- **Fee routing** is thorough — partial payment, fee_credits debt, insurance routing for shortfall
- **Oracle fallback** system is properly address-validated against market state (prevents injection attacks)
- **Conservation check** at end of token-moving instructions provides a strong safety net

### Items Requiring Attention

| ID | Severity | Description |
|----|----------|-------------|
| GEN-01 | Info | `open_position` lacks explicit conservation check (conserved by construction, but defense-in-depth suggests adding it) |
| GEN-11 | **Medium** | Error discriminant shifts (ARCH-05) not documented — clients will parse wrong errors |
| GEN-12 | **Medium** | Fallback oracle account requirement is a major client-side breaking change — needs migration guide |
| Dead code | **Low** | Entire `margin.rs` module is unused; `I128`/`U128` types unused; `haircut_numerator/denominator` and `cumulative_*_funding` dead fields on Market |
| | | **Status:** Acknowledged — Cleanup deferred to post-launch hygiene PR; dead code has zero runtime impact. |
| `_reserved` fragility | **Low** | PerkOracle stores critical security state (window, CB, pre-freeze price) in raw byte offsets — works but fragile for future development |
| | | **Status:** Resolved — Named offset constants (`RESERVED_OFFSET_*`) added in `constants.rs`; proper struct fields planned for next account migration. |

### Verdict
**Ready for deployment** with the caveat that client migration documentation must be completed before launch. The dead code should be cleaned up in a follow-up PR (not blocking — purely hygiene). The `_reserved` field usage should be refactored to proper struct fields when the next account migration is planned.

No critical or high-severity security issues found. The protocol's risk model, access control, and economic security are sound.
