/// Liquidation Engine — Full-Fidelity Port from Percolator v11.26
///
/// Uses oracle-derived PnL for deficit calculation, proper fee splits,
/// and the full A/K deficit socialization path via enqueue_adl.
///
/// Liquidation uses maintenance margin check from risk engine (Eq_net_i > MM_req_i).

use crate::constants::*;
use crate::engine::risk;
use crate::engine::wide_math::mul_div_ceil_u128;
use crate::errors::PerkError;
use crate::state::{Market, UserPosition};
use anchor_lang::prelude::*;

/// Check if a position is liquidatable (spec §9.1)
/// Uses Eq_net_i <= MM_req_i from risk engine.
pub fn is_liquidatable(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> bool {
    if position.basis == 0 {
        return false; // No position
    }
    let eff = risk::effective_position_q(position, market);
    if eff == 0 {
        return false; // Position effectively zeroed by A/K
    }
    !risk::is_above_maintenance_margin(position, market, oracle_price)
}

/// Liquidation result details
pub struct LiquidationResult {
    pub closing_notional: u128,
    pub total_liq_fee: u128,
    pub liquidator_reward: u128,
    pub insurance_fee: u128,
    pub deficit: u128,
}

/// Calculate liquidation details using oracle-derived notional
pub fn calculate_liquidation(
    position: &UserPosition,
    market: &Market,
    oracle_price: u64,
) -> Result<LiquidationResult> {
    let eff = risk::effective_position_q(position, market);
    require!(eff != 0, PerkError::NoOpenPosition);

    let _abs_eff = eff.unsigned_abs();

    // Notional = floor(|eff_pos| * oracle_price / POS_SCALE)
    let closing_notional = risk::notional(position, market, oracle_price);

    // Liquidation fee: ceil(notional * liq_fee_bps / 10000)
    let total_liq_fee = if closing_notional > 0 && market.liquidation_fee_bps > 0 {
        mul_div_ceil_u128(closing_notional, market.liquidation_fee_bps as u128, BPS_DENOMINATOR as u128)
    } else {
        0
    };

    // Split: 50% to liquidator, 50% to insurance
    let liquidator_reward = total_liq_fee
        .checked_mul(LIQUIDATOR_SHARE_BPS as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(PerkError::MathOverflow)?;

    let insurance_fee = total_liq_fee.saturating_sub(liquidator_reward);

    // Compute equity for deficit: C_i + PnL_i - FeeDebt
    let equity_raw = risk::account_equity_maint_raw(position);

    let deficit = if equity_raw < 0 {
        (equity_raw as i128).unsigned_abs()
    } else {
        0u128
    };

    Ok(LiquidationResult {
        closing_notional,
        total_liq_fee,
        liquidator_reward,
        insurance_fee,
        deficit,
    })
}

// H2 (Apex R2): check_and_liquidate was dead code with a double OI decrement bug.
// Removed entirely. Liquidation is handled by the `liquidate` instruction handler.
