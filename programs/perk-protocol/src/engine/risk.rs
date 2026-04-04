/// Risk Engine — Full-Fidelity Port from Percolator v11.26
///
/// Implements the complete Percolator risk engine adapted to Anchor's
/// per-account PDA model. All math is kept faithful to the reference.
///
/// Core functions:
/// - haircut_ratio: exit fairness when vault is stressed (spec §3.3)
/// - set_pnl / set_reserved_pnl: atomic PnL aggregate tracking (spec §4.4 / §4.3)
/// - accrue_market_to: mark-to-market using oracle price, K-coefficients (spec §5.4)
/// - settle_side_effects: per-account K-diff settlement (spec §5.3)
/// - effective_position_q: position adjusted by A/K (spec §5.2)
/// - enqueue_adl: deficit socialization (spec §5.6)
/// - three-phase recovery: DrainOnly → ResetPending → Normal (spec §2.5-2.7)
/// - deposit_fee_credits / charge_fee_to_insurance (spec §8.1)
/// - reclaim_empty_account: permissionless cleanup (spec §10.8)

use crate::constants::*;
use crate::errors::PerkError;
use crate::state::{Market, SideState, UserPosition};
use crate::engine::wide_math::{
    U256, I256,
    mul_div_floor_u128, mul_div_ceil_u128,
    wide_mul_div_floor_u128,
    wide_signed_mul_div_floor_from_k_pair,
    wide_mul_div_ceil_u128_or_over_i128max, OverI128Magnitude,
    saturating_mul_u128_u64,
    fee_debt_u128_checked,
    mul_div_floor_u256_with_rem,
    ceil_div_positive_checked,
    checked_u128_mul_i128,
};
use anchor_lang::prelude::*;

// ============================================================================
// Small helpers
// ============================================================================

/// Clamp i128 to max(v, 0) as u128
#[inline]
pub fn i128_clamp_pos(v: i128) -> u128 {
    if v > 0 { v as u128 } else { 0u128 }
}

/// Side enum for internal use
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Long,
    Short,
}

pub fn side_of_i128(v: i128) -> Option<Side> {
    if v == 0 { None }
    else if v > 0 { Some(Side::Long) }
    else { Some(Side::Short) }
}

pub fn opposite_side(s: Side) -> Side {
    match s {
        Side::Long => Side::Short,
        Side::Short => Side::Long,
    }
}

// ============================================================================
// Side state accessors on Market
// ============================================================================

pub fn get_a_side(market: &Market, s: Side) -> u128 {
    match s { Side::Long => market.long_a, Side::Short => market.short_a }
}

pub fn get_k_side(market: &Market, s: Side) -> i128 {
    match s { Side::Long => market.long_k_index, Side::Short => market.short_k_index }
}

pub fn get_epoch_side(market: &Market, s: Side) -> u64 {
    match s { Side::Long => market.long_epoch, Side::Short => market.short_epoch }
}

pub fn get_k_epoch_start(market: &Market, s: Side) -> i128 {
    match s { Side::Long => market.long_epoch_start_k, Side::Short => market.short_epoch_start_k }
}

pub fn get_side_mode(market: &Market, s: Side) -> SideState {
    match s { Side::Long => market.long_state, Side::Short => market.short_state }
}

pub fn get_oi_eff(market: &Market, s: Side) -> u128 {
    match s { Side::Long => market.oi_eff_long_q, Side::Short => market.oi_eff_short_q }
}

pub fn set_oi_eff(market: &mut Market, s: Side, v: u128) {
    match s { Side::Long => market.oi_eff_long_q = v, Side::Short => market.oi_eff_short_q = v }
}

pub fn set_side_mode(market: &mut Market, s: Side, m: SideState) {
    match s { Side::Long => market.long_state = m, Side::Short => market.short_state = m }
}

pub fn set_a_side(market: &mut Market, s: Side, v: u128) {
    match s { Side::Long => market.long_a = v, Side::Short => market.short_a = v }
}

pub fn set_k_side(market: &mut Market, s: Side, v: i128) {
    match s { Side::Long => market.long_k_index = v, Side::Short => market.short_k_index = v }
}

pub fn get_stale_count(market: &Market, s: Side) -> u64 {
    match s { Side::Long => market.stale_account_count_long, Side::Short => market.stale_account_count_short }
}

pub fn set_stale_count(market: &mut Market, s: Side, v: u64) {
    match s { Side::Long => market.stale_account_count_long = v, Side::Short => market.stale_account_count_short = v }
}

pub fn get_stored_pos_count(market: &Market, s: Side) -> u64 {
    match s { Side::Long => market.stored_pos_count_long, Side::Short => market.stored_pos_count_short }
}

pub fn inc_phantom_dust_bound(market: &mut Market, s: Side) {
    match s {
        Side::Long => market.phantom_dust_bound_long_q = market.phantom_dust_bound_long_q.saturating_add(1),
        Side::Short => market.phantom_dust_bound_short_q = market.phantom_dust_bound_short_q.saturating_add(1),
    }
}

pub fn inc_phantom_dust_bound_by(market: &mut Market, s: Side, amount_q: u128) {
    match s {
        Side::Long => market.phantom_dust_bound_long_q = market.phantom_dust_bound_long_q.saturating_add(amount_q),
        Side::Short => market.phantom_dust_bound_short_q = market.phantom_dust_bound_short_q.saturating_add(amount_q),
    }
}

// ============================================================================
// O(1) Aggregate Helpers (spec §4)
// ============================================================================

/// set_pnl (spec §4.4): Update PNL and maintain pnl_pos_tot + pnl_matured_pos_tot
/// with proper reserve handling. Forbids i128::MIN.
pub fn set_pnl(position: &mut UserPosition, market: &mut Market, new_pnl: i128) {
    assert!(new_pnl != i128::MIN, "set_pnl: i128::MIN forbidden");

    let old = position.pnl;
    let old_pos = i128_clamp_pos(old);
    let old_r = position.reserved_pnl;
    debug_assert!(old_r <= old_pos, "set_pnl: R > PNL_pos invariant violated");
    let old_rel = old_pos - old_r;
    let new_pos = i128_clamp_pos(new_pnl);

    // Per-account positive-PnL bound (spec §4.4 step 6)
    assert!(new_pos <= MAX_ACCOUNT_POSITIVE_PNL, "set_pnl: exceeds MAX_ACCOUNT_POSITIVE_PNL");

    // Compute new_R (spec §4.4 steps 7-8)
    let new_r = if new_pos > old_pos {
        let reserve_add = new_pos - old_pos;
        let nr = old_r.checked_add(reserve_add).expect("set_pnl: new_R overflow");
        assert!(nr <= new_pos, "set_pnl: new_R > new_pos");
        nr
    } else {
        let pos_loss = old_pos - new_pos;
        let nr = old_r.saturating_sub(pos_loss);
        assert!(nr <= new_pos, "set_pnl: new_R > new_pos");
        nr
    };

    debug_assert!(new_r <= new_pos, "set_pnl: new_R > new_pos");
    let new_rel = new_pos - new_r;

    // Update pnl_pos_tot (steps 10-11)
    if new_pos > old_pos {
        let delta = new_pos - old_pos;
        market.pnl_pos_tot = market.pnl_pos_tot.checked_add(delta)
            .expect("set_pnl: pnl_pos_tot overflow");
    } else if old_pos > new_pos {
        let delta = old_pos - new_pos;
        market.pnl_pos_tot = market.pnl_pos_tot.checked_sub(delta)
            .expect("set_pnl: pnl_pos_tot underflow");
    }
    assert!(market.pnl_pos_tot <= MAX_PNL_POS_TOT, "set_pnl: exceeds MAX_PNL_POS_TOT");

    // Update pnl_matured_pos_tot (steps 12-13)
    if new_rel > old_rel {
        let delta = new_rel - old_rel;
        market.pnl_matured_pos_tot = market.pnl_matured_pos_tot.checked_add(delta)
            .expect("set_pnl: pnl_matured_pos_tot overflow");
    } else if old_rel > new_rel {
        let delta = old_rel - new_rel;
        market.pnl_matured_pos_tot = market.pnl_matured_pos_tot.checked_sub(delta)
            .expect("set_pnl: pnl_matured_pos_tot underflow");
    }
    assert!(market.pnl_matured_pos_tot <= market.pnl_pos_tot,
        "set_pnl: pnl_matured_pos_tot > pnl_pos_tot");

    position.pnl = new_pnl;
    position.reserved_pnl = new_r;
}

