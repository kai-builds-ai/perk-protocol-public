/// Margin Engine — Full-Fidelity Port from Percolator v11.26
///
/// Uses the Percolator equity formulas (spec §3.4):
/// - Eq_maint_raw: C + PNL - FeeDebt (for maintenance checks)
/// - Eq_init_raw: C + min(PNL,0) + PNL_eff_matured - FeeDebt (for IM/withdrawal)
///
/// Notional is computed from effective_position_q (A/K-adjusted).
/// All margin checks use oracle price directly.

use crate::constants::*;
use crate::engine::risk;
use crate::engine::wide_math::mul_div_floor_u128;
use crate::errors::PerkError;
use crate::state::{Market, UserPosition};
use anchor_lang::prelude::*;

/// Compute unrealized PnL from oracle price (legacy compat for instruction files)
///
/// For longs: unrealized_pnl = (oracle_price - avg_entry_price) * |base_size|
/// For shorts: unrealized_pnl = (avg_entry_price - oracle_price) * |base_size|
pub fn compute_unrealized_pnl(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> Result<i64> {
    if position.base_size == 0 {
        return Ok(0);
    }

    let abs_base = (position.base_size as i64).unsigned_abs() as u128;
    if abs_base == 0 {
        return Ok(0);
    }

    let current_value = abs_base
        .checked_mul(oracle_price as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(PRICE_SCALE as u128)
        .ok_or(PerkError::MathOverflow)?;

    let entry_value = position
        .quote_entry_amount
        .checked_mul(market.peg_multiplier)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(PEG_SCALE as u128)
        .ok_or(PerkError::MathOverflow)?;

    let is_long = position.base_size > 0;

    let unrealized_pnl = if is_long {
        (current_value as i128)
            .checked_sub(entry_value as i128)
            .ok_or(PerkError::MathOverflow)?
    } else {
        (entry_value as i128)
            .checked_sub(current_value as i128)
            .ok_or(PerkError::MathOverflow)?
    };

    Ok(unrealized_pnl as i64)
}

/// Validate leverage is within bounds
pub fn validate_leverage(leverage: u32, max_leverage: u32) -> Result<()> {
    require!(
        leverage >= MIN_LEVERAGE && leverage <= max_leverage,
        PerkError::InvalidLeverage
    );
    Ok(())
}

/// Calculate initial margin requirement: notional * im_bps / 10_000
pub fn initial_margin_required(notional: u128, leverage: u32) -> Result<u128> {
    if leverage == 0 {
        return Err(PerkError::InvalidLeverage.into());
    }
    // IM_bps = 10_000 / leverage (e.g., 20x → 500 bps = 5%)
    let im_bps = (10_000u128)
        .checked_div(leverage as u128)
        .ok_or(PerkError::MathOverflow)?;
    let margin = mul_div_floor_u128(notional, im_bps, 10_000);
    Ok(margin)
}

/// Calculate maintenance margin requirement: notional * mm_bps / 10_000
pub fn maintenance_margin_required(notional: u128, mm_bps: u16) -> Result<u128> {
    let margin = mul_div_floor_u128(notional, mm_bps as u128, 10_000);
    Ok(margin)
}

/// Calculate margin ratio: (equity) / notional in BPS
pub fn margin_ratio_bps(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> Result<u16> {
    let not = risk::notional(position, market, oracle_price);
    if not == 0 {
        return Ok(u16::MAX);
    }

    let equity = risk::account_equity_maint_raw(position);
    if equity <= 0 {
        return Ok(0);
    }

    let ratio = (equity as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(not)
        .ok_or(PerkError::MathOverflow)?;

    Ok(core::cmp::min(ratio, u16::MAX as u128) as u16)
}

/// Check if user is above maintenance margin (spec §9.1)
/// Delegates to risk::is_above_maintenance_margin which uses Eq_net_i > MM_req_i
pub fn is_above_maintenance_margin(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> Result<bool> {
    Ok(risk::is_above_maintenance_margin(position, market, oracle_price))
}

/// Check if user is above initial margin (spec §9.1)
/// Uses Eq_init_raw_i >= IM_req_i with haircutted matured PnL
pub fn is_above_initial_margin(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> Result<bool> {
    Ok(risk::is_above_initial_margin(position, market, oracle_price))
}

/// Post-trade margin enforcement (spec §10.5 step 29)
///
/// For each account:
/// - If position was flat and now has position: require IM
/// - If position increased: require IM
/// - If position decreased but not flat: buffer must not decrease
/// - If position went flat: no margin requirement
pub fn enforce_post_trade_margin(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
    old_eff: i128,
    new_eff: i128,
) -> Result<()> {
    if new_eff == 0 {
        // Went flat — no margin requirement
        return Ok(());
    }

    let old_abs = old_eff.unsigned_abs();
    let new_abs = new_eff.unsigned_abs();

    // Position increased (or was flat): require initial margin
    if new_abs > old_abs || old_eff == 0 {
        if !risk::is_above_initial_margin(position, market, oracle_price) {
            return Err(PerkError::InsufficientMargin.into());
        }
    }
    // Position decreased but not flat: require maintenance margin at minimum
    else if new_abs < old_abs {
        if !risk::is_above_maintenance_margin(position, market, oracle_price) {
            return Err(PerkError::InsufficientMargin.into());
        }
    }

    Ok(())
}

/// Validate position bounds (spec §10.4)
pub fn validate_position_bounds(
    new_eff: i128,
    oracle_price: u64,
) -> Result<()> {
    if new_eff == 0 { return Ok(()); }

    let abs_eff = new_eff.unsigned_abs();
    if abs_eff > MAX_POSITION_ABS_Q {
        return Err(PerkError::MathOverflow.into());
    }

    let notional_val = mul_div_floor_u128(abs_eff, oracle_price as u128, POS_SCALE);
    if notional_val > MAX_ACCOUNT_NOTIONAL {
        return Err(PerkError::MathOverflow.into());
    }

    Ok(())
}