/// set_reserved_pnl (spec §4.3): update R_i and maintain pnl_matured_pos_tot
pub fn set_reserved_pnl(position: &mut UserPosition, market: &mut Market, new_r: u128) {
    let pos = i128_clamp_pos(position.pnl);
    assert!(new_r <= pos, "set_reserved_pnl: new_R > max(PNL_i, 0)");

    let old_r = position.reserved_pnl;
    debug_assert!(old_r <= pos, "set_reserved_pnl: old_R > PNL_pos");
    let old_rel = pos - old_r;
    debug_assert!(new_r <= pos, "set_reserved_pnl: new_R > PNL_pos");
    let new_rel = pos - new_r;

    if new_rel > old_rel {
        let delta = new_rel - old_rel;
        market.pnl_matured_pos_tot = market.pnl_matured_pos_tot.checked_add(delta)
            .expect("set_reserved_pnl: pnl_matured_pos_tot overflow");
    } else if old_rel > new_rel {
        let delta = old_rel - new_rel;
        market.pnl_matured_pos_tot = market.pnl_matured_pos_tot.checked_sub(delta)
            .expect("set_reserved_pnl: pnl_matured_pos_tot underflow");
    }
    assert!(market.pnl_matured_pos_tot <= market.pnl_pos_tot,
        "set_reserved_pnl: pnl_matured_pos_tot > pnl_pos_tot");

    position.reserved_pnl = new_r;
}

/// consume_released_pnl (spec §4.4.1): remove only matured released positive PnL,
/// leaving R_i unchanged.
pub fn consume_released_pnl(position: &mut UserPosition, market: &mut Market, x: u128) {
    assert!(x > 0, "consume_released_pnl: x must be > 0");

    let old_pos = i128_clamp_pos(position.pnl);
    let old_r = position.reserved_pnl;
    let old_rel = old_pos.saturating_sub(old_r);
    assert!(x <= old_rel, "consume_released_pnl: x > ReleasedPos_i");

    let new_pos = old_pos - x;
    assert!(new_pos >= old_r, "consume_released_pnl: new_pos < old_R");

    market.pnl_pos_tot = market.pnl_pos_tot.checked_sub(x)
        .expect("consume_released_pnl: pnl_pos_tot underflow");
    market.pnl_matured_pos_tot = market.pnl_matured_pos_tot.checked_sub(x)
        .expect("consume_released_pnl: pnl_matured_pos_tot underflow");
    assert!(market.pnl_matured_pos_tot <= market.pnl_pos_tot);

    let x_i128: i128 = x.try_into().expect("consume_released_pnl: x > i128::MAX");
    let new_pnl = position.pnl.checked_sub(x_i128)
        .expect("consume_released_pnl: PNL underflow");
    assert!(new_pnl != i128::MIN);
    position.pnl = new_pnl;
    // R_i remains unchanged
}

/// set_capital (spec §4.2): checked signed-delta update of C_tot
/// H5 fix: Returns Result to reject values exceeding u64::MAX
pub fn set_capital(position: &mut UserPosition, market: &mut Market, new_capital: u128) -> Result<()> {
    let old = position.deposited_collateral as u128;
    if new_capital >= old {
        let delta = new_capital - old;
        market.c_tot = market.c_tot.checked_add(delta).expect("set_capital: c_tot overflow");
    } else {
        let delta = old - new_capital;
        market.c_tot = market.c_tot.checked_sub(delta).expect("set_capital: c_tot underflow");
    }
    // H5 fix: Reject instead of silently clamping to u64
    if new_capital > u64::MAX as u128 {
        return Err(PerkError::MathOverflow.into());
    }
    position.deposited_collateral = new_capital as u64;
    Ok(())
}

/// set_position_basis_q (spec §4.4): update stored pos counts based on sign changes
pub fn set_position_basis_q(position: &mut UserPosition, market: &mut Market, new_basis: i128) {
    let old = position.basis;
    let old_side = side_of_i128(old);
    let new_side = side_of_i128(new_basis);

    if let Some(s) = old_side {
        match s {
            Side::Long => market.stored_pos_count_long = market.stored_pos_count_long
                .checked_sub(1).expect("set_position_basis_q: long count underflow"),
            Side::Short => market.stored_pos_count_short = market.stored_pos_count_short
                .checked_sub(1).expect("set_position_basis_q: short count underflow"),
        }
    }
    if let Some(s) = new_side {
        match s {
            Side::Long => market.stored_pos_count_long = market.stored_pos_count_long
                .checked_add(1).expect("set_position_basis_q: long count overflow"),
            Side::Short => market.stored_pos_count_short = market.stored_pos_count_short
                .checked_add(1).expect("set_position_basis_q: short count overflow"),
        }
    }
    position.basis = new_basis;
}

// ============================================================================
// Haircut (spec §3.3)
// ============================================================================

/// Compute haircut ratio (h_num, h_den) using pnl_matured_pos_tot
pub fn haircut_ratio(market: &Market) -> (u128, u128) {
    if market.pnl_matured_pos_tot == 0 {
        return (1u128, 1u128);
    }
    // H4 (R3): Subtract claimable fees from the residual — they are senior claims
    // that belong to creator/protocol, not available for haircut distribution.
    let claimable = (market.creator_claimable_fees as u128)
        .saturating_add(market.protocol_claimable_fees as u128);
    let senior_sum = market.c_tot
        .checked_add(market.insurance_fund_balance as u128)
        .and_then(|s| s.checked_add(claimable));
    let residual: u128 = match senior_sum {
        Some(ss) => {
            if market.vault_balance >= ss { market.vault_balance - ss } else { 0u128 }
        }
        None => 0u128,
    };
    let h_num = core::cmp::min(residual, market.pnl_matured_pos_tot);
    (h_num, market.pnl_matured_pos_tot)
}

/// released_pos (spec §2.1): ReleasedPos_i = max(PNL_i, 0) - R_i
pub fn released_pos(position: &UserPosition) -> u128 {
    let pos_pnl = i128_clamp_pos(position.pnl);
    pos_pnl.saturating_sub(position.reserved_pnl)
}

/// PNL_eff_matured_i (spec §3.3): haircutted matured released positive PnL
pub fn effective_matured_pnl(market: &Market, position: &UserPosition) -> u128 {
    let released = released_pos(position);
    if released == 0 { return 0u128; }
    let (h_num, h_den) = haircut_ratio(market);
    if h_den == 0 { return released; }
    wide_mul_div_floor_u128(released, h_num, h_den)
}

// ============================================================================
// Equity (spec §3.4)
// ============================================================================

/// Eq_maint_raw_i: C_i + PNL_i - FeeDebt_i in exact I256
pub fn account_equity_maint_raw_wide(position: &UserPosition) -> I256 {
    let cap = I256::from_u128(position.deposited_collateral as u128);
    let pnl = I256::from_i128(position.pnl);
    let fee_debt = I256::from_u128(fee_debt_u128_checked(position.fee_credits));
    let sum = cap.checked_add(pnl).expect("I256 add overflow");
    sum.checked_sub(fee_debt).expect("I256 sub overflow")
}

/// Eq_maint_raw_i as i128 (with saturation for overflow)
pub fn account_equity_maint_raw(position: &UserPosition) -> i128 {
    let wide = account_equity_maint_raw_wide(position);
    match wide.try_into_i128() {
        Some(v) => v,
        None => if wide.is_negative() { i128::MIN + 1 } else { i128::MAX },
    }
}

/// Eq_net_i = max(0, Eq_maint_raw_i)
pub fn account_equity_net(position: &UserPosition) -> i128 {
    let raw = account_equity_maint_raw(position);
    if raw < 0 { 0i128 } else { raw }
}

/// Eq_init_raw_i: C_i + min(PNL_i, 0) + PNL_eff_matured_i - FeeDebt_i
pub fn account_equity_init_raw(market: &Market, position: &UserPosition) -> i128 {
    let cap = I256::from_u128(position.deposited_collateral as u128);
    let neg_pnl = I256::from_i128(if position.pnl < 0 { position.pnl } else { 0i128 });
    let eff_matured = I256::from_u128(effective_matured_pnl(market, position));
    let fee_debt = I256::from_u128(fee_debt_u128_checked(position.fee_credits));

    let sum = cap.checked_add(neg_pnl).expect("I256 add overflow")
        .checked_add(eff_matured).expect("I256 add overflow")
        .checked_sub(fee_debt).expect("I256 sub overflow");

    match sum.try_into_i128() {
        Some(v) => v,
        None => if sum.is_negative() { i128::MIN + 1 } else { i128::MAX },
    }
}

// ============================================================================
// Effective position (spec §5.2)
// ============================================================================

/// Compute effective position quantity after A/K adjustment.
/// Returns i128 (full Percolator range).
pub fn effective_position_q(position: &UserPosition, market: &Market) -> i128 {
    let basis = position.basis;
    if basis == 0 { return 0i128; }

    let side = side_of_i128(basis).unwrap();
    let epoch_snap = position.epoch_snapshot;
    let epoch_side = get_epoch_side(market, side);

    if epoch_snap != epoch_side { return 0i128; }

    let a_side = get_a_side(market, side);
    let a_basis = position.a_snapshot;
    if a_basis == 0 { return 0i128; }

    let abs_basis = basis.unsigned_abs();
    let effective_abs = mul_div_floor_u128(abs_basis, a_side, a_basis);

    if basis < 0 {
        if effective_abs == 0 { 0i128 }
        else {
            assert!(effective_abs <= i128::MAX as u128, "effective_pos_q: overflow");
            -(effective_abs as i128)
        }
    } else {
        assert!(effective_abs <= i128::MAX as u128, "effective_pos_q: overflow");
        effective_abs as i128
    }
}

/// notional (spec §9.1): floor(|effective_pos_q| * oracle_price / POS_SCALE)
pub fn notional(position: &UserPosition, market: &Market, oracle_price: u64) -> u128 {
    let eff = effective_position_q(position, market);
    if eff == 0 { return 0; }
    mul_div_floor_u128(eff.unsigned_abs(), oracle_price as u128, POS_SCALE)
}

// ============================================================================
// settle_side_effects (spec §5.3)
// ============================================================================

/// v2.1: Settle pending liquidation rewards into position collateral.
/// Uses raw base_size (not effective) to match distribution denominator (total_long/short_position).
/// Only increases collateral — always safe to call at any point.
pub fn settle_pending_rewards(
    position: &mut UserPosition,
    market: &mut Market,
) -> Result<()> {
    // Skip if position is flat (no side to claim from)
    if position.base_size == 0 {
        return Ok(());
    }

    let is_long = position.base_size > 0;
    let accumulator = if is_long {
        market.long_reward_accumulator
    } else {
        market.short_reward_accumulator
    };

    let delta = accumulator.saturating_sub(position.reward_snapshot);
    if delta > 0 {
        let abs_size = (position.base_size as i64).unsigned_abs() as u128;
        let reward = delta
            .checked_mul(abs_size)
            .ok_or(PerkError::MathOverflow)?
            / crate::constants::REWARD_PRECISION;
        if reward > 0 {
            // Pashov F3/F4: Use checked conversion to prevent u128→u64 truncation mismatch
            let reward_u64: u64 = reward.try_into().map_err(|_| PerkError::MathOverflow)?;
            position.deposited_collateral = position.deposited_collateral
                .checked_add(reward_u64)
                .ok_or(PerkError::MathOverflow)?;
            position.cumulative_rewards_claimed = position.cumulative_rewards_claimed
                .checked_add(reward_u64)
                .ok_or(PerkError::MathOverflow)?;
            market.c_tot = market.c_tot
                .checked_add(reward)
                .ok_or(PerkError::MathOverflow)?;
        }
    }
    position.reward_snapshot = accumulator;
    Ok(())
}

pub fn settle_side_effects(
    position: &mut UserPosition,
    market: &mut Market,
) -> Result<()> {
    // v2.1: Settle liquidation rewards FIRST — before basis check, before epoch check.
    // Must run at full position size before anything can zero base_size.
    // Reward claims only increase collateral, never decrease — always safe.
    settle_pending_rewards(position, market)?;

    let basis = position.basis;
    if basis == 0 { return Ok(()); }

    let side = side_of_i128(basis).unwrap();
    let epoch_snap = position.epoch_snapshot;
    let epoch_side = get_epoch_side(market, side);
    let a_basis = position.a_snapshot;

    if a_basis == 0 {
        return Err(PerkError::CorruptState.into());
    }

    let abs_basis = basis.unsigned_abs();

    if epoch_snap == epoch_side {
        // Same epoch (spec §5.3 step 4)
        let k_side = get_k_side(market, side);
        let k_snap = position.k_snapshot;

        // Record old_R before set_pnl
        let old_r = position.reserved_pnl;

        // pnl_delta via wide K-difference settlement
        let den = a_basis.checked_mul(POS_SCALE).ok_or(PerkError::MathOverflow)?;
        let pnl_delta = wide_signed_mul_div_floor_from_k_pair(abs_basis, k_side, k_snap, den);

        let old_pnl = position.pnl;
        let new_pnl = old_pnl.checked_add(pnl_delta).ok_or(PerkError::MathOverflow)?;
        if new_pnl == i128::MIN { return Err(PerkError::MathOverflow.into()); }
        set_pnl(position, market, new_pnl);

        // If R increased, caller must restart warmup
        let r_increased = position.reserved_pnl > old_r;

        // q_eff_new
        let q_eff_new = mul_div_floor_u128(abs_basis, get_a_side(market, side), a_basis);

        if q_eff_new == 0 {
            // Position effectively zeroed
            inc_phantom_dust_bound(market, side);
            set_position_basis_q(position, market, 0i128);
            // H2 (Pashov3): Zero base_size alongside basis (same as epoch-mismatch fix)
            if position.base_size != 0 {
                let was_long = position.base_size > 0;
                let abs_base = (position.base_size as i64).unsigned_abs() as u128;
                if was_long {
                    market.total_long_position = market.total_long_position.saturating_sub(abs_base);
                } else {
                    market.total_short_position = market.total_short_position.saturating_sub(abs_base);
                }
                market.total_positions = market.total_positions.saturating_sub(1);
                position.base_size = 0;
                position.quote_entry_amount = 0;
            }
            position.a_snapshot = ADL_ONE;
            position.k_snapshot = 0i128;
            position.epoch_snapshot = epoch_side;
        } else {
            // Update k_snap only (non-compounding)
            position.k_snapshot = k_side;
            position.epoch_snapshot = epoch_side;
        }

        // Restart warmup if R increased
        if r_increased {
            restart_warmup_after_reserve_increase(position, market);
        }
    } else {
        // Epoch mismatch (spec §5.3 step 5)
        //
        // v1.5.1: Relaxed two checks for the auto-heal flow:
        //
        // 1. Side mode: Previously required ResetPending. With the relaxed
        //    finalize (OI-only check), the side may have transitioned back to
        //    Normal before this stale position settled. That's fine — the
        //    settlement math is epoch-based and independent of side mode.
        //
        // 2. Epoch gap: Previously required exactly +1. With auto-heal, the
        //    side can go Normal → new ADL → another epoch bump, creating a
        //    gap of 2+. Intermediate K-epoch values are overwritten, so we
        //    can't compute exact PnL for skipped epochs. Safe fallback: zero
        //    PnL delta (ADL already socialized losses). User keeps remaining
        //    collateral.
        let single_epoch_gap = epoch_snap.checked_add(1) == Some(epoch_side);

        let pnl_delta = if single_epoch_gap {
            // Normal case: compute PnL from K-epoch start values
            let k_epoch_start = get_k_epoch_start(market, side);
            let k_snap = position.k_snapshot;
            let den = a_basis.checked_mul(POS_SCALE).ok_or(PerkError::MathOverflow)?;
            wide_signed_mul_div_floor_from_k_pair(abs_basis, k_epoch_start, k_snap, den)
        } else {
            // Multi-epoch gap: intermediate K values lost. Zero PnL delta.
            // Position was ADL'd — losses already socialized. Remaining
            // collateral is the user's to withdraw.
            msg!(
                "Multi-epoch settle: epoch_snap={}, epoch_side={}, gap={}. Zero PnL delta.",
                epoch_snap, epoch_side, epoch_side.saturating_sub(epoch_snap),
            );
            0i128
        };

        let old_r = position.reserved_pnl;

        let old_pnl = position.pnl;
        let new_pnl = old_pnl.checked_add(pnl_delta).ok_or(PerkError::MathOverflow)?;
        if new_pnl == i128::MIN { return Err(PerkError::MathOverflow.into()); }
        set_pnl(position, market, new_pnl);

        let r_increased = position.reserved_pnl > old_r;

        set_position_basis_q(position, market, 0i128);

        // H1 (Pashov2): Zero base_size and quote_entry_amount alongside basis.
        if position.base_size != 0 {
            let was_long = position.base_size > 0;
            let abs_base = (position.base_size as i64).unsigned_abs() as u128;
            if was_long {
                market.total_long_position = market.total_long_position.saturating_sub(abs_base);
            } else {
                market.total_short_position = market.total_short_position.saturating_sub(abs_base);
            }
            market.total_positions = market.total_positions.saturating_sub(1);
            position.base_size = 0;
            position.quote_entry_amount = 0;
        }

        // Decrement stale count (saturating — multi-epoch may have reset counts)
        let old_stale = get_stale_count(market, side);
        if old_stale > 0 {
            set_stale_count(market, side, old_stale - 1);
        }

        // Reset to canonical zero-position defaults
        position.a_snapshot = ADL_ONE;
        position.k_snapshot = 0i128;
        position.epoch_snapshot = epoch_side;

        if r_increased {
            restart_warmup_after_reserve_increase(position, market);
        }
    }

    Ok(())
}

// ============================================================================
// accrue_market_to (spec §5.4)
// ============================================================================

pub fn accrue_market_to(market: &mut Market, now_slot: u64, oracle_price: u64) -> Result<()> {
    if oracle_price == 0 || oracle_price > MAX_ORACLE_PRICE {
        return Err(PerkError::OraclePriceInvalid.into());
    }
    if now_slot < market.current_slot {
        return Err(PerkError::MathOverflow.into());
    }
    if now_slot < market.last_market_slot {
        return Err(PerkError::MathOverflow.into());
    }

    // Snapshot OI at start (fixed for all sub-steps)
    let long_live = market.oi_eff_long_q != 0;
    let short_live = market.oi_eff_short_q != 0;

    let raw_dt = now_slot.saturating_sub(market.last_market_slot);

    // Safety: cap the slot gap to prevent catastrophic K accumulation.
    // If a market was created without initializing last_market_slot (defaults to 0),
    // or the cranker was down for an extended period, raw_dt can be hundreds of millions.
    // Cap to ~7 minutes worth of slots. Any funding/mark beyond this is lost, but that's
    // safer than producing trillions of phantom PNL.
    const MAX_ACCRUE_DT: u64 = 1_000_000;
    let total_dt = if raw_dt > MAX_ACCRUE_DT {
        // Advance last_market_slot to close the gap
        market.last_market_slot = now_slot.saturating_sub(MAX_ACCRUE_DT);
        MAX_ACCRUE_DT
    } else {
        raw_dt
    };

    if total_dt == 0 && market.last_oracle_price == oracle_price {
        market.current_slot = now_slot;
        return Ok(());
    }

    // Mark-once rule: apply mark exactly once from P_last to oracle_price
    let current_price = if market.last_oracle_price == 0 { oracle_price } else { market.last_oracle_price };
    let delta_p = (oracle_price as i128).checked_sub(current_price as i128)
        .ok_or(PerkError::MathOverflow)?;

    if delta_p != 0 {
        if long_live {
            let delta_k = checked_u128_mul_i128(market.long_a, delta_p)
                .map_err(|_| PerkError::MathOverflow)?;
            market.long_k_index = market.long_k_index.checked_add(delta_k)
                .ok_or(PerkError::MathOverflow)?;
        }
        if short_live {
            let delta_k = checked_u128_mul_i128(market.short_a, delta_p)
                .map_err(|_| PerkError::MathOverflow)?;
            market.short_k_index = market.short_k_index.checked_sub(delta_k)
                .ok_or(PerkError::MathOverflow)?;
        }
    }

    if total_dt == 0 {
        market.current_slot = now_slot;
        market.last_oracle_price = oracle_price;
        market.funding_price_sample_last = oracle_price;
        return Ok(());
    }

    let funding_rate = market.funding_rate_bps_per_slot_last;
    if funding_rate.saturating_abs() > MAX_ABS_FUNDING_BPS_PER_SLOT {
        return Err(PerkError::MathOverflow.into());
    }

    let fund_px = if market.funding_price_sample_last == 0 {
        oracle_price
    } else {
        market.funding_price_sample_last
    };

    // Funding sub-steps (dt <= MAX_FUNDING_DT each)
    // L1 (R4): Cap iterations to prevent CU exhaustion on dormant markets
    const MAX_FUNDING_ITERATIONS: u64 = 50;
    let mut remaining_dt = total_dt;
    let mut iterations: u64 = 0;
    while remaining_dt > 0 && iterations < MAX_FUNDING_ITERATIONS {
        let dt = core::cmp::min(remaining_dt, MAX_FUNDING_DT);
        remaining_dt -= dt;
        iterations += 1;

        // Funding-both-sides rule: skip if either snapped OI is zero
        if dt > 0 && funding_rate != 0 && long_live && short_live {
            let abs_rate = (funding_rate as i128).unsigned_abs();
            // C1 (R3): funding_rate is now scaled by FUNDING_RATE_PRECISION.
            // Divide out precision after multiplying to preserve accuracy.
            let funding_term_raw: u128 = (fund_px as u128)
                .checked_mul(abs_rate)
                .ok_or(PerkError::MathOverflow)?
                .checked_mul(dt as u128)
                .ok_or(PerkError::MathOverflow)?
                / (crate::constants::FUNDING_RATE_PRECISION as u128);

            if funding_term_raw > 0 {
                let (a_payer, a_receiver) = if funding_rate > 0 {
                    (market.long_a, market.short_a)
                } else {
                    (market.short_a, market.long_a)
                };

                // delta_K_payer_abs = ceil(A_p * funding_term_raw / 10_000)
                let delta_k_payer_abs = mul_div_ceil_u128(a_payer, funding_term_raw, 10_000);
                if delta_k_payer_abs > i128::MAX as u128 {
                    return Err(PerkError::MathOverflow.into());
                }
                let delta_k_payer_neg = -(delta_k_payer_abs as i128);

                if funding_rate > 0 {
                    market.long_k_index = market.long_k_index.checked_add(delta_k_payer_neg)
                        .ok_or(PerkError::MathOverflow)?;
                } else {
                    market.short_k_index = market.short_k_index.checked_add(delta_k_payer_neg)
                        .ok_or(PerkError::MathOverflow)?;
                }

                // Receiver gain: floor(delta_K_payer_abs * A_r / A_p)
                let delta_k_receiver_abs = mul_div_floor_u128(delta_k_payer_abs, a_receiver, a_payer);
                if delta_k_receiver_abs > i128::MAX as u128 {
                    return Err(PerkError::MathOverflow.into());
                }
                let delta_k_receiver = delta_k_receiver_abs as i128;

                if funding_rate > 0 {
                    market.short_k_index = market.short_k_index.checked_add(delta_k_receiver)
                        .ok_or(PerkError::MathOverflow)?;
                } else {
                    market.long_k_index = market.long_k_index.checked_add(delta_k_receiver)
                        .ok_or(PerkError::MathOverflow)?;
                }
            }
        }
    }

    // L1 (R4): If we didn't finish all iterations, record partial catch-up
    // so next call continues from where we stopped
    if remaining_dt > 0 {
        market.current_slot = now_slot;
        market.last_market_slot = now_slot.saturating_sub(remaining_dt);
    } else {
        market.current_slot = now_slot;
        market.last_market_slot = now_slot;
    }
    market.last_oracle_price = oracle_price;
    market.funding_price_sample_last = oracle_price;

    Ok(())
}

/// Set funding rate for next interval (spec §5.5 anti-retroactivity)
pub fn set_funding_rate_for_next_interval(market: &mut Market, new_rate: i64) {
    let clamped = if new_rate > MAX_ABS_FUNDING_BPS_PER_SLOT {
        MAX_ABS_FUNDING_BPS_PER_SLOT
    } else if new_rate < -MAX_ABS_FUNDING_BPS_PER_SLOT {
        -MAX_ABS_FUNDING_BPS_PER_SLOT
    } else {
        new_rate
    };
    market.funding_rate_bps_per_slot_last = clamped;
}

// ============================================================================
// attach_effective_position (spec §4.5)
// ============================================================================

pub fn attach_effective_position(
    position: &mut UserPosition,
    market: &mut Market,
    new_eff_pos_q: i128,
) {
    // Account for orphaned fractional remainder (dynamic dust)
    let old_basis = position.basis;
    if old_basis != 0 {
        if let Some(old_side) = side_of_i128(old_basis) {
            let epoch_snap = position.epoch_snapshot;
            let epoch_side = get_epoch_side(market, old_side);
            if epoch_snap == epoch_side {
                let a_basis = position.a_snapshot;
                if a_basis != 0 {
                    let a_side = get_a_side(market, old_side);
                    let abs_basis = old_basis.unsigned_abs();
                    let product = U256::from_u128(abs_basis)
                        .checked_mul(U256::from_u128(a_side));
                    if let Some(p) = product {
                        let rem = p.checked_rem(U256::from_u128(a_basis));
                        if let Some(r) = rem {
                            if !r.is_zero() {
                                inc_phantom_dust_bound(market, old_side);
                            }
                        }
                    }
                }
            }
        }
    }

    if new_eff_pos_q == 0 {
        set_position_basis_q(position, market, 0i128);
        position.a_snapshot = ADL_ONE;
        position.k_snapshot = 0i128;
        if old_basis > 0 {
            position.epoch_snapshot = market.long_epoch;
        } else if old_basis < 0 {
            position.epoch_snapshot = market.short_epoch;
        } else {
            position.epoch_snapshot = 0;
        }
    } else {
        let side = side_of_i128(new_eff_pos_q).expect("attach: nonzero must have side");
        set_position_basis_q(position, market, new_eff_pos_q);
        match side {
            Side::Long => {
                position.a_snapshot = market.long_a;
                position.k_snapshot = market.long_k_index;
                position.epoch_snapshot = market.long_epoch;
            }
            Side::Short => {
                position.a_snapshot = market.short_a;
                position.k_snapshot = market.short_k_index;
                position.epoch_snapshot = market.short_epoch;
            }
        }
    }
}

// ============================================================================
// Side mode checks (spec §5.6-5.8)
// ============================================================================

/// Check if a side allows new positions (increases)
pub fn side_allows_increase(market: &Market, is_long: bool) -> bool {
    let state = if is_long { market.long_state } else { market.short_state };
    state == SideState::Normal
}

/// begin_full_drain_reset (spec §2.5)
pub fn begin_full_drain_reset(market: &mut Market, side: Side) {
    assert!(get_oi_eff(market, side) == 0, "begin_full_drain_reset: OI not zero");

    let k = get_k_side(market, side);
    match side {
        Side::Long => market.long_epoch_start_k = k,
        Side::Short => market.short_epoch_start_k = k,
    }

    match side {
        Side::Long => market.long_epoch = market.long_epoch.checked_add(1).expect("epoch overflow"),
        Side::Short => market.short_epoch = market.short_epoch.checked_add(1).expect("epoch overflow"),
    }

    set_a_side(market, side, ADL_ONE);

    let spc = get_stored_pos_count(market, side);
    set_stale_count(market, side, spc);

    match side {
        Side::Long => market.phantom_dust_bound_long_q = 0u128,
        Side::Short => market.phantom_dust_bound_short_q = 0u128,
    }

    set_side_mode(market, side, SideState::ResetPending);

    // After ADL drains a side, vAMM reserves are stale (reflect positions that no
    // longer exist). Normalize reserves to balanced state (base = quote = sqrt(k))
    // and reset peg cooldown so update_amm can immediately re-peg to oracle.
    // Safe because PnL is K-diff (oracle-based), not vAMM-derived.
    super::vamm::normalize_reserves(market);
    market.last_peg_update_slot = 0;
}

/// finalize_side_reset (spec §2.7)
/// v1.5.1: Relaxed to match maybe_finalize_ready_reset_sides — OI-only check.
/// Retained for spec compliance but not actively called (preflight version used).
pub fn finalize_side_reset(market: &mut Market, side: Side) -> Result<()> {
    if get_side_mode(market, side) != SideState::ResetPending {
        return Err(PerkError::CorruptState.into());
    }
    if get_oi_eff(market, side) != 0 {
        return Err(PerkError::CorruptState.into());
    }
    set_side_mode(market, side, SideState::Normal);
    Ok(())
}

/// Preflight finalize: if a side is ResetPending with OI=0, transition back to Normal.
///
/// v1.5.1: Removed stale_count and stored_pos_count requirements. After ADL
/// epoch-bumps a side, effective OI is already zero. Stale positions are just
/// bookkeeping — they settle correctly via epoch-mismatch path in
/// settle_side_effects regardless of side state. Requiring all stale positions
/// to settle first meant one inactive user could permanently brick a market side.
pub fn maybe_finalize_ready_reset_sides(market: &mut Market) {
    if market.long_state == SideState::ResetPending
        && get_oi_eff(market, Side::Long) == 0
    {
        set_side_mode(market, Side::Long, SideState::Normal);
    }
    if market.short_state == SideState::ResetPending
        && get_oi_eff(market, Side::Short) == 0
    {
        set_side_mode(market, Side::Short, SideState::Normal);
    }
}

// ============================================================================
// Phantom dust clearance (spec §5.7)
// ============================================================================

/// Check if a side has become empty after OI reduction and trigger reset if needed.
/// Call after any instruction that reduces OI.
pub fn check_and_clear_phantom_dust(market: &mut Market, side: Side) {
    let oi = get_oi_eff(market, side);

    // H1 (Apex R2): DrainOnly side with zero effective OI must transition to ResetPending.
    // Previously this was missed because the oi==0 early return below skipped it.
    if oi == 0 {
        if get_side_mode(market, side) == SideState::DrainOnly {
            begin_full_drain_reset(market, side);
            maybe_finalize_ready_reset_sides(market);
        }
        return;
    }
    let stored = get_stored_pos_count(market, side);
    if stored > 0 {
        // Still have live positions — not phantom dust
        return;
    }
    // No stored positions but OI > 0 — this is phantom dust
    let dust_bound = match side {
        Side::Long => market.phantom_dust_bound_long_q,
        Side::Short => market.phantom_dust_bound_short_q,
    };
    if oi <= dust_bound {
        // OI is within dust bound — clear it and trigger reset
        set_oi_eff(market, side, 0);
        if get_side_mode(market, side) != SideState::ResetPending {
            begin_full_drain_reset(market, side);
        }

        // M2 (Apex R2): Check bilateral/unilateral empty after clearing this side.
        // If the opposite side also has zero effective OI, reset it too.
        let opp = opposite_side(side);
        let opp_oi = get_oi_eff(market, opp);
        let opp_stored = get_stored_pos_count(market, opp);
        if opp_oi == 0 && opp_stored == 0 {
            // Bilateral empty — reset opposite side too
            if get_side_mode(market, opp) != SideState::ResetPending {
                begin_full_drain_reset(market, opp);
            }
        } else if opp_stored == 0 && opp_oi > 0 {
            // Unilateral: this side is empty, opposite has only dust
            let opp_dust_bound = match opp {
                Side::Long => market.phantom_dust_bound_long_q,
                Side::Short => market.phantom_dust_bound_short_q,
            };
            if opp_oi <= opp_dust_bound {
                set_oi_eff(market, opp, 0);
                if get_side_mode(market, opp) != SideState::ResetPending {
                    begin_full_drain_reset(market, opp);
                }
            }
        }

        maybe_finalize_ready_reset_sides(market);
    }
}

// ============================================================================
// Insurance buffer (spec §4.7-4.11)
// ============================================================================

/// use_insurance_buffer: deduct loss from insurance down to floor, return remaining.
/// M1 (Apex R2): Enforces per-epoch cap on insurance payouts.
pub fn use_insurance_buffer(market: &mut Market, loss: u128) -> u128 {
    if loss == 0 { return 0; }
    let ins_bal = market.insurance_fund_balance as u128;
    // ATK-09 fix: Dynamic insurance floor = max(configured_floor, 20% of insurance fund)
    // Uses ins_bal (not vault_balance) because vault >> insurance typically, and
    // vault_balance / 5 would lock the entire fund.
    let dynamic_floor = core::cmp::max(
        market.insurance_floor,
        ins_bal / 5,
    );
    let available = ins_bal.saturating_sub(dynamic_floor);

    // M1: Enforce epoch cap on insurance payouts
    let epoch_cap = (ins_bal * INSURANCE_EPOCH_CAP_BPS as u128) / 10_000;
    let epoch_remaining = epoch_cap.saturating_sub(market.insurance_epoch_payout as u128);
    let capped_available = core::cmp::min(available, epoch_remaining);

    let pay = core::cmp::min(loss, capped_available);
    if pay > 0 {
        market.insurance_fund_balance = (ins_bal - pay) as u64;
        market.insurance_epoch_payout = market.insurance_epoch_payout
            .saturating_add(core::cmp::min(pay, u64::MAX as u128) as u64);
    }
    loss - pay
}

/// absorb_protocol_loss: use_insurance_buffer then implicit haircut
pub fn absorb_protocol_loss(market: &mut Market, loss: u128) {
    if loss == 0 { return; }
    let _rem = use_insurance_buffer(market, loss);
}

// ============================================================================
// enqueue_adl (spec §5.6)
// ============================================================================

pub fn enqueue_adl(
    market: &mut Market,
    liq_side: Side,
    q_close_q: u128,
    d: u128,
) -> Result<()> {
    let opp = opposite_side(liq_side);

    // Step 1: decrease liquidated side OI
    if q_close_q != 0 {
        let old_oi = get_oi_eff(market, liq_side);
        let new_oi = old_oi.checked_sub(q_close_q).ok_or(PerkError::CorruptState)?;
        set_oi_eff(market, liq_side, new_oi);
    }

    // Step 2: insurance-first deficit coverage
    let d_rem = if d > 0 { use_insurance_buffer(market, d) } else { 0u128 };

    // Step 3: read opposing OI
    let oi = get_oi_eff(market, opp);

    // Step 4: if OI == 0
    // H4 fix: Use deferred reset flags instead of eager begin_full_drain_reset
    if oi == 0 {
        if get_oi_eff(market, liq_side) == 0 {
            // Both sides empty — schedule deferred resets
            set_pending_reset_flag(market, liq_side);
            set_pending_reset_flag(market, opp);
        }
        return Ok(());
    }

    // Step 5: if stored_pos_count_opp == 0, route through record_uninsured
    if get_stored_pos_count(market, opp) == 0 {
        if q_close_q > oi {
            return Err(PerkError::CorruptState.into());
        }
        let oi_post = oi.checked_sub(q_close_q).ok_or(PerkError::MathOverflow)?;
        set_oi_eff(market, opp, oi_post);
        if oi_post == 0 {
            set_pending_reset_flag(market, opp);
            if get_oi_eff(market, liq_side) == 0 {
                set_pending_reset_flag(market, liq_side);
            }
        }
        return Ok(());
    }

    // Step 6: if liquidated position exceeds opposing OI, drain opposing side
    // to zero and schedule reset. Deficit goes uninsured. This handles the edge
    // case where one side's effective OI dwarfs the other after A/K adjustments.
    if q_close_q > oi {
        // Apply any remaining deficit to K before draining
        if d_rem != 0 {
            let a_old_drain = get_a_side(market, opp);
            let a_ps = a_old_drain.checked_mul(POS_SCALE).ok_or(PerkError::MathOverflow)?;
            match wide_mul_div_ceil_u128_or_over_i128max(d_rem, a_ps, oi) {
                Ok(delta_k_abs) => {
                    let delta_k = -(delta_k_abs as i128);
                    let k_opp = get_k_side(market, opp);
                    if let Some(new_k) = k_opp.checked_add(delta_k) {
                        set_k_side(market, opp, new_k);
                    }
                }
                Err(OverI128Magnitude) => { /* overflow: uninsured */ }
            }
        }
        set_oi_eff(market, opp, 0u128);
        set_pending_reset_flag(market, opp);
        if get_oi_eff(market, liq_side) == 0 {
            set_pending_reset_flag(market, liq_side);
        }
        return Ok(());
    }

    let a_old = get_a_side(market, opp);
    let oi_post = oi.checked_sub(q_close_q).ok_or(PerkError::MathOverflow)?;

    // Step 7: handle D_rem > 0
    if d_rem != 0 {
        let a_ps = a_old.checked_mul(POS_SCALE).ok_or(PerkError::MathOverflow)?;
        match wide_mul_div_ceil_u128_or_over_i128max(d_rem, a_ps, oi) {
            Ok(delta_k_abs) => {
                let delta_k = -(delta_k_abs as i128);
                let k_opp = get_k_side(market, opp);
                if let Some(new_k) = k_opp.checked_add(delta_k) {
                    set_k_side(market, opp, new_k);
                }
                // K-space overflow: record_uninsured (implicit through h)
            }
            Err(OverI128Magnitude) => {
                // Quotient overflow: record_uninsured (implicit)
            }
        }
    }

    // Step 8: if OI_post == 0
    // H4 fix: deferred reset
    if oi_post == 0 {
        set_oi_eff(market, opp, 0u128);
        set_pending_reset_flag(market, opp);
        if get_oi_eff(market, liq_side) == 0 {
            set_pending_reset_flag(market, liq_side);
        }
        return Ok(());
    }

    // Steps 9-10: A_candidate via U256
    let a_old_u256 = U256::from_u128(a_old);
    let oi_post_u256 = U256::from_u128(oi_post);
    let oi_u256 = U256::from_u128(oi);
    let (a_candidate_u256, a_trunc_rem) = mul_div_floor_u256_with_rem(
        a_old_u256, oi_post_u256, oi_u256,
    );

    if !a_candidate_u256.is_zero() {
        let a_new = a_candidate_u256.try_into_u128().expect("A_candidate exceeds u128");
        set_a_side(market, opp, a_new);
        set_oi_eff(market, opp, oi_post);

        if !a_trunc_rem.is_zero() {
            let n_opp = get_stored_pos_count(market, opp) as u128;
            let n_opp_u256 = U256::from_u128(n_opp);
            let oi_plus_n = oi_u256.checked_add(n_opp_u256).unwrap_or(U256::MAX);
            let ceil_term = ceil_div_positive_checked(oi_plus_n, a_old_u256);
            let global_a_dust_bound = n_opp_u256.checked_add(ceil_term).unwrap_or(U256::MAX);
            let bound_u128 = global_a_dust_bound.try_into_u128().unwrap_or(u128::MAX);
            inc_phantom_dust_bound_by(market, opp, bound_u128);
        }

        if a_new < MIN_A_SIDE {
            set_side_mode(market, opp, SideState::DrainOnly);
        }
        return Ok(());
    }

    // Step 11: precision exhaustion terminal drain
    // H4 fix: deferred reset
    set_oi_eff(market, opp, 0u128);
    set_oi_eff(market, liq_side, 0u128);
    set_pending_reset_flag(market, opp);
    set_pending_reset_flag(market, liq_side);

    Ok(())
}

/// H4 fix: Set pending reset flag instead of calling begin_full_drain_reset eagerly.
/// Used by enqueue_adl for deferred reset pattern matching the reference.
fn set_pending_reset_flag(market: &mut Market, side: Side) {
    match side {
        Side::Long => market.pending_reset_long = true,
        Side::Short => market.pending_reset_short = true,
    }
}

/// H4 fix: Finalize pending resets. Call at end of each instruction handler
/// after all engine calls. This matches the reference's deferred pattern.
pub fn finalize_pending_resets(market: &mut Market) {
    if market.pending_reset_long {
        market.pending_reset_long = false;
        if get_side_mode(market, Side::Long) != SideState::ResetPending
            && get_oi_eff(market, Side::Long) == 0
        {
            begin_full_drain_reset(market, Side::Long);
        }
    }
    if market.pending_reset_short {
        market.pending_reset_short = false;
        if get_side_mode(market, Side::Short) != SideState::ResetPending
            && get_oi_eff(market, Side::Short) == 0
        {
            begin_full_drain_reset(market, Side::Short);
        }
    }
    maybe_finalize_ready_reset_sides(market);
}

// ============================================================================
// Loss settlement and profit conversion (spec §7)
// ============================================================================

/// settle_losses (spec §7.1): settle negative PnL from principal
pub fn settle_losses(position: &mut UserPosition, market: &mut Market) {
    let pnl = position.pnl;
    if pnl >= 0 { return; }
    assert!(pnl != i128::MIN, "settle_losses: i128::MIN");
    let need = pnl.unsigned_abs();
    let cap = position.deposited_collateral as u128;
    let pay = core::cmp::min(need, cap);
    if pay > 0 {
        set_capital(position, market, cap - pay).expect("settle_losses: set_capital overflow");
        let pay_i128 = pay as i128; // pay <= need = |pnl| <= i128::MAX, safe
        let new_pnl = pnl.checked_add(pay_i128).unwrap_or(0i128);
        if new_pnl == i128::MIN {
            set_pnl(position, market, 0i128);
        } else {
            set_pnl(position, market, new_pnl);
        }
    }
}

/// resolve_flat_negative (spec §7.3): for flat accounts with negative PnL
pub fn resolve_flat_negative(position: &mut UserPosition, market: &mut Market) {
    let eff = effective_position_q(position, market);
    if eff != 0 { return; }
    let pnl = position.pnl;
    if pnl < 0 {
        assert!(pnl != i128::MIN);
        let loss = pnl.unsigned_abs();
        absorb_protocol_loss(market, loss);
        set_pnl(position, market, 0i128);
    }
}

/// do_profit_conversion (spec §7.4): convert matured released profit to protected principal
pub fn do_profit_conversion(position: &mut UserPosition, market: &mut Market) {
    let x = released_pos(position);
    if x == 0 { return; }

    let (h_num, h_den) = haircut_ratio(market);
    let y: u128 = if h_den == 0 { x } else { wide_mul_div_floor_u128(x, h_num, h_den) };

    consume_released_pnl(position, market, x);

    let new_cap = (position.deposited_collateral as u128).checked_add(y).expect("capital overflow");
    set_capital(position, market, new_cap).expect("do_profit_conversion: set_capital overflow");

    if position.reserved_pnl == 0 {
        position.warmup_slope = 0;
        position.warmup_started_at_slot = market.current_slot;
    }
}

/// fee_debt_sweep (spec §7.5): after capital increase, sweep fee debt
pub fn fee_debt_sweep(position: &mut UserPosition, market: &mut Market) {
    let fc = position.fee_credits;
    let debt = fee_debt_u128_checked(fc);
    if debt == 0 { return; }
    let cap = position.deposited_collateral as u128;
    let pay = core::cmp::min(debt, cap);
    if pay > 0 {
        set_capital(position, market, cap - pay).expect("fee_debt_sweep: set_capital overflow");
        let pay_i128 = core::cmp::min(pay, i128::MAX as u128) as i128;
        position.fee_credits = position.fee_credits.saturating_add(pay_i128);
        market.insurance_fund_balance = market.insurance_fund_balance
            .saturating_add(core::cmp::min(pay, u64::MAX as u128) as u64);
    }
}

/// charge_fee_to_insurance (spec §8.1): route shortfall through fee_credits
pub fn charge_fee_to_insurance(
    position: &mut UserPosition,
    market: &mut Market,
    fee: u128,
) -> Result<()> {
    assert!(fee <= MAX_PROTOCOL_FEE_ABS, "charge_fee_to_insurance: fee exceeds MAX_PROTOCOL_FEE_ABS");
    let cap = position.deposited_collateral as u128;
    let fee_paid = core::cmp::min(fee, cap);
    if fee_paid > 0 {
        set_capital(position, market, cap - fee_paid)?;
        market.insurance_fund_balance = market.insurance_fund_balance
            .saturating_add(core::cmp::min(fee_paid, u64::MAX as u128) as u64);
        market.insurance_fee_revenue = market.insurance_fee_revenue
            .saturating_add(fee_paid);
    }
    let fee_shortfall = fee - fee_paid;
    if fee_shortfall > 0 {
        let shortfall_i128: i128 = if fee_shortfall > i128::MAX as u128 {
            return Err(PerkError::MathOverflow.into());
        } else {
            fee_shortfall as i128
        };
        let new_fc = position.fee_credits.checked_sub(shortfall_i128)
            .ok_or(PerkError::MathOverflow)?;
        if new_fc == i128::MIN {
            return Err(PerkError::MathOverflow.into());
        }
        position.fee_credits = new_fc;
    }
    Ok(())
}

/// deposit_fee_credits: add fee credits to account (spec §8.3)
pub fn deposit_fee_credits(position: &mut UserPosition, amount: u128) -> Result<()> {
    let amount_i128: i128 = amount.try_into().map_err(|_| PerkError::MathOverflow)?;
    let new_fc = position.fee_credits.checked_add(amount_i128)
        .ok_or(PerkError::MathOverflow)?;
    if new_fc == i128::MIN {
        return Err(PerkError::MathOverflow.into());
    }
    position.fee_credits = new_fc;
    Ok(())
}

// ============================================================================
// Warmup helpers
// ============================================================================

/// restart_warmup_after_reserve_increase (spec §4.9)
pub fn restart_warmup_after_reserve_increase(position: &mut UserPosition, market: &mut Market) {
    let t = market.warmup_period_slots;
    if t == 0 {
        set_reserved_pnl(position, market, 0);
        position.warmup_slope = 0;
        position.warmup_started_at_slot = market.current_slot;
        return;
    }
    let r = position.reserved_pnl;
    if r == 0 {
        position.warmup_slope = 0;
        position.warmup_started_at_slot = market.current_slot;
        return;
    }
    let base = r / (t as u128);
    let slope = if base == 0 { 1u128 } else { base };
    position.warmup_slope = slope;
    position.warmup_started_at_slot = market.current_slot;
}

// ============================================================================
// touch_account_full (spec §10.1)
// ============================================================================

/// Full account touch: accrue market, warmup, settle, losses, conversion, fees
pub fn touch_account_full(
    position: &mut UserPosition,
    market: &mut Market,
    oracle_price: u64,
    now_slot: u64,
) -> Result<()> {
    if now_slot < market.current_slot {
        return Err(PerkError::MathOverflow.into());
    }
    if oracle_price == 0 || oracle_price > MAX_ORACLE_PRICE {
        return Err(PerkError::OraclePriceInvalid.into());
    }

    // Step 5
    market.current_slot = now_slot;

    // Step 6: accrue_market_to
    accrue_market_to(market, now_slot, oracle_price)?;

    // Step 7: advance_profit_warmup
    advance_profit_warmup(position, market);

    // Step 8: settle_side_effects
    settle_side_effects(position, market)?;

    // Step 9: settle losses from principal
    settle_losses(position, market);

    // Step 10: resolve flat negative
    if effective_position_q(position, market) == 0 && position.pnl < 0 {
        resolve_flat_negative(position, market);
    }

    // Step 12: if flat, convert matured released profits
    if position.basis == 0 {
        do_profit_conversion(position, market);
    }

    // Step 13: fee debt sweep
    fee_debt_sweep(position, market);

    Ok(())
}

/// advance_profit_warmup (spec §4.9)
pub fn advance_profit_warmup(position: &mut UserPosition, market: &mut Market) {
    let r = position.reserved_pnl;
    if r == 0 {
        position.warmup_slope = 0;
        position.warmup_started_at_slot = market.current_slot;
        return;
    }
    let t = market.warmup_period_slots;
    if t == 0 {
        set_reserved_pnl(position, market, 0);
        position.warmup_slope = 0;
        position.warmup_started_at_slot = market.current_slot;
        return;
    }
    let elapsed = market.current_slot.saturating_sub(position.warmup_started_at_slot);
    let cap = saturating_mul_u128_u64(position.warmup_slope, elapsed);
    let release = core::cmp::min(r, cap);
    if release > 0 {
        set_reserved_pnl(position, market, r - release);
    }
    if position.reserved_pnl == 0 {
        position.warmup_slope = 0;
    }
    position.warmup_started_at_slot = market.current_slot;
}

// ============================================================================
// reclaim_empty_account (spec §10.8)
// ============================================================================

/// Permissionless cleanup: sweeps dust to insurance, zeros account
pub fn reclaim_empty_account(
    position: &mut UserPosition,
    market: &mut Market,
) -> Result<()> {
    // Must be flat with no PnL
    let eff = effective_position_q(position, market);
    if eff != 0 {
        return Err(PerkError::CorruptState.into());
    }
    if position.pnl != 0 {
        return Err(PerkError::CorruptState.into());
    }

    // Sweep remaining capital as dust to insurance
    let dust = position.deposited_collateral as u128;
    if dust > 0 {
        set_capital(position, market, 0)?;
        market.insurance_fund_balance = market.insurance_fund_balance
            .saturating_add(core::cmp::min(dust, u64::MAX as u128) as u64);
    }

    // Zero everything
    position.basis = 0;
    position.a_snapshot = ADL_ONE;
    position.k_snapshot = 0;
    position.reserved_pnl = 0;
    position.warmup_slope = 0;
    position.fee_credits = 0;

    Ok(())
}

// ============================================================================
// Backward-compat shims (for instruction files using old API)
// ============================================================================

/// Legacy attach_position taking i64 basis (wraps attach_effective_position)
pub fn attach_position(
    position: &mut UserPosition,
    market: &mut Market,
    new_basis: i64,
) {
    attach_effective_position(position, market, new_basis as i128);
}

// ============================================================================
// OI update helpers
// ============================================================================

/// Update OI from position changes
pub fn update_oi_delta(
    market: &mut Market,
    old_eff: i128,
    new_eff: i128,
) -> Result<()> {
    // Decrement old side
    if old_eff > 0 {
        let abs_old = old_eff.unsigned_abs();
        market.oi_eff_long_q = market.oi_eff_long_q.checked_sub(abs_old)
            .ok_or(PerkError::CorruptState)?;
    } else if old_eff < 0 {
        let abs_old = old_eff.unsigned_abs();
        market.oi_eff_short_q = market.oi_eff_short_q.checked_sub(abs_old)
            .ok_or(PerkError::CorruptState)?;
    }

    // Increment new side
    if new_eff > 0 {
        let abs_new = new_eff.unsigned_abs();
        market.oi_eff_long_q = market.oi_eff_long_q.checked_add(abs_new)
            .ok_or(PerkError::MathOverflow)?;
    } else if new_eff < 0 {
        let abs_new = new_eff.unsigned_abs();
        market.oi_eff_short_q = market.oi_eff_short_q.checked_add(abs_new)
            .ok_or(PerkError::MathOverflow)?;
    }

    Ok(())
}

// ============================================================================
// Margin checks (spec §9.1)
// ============================================================================

/// Oracle-derived equity for liquidation checks (v1.5.0).
///
/// Uses oracle price + entry data to compute unrealized PNL, instead of
/// K-settled `position.pnl` which can accumulate phantom PNL from K-index
/// shifts unrelated to actual price movement.
///
///   entry_notional = quote_entry_amount * peg_at_entry / POS_SCALE
///   oracle_notional = |base_size| * oracle_price / POS_SCALE
///   unrealized_pnl  = oracle_notional - entry_notional  (long)
///                    = entry_notional - oracle_notional  (short)
///   equity = max(0, collateral + unrealized_pnl - fee_debt)
fn oracle_equity_net(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> i128 {
    if position.base_size == 0 {
        // Flat position — equity is just collateral minus fee debt
        let fee_debt = fee_debt_u128_checked(position.fee_credits);
        let raw = (position.deposited_collateral as i128)
            .saturating_sub(fee_debt as i128);
        return if raw < 0 { 0i128 } else { raw };
    }

    let is_long = position.base_size > 0;
    let abs_base = (position.base_size as i64).unsigned_abs() as u128;

    // Oracle notional: |baseSize| * oraclePrice / POS_SCALE
    let oracle_notional = mul_div_floor_u128(abs_base, oracle_price as u128, POS_SCALE);

    // Entry notional: quoteEntryAmount * peg / POS_SCALE
    // Use peg_at_entry if available (v1.4.0+), fall back to market peg for legacy
    let peg = if position.peg_at_entry != 0 {
        position.peg_at_entry
    } else {
        market.peg_multiplier
    };
    let entry_notional = mul_div_floor_u128(position.quote_entry_amount, peg, POS_SCALE);

    // Unrealized PNL (signed)
    let unrealized_pnl: i128 = if is_long {
        (oracle_notional as i128).saturating_sub(entry_notional as i128)
    } else {
        (entry_notional as i128).saturating_sub(oracle_notional as i128)
    };

    // Equity = collateral + unrealized_pnl - fee_debt
    let fee_debt = fee_debt_u128_checked(position.fee_credits);
    let equity = (position.deposited_collateral as i128)
        .saturating_add(unrealized_pnl)
        .saturating_sub(fee_debt as i128);

    if equity < 0 { 0i128 } else { equity }
}

/// is_above_maintenance_margin: oracle_equity > MM_req
///
/// v1.5.0: Uses oracle-derived equity instead of K-settled PNL.
/// K-settled PNL can diverge from reality due to phantom PNL from
/// K-index shifts, making positions appear healthier than they are
/// and preventing liquidation.
pub fn is_above_maintenance_margin(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> bool {
    let eq_net = oracle_equity_net(position, market, oracle_price);
    let not = notional(position, market, oracle_price);
    let proportional = mul_div_floor_u128(not, market.maintenance_margin_bps as u128, 10_000);

    // M1 fix: Apply minimum MM requirement for non-zero positions
    let mm_req = if not > 0 {
        core::cmp::max(proportional, MIN_NONZERO_MM_REQ)
    } else {
        proportional
    };

    let mm_req_i128 = if mm_req > i128::MAX as u128 { i128::MAX } else { mm_req as i128 };
    eq_net > mm_req_i128
}

/// is_above_initial_margin: exact Eq_init_raw_i >= IM_req_i
pub fn is_above_initial_margin(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> bool {
    let eq_init_raw = account_equity_init_raw(market, position);
    let not = notional(position, market, oracle_price);
    // C1 (Pashov2): max_leverage is 100x-scaled (e.g. 2000 = 20x).
    // Divide by 100 first to get actual leverage, then compute IM BPS.
    let leverage_actual = (market.max_leverage as u128) / 100;
    // M1 (Pashov3): Ensure IM is strictly > MM
    let im_bps = if leverage_actual > 0 {
        let raw = (10_000u128).checked_div(leverage_actual).unwrap_or(10_000);
        core::cmp::max(raw, (MAINTENANCE_MARGIN_BPS as u128) + 1)
    } else {
        10_000
    };
    let proportional = mul_div_floor_u128(not, im_bps, 10_000);

    // C2 (Pashov2): Apply minimum IM requirement floor for non-zero positions
    let im_req = if not > 0 {
        core::cmp::max(proportional, MIN_NONZERO_IM_REQ as u128)
    } else {
        proportional
    };

    let im_req_i128 = if im_req > i128::MAX as u128 { i128::MAX } else { im_req as i128 };
    eq_init_raw >= im_req_i128
}

/// Conservation check (spec §3.1): V >= C_tot + I + claimable_fees
/// M1 (Pashov2): Include claimable fees as senior claims in conservation check.
pub fn check_conservation(market: &Market) -> bool {
    let claimable = (market.creator_claimable_fees as u128)
        .saturating_add(market.protocol_claimable_fees as u128);
    let senior = market.c_tot
        .checked_add(market.insurance_fund_balance as u128)
        .and_then(|s| s.checked_add(claimable));
    match senior {
        Some(s) => market.vault_balance >= s,
        None => false,
    }
}

/// Compute trade PnL: floor(size_q * price_diff / POS_SCALE)
/// M2 (Pashov2): For negative results with nonzero remainder, round away from zero (ceil magnitude).
pub fn compute_trade_pnl(size_q: i128, price_diff: i128) -> Result<i128> {
    if size_q == 0 || price_diff == 0 { return Ok(0); }
    let abs_size = size_q.unsigned_abs();
    let abs_diff = price_diff.unsigned_abs();
    let (q_u256, r_u256) = mul_div_floor_u256_with_rem(
        U256::from_u128(abs_size), U256::from_u128(abs_diff), U256::from_u128(POS_SCALE));
    let q = q_u256.try_into_u128().ok_or(PerkError::MathOverflow)?;
    let negative = (size_q > 0) != (price_diff > 0);
    // Round away from zero for negative results (protocol-favorable)
    let magnitude = if negative && !r_u256.is_zero() { q + 1 } else { q };
    if magnitude > i128::MAX as u128 {
        return Err(PerkError::MathOverflow.into());
    }
    if negative {
        Ok(-(magnitude as i128))
    } else {
        Ok(magnitude as i128)
    }
}
