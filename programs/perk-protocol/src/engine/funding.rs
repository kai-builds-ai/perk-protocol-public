/// Funding Rate Engine — Full-Fidelity Port from Percolator v11.26
///
/// Funding is applied through K-coefficients in accrue_market_to (spec §5.4).
/// This module provides rate calculation and the per-slot rate storage interface.
///
/// The actual per-account funding settlement happens through settle_side_effects
/// (K-difference). This module handles:
/// - Rate computation from mark-oracle premium
/// - Anti-retroactivity (stored rate for next interval)
/// - TWAP mark price computation

use crate::constants::*;
use crate::errors::PerkError;
use crate::state::Market;
use anchor_lang::prelude::*;

/// Calculate the funding rate based on mark-oracle premium (spec §5.5)
///
/// premium = (mark_price - oracle_price) / oracle_price
/// funding_rate = clamp(premium, -cap, +cap)
///
/// Returns funding rate in BPS per slot
pub fn calculate_funding_rate(
    mark_price: u64,
    oracle_price: u64,
    cap_bps: u16,
) -> Result<i64> {
    if oracle_price == 0 {
        return Err(PerkError::OraclePriceInvalid.into());
    }

    let mark = mark_price as i128;
    let oracle = oracle_price as i128;
    let diff = mark.checked_sub(oracle).ok_or(PerkError::MathOverflow)?;

    let premium_scaled = diff
        .checked_mul(BPS_DENOMINATOR as i128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(oracle)
        .ok_or(PerkError::MathOverflow)?;

    let cap = cap_bps as i64;
    let clamped = if premium_scaled > cap as i128 {
        cap
    } else if premium_scaled < -(cap as i128) {
        -cap
    } else {
        premium_scaled as i64
    };

    // Clamp to MAX_ABS_FUNDING_BPS_PER_SLOT
    let final_rate = if clamped > MAX_ABS_FUNDING_BPS_PER_SLOT {
        MAX_ABS_FUNDING_BPS_PER_SLOT
    } else if clamped < -MAX_ABS_FUNDING_BPS_PER_SLOT {
        -MAX_ABS_FUNDING_BPS_PER_SLOT
    } else {
        clamped
    };

    Ok(final_rate)
}

/// H4: Check if both sides have sufficient OI for funding to accrue
pub fn has_sufficient_oi_for_funding(market: &Market) -> bool {
    market.oi_eff_long_q > 0 && market.oi_eff_short_q > 0
}

/// Set the funding rate for the next interval (spec §5.5 anti-retroactivity)
/// The rate is stored and used by accrue_market_to in subsequent slots.
pub fn set_funding_rate(market: &mut Market, new_rate: i64) {
    crate::engine::risk::set_funding_rate_for_next_interval(market, new_rate);
}

/// Check if the funding period has elapsed
pub fn is_funding_due(market: &Market, current_time: i64) -> bool {
    let elapsed = current_time.saturating_sub(market.last_funding_time);
    elapsed >= market.funding_period_seconds as i64
}

// H2 (Apex R2): Removed dead legacy functions `settle_user_funding` and `apply_funding`.
// Funding is settled through K-coefficients in settle_side_effects (spec §5.3).

/// Compute and apply funding rate update.
/// This should be called by the funding crank instruction.
pub fn update_funding(
    market: &mut Market,
    current_mark_price: u64,
    oracle_price: u64,
) -> Result<()> {
    if !has_sufficient_oi_for_funding(market) {
        // No funding when one side is empty
        return Ok(());
    }

    // M8 fix: Use TWAP accumulator if we have observations, else fall back to 2-sample
    // M2 (R4): Volume-weighted TWAP — divide by volume accumulator instead of count
    let twap_mark = if market.twap_volume_accumulator > 0 {
        (market.mark_price_accumulator / market.twap_volume_accumulator) as u64
    } else if market.twap_observation_count >= 2 {
        // Fallback for legacy non-volume-weighted observations (shouldn't happen after R4)
        (market.mark_price_accumulator / market.twap_observation_count as u128) as u64
    } else {
        let last_mark = if market.last_mark_price_for_funding == 0 {
            current_mark_price
        } else {
            market.last_mark_price_for_funding
        };
        ((current_mark_price as u128 + last_mark as u128) / 2) as u64
    };

    let rate = calculate_funding_rate(
        twap_mark,
        oracle_price,
        market.funding_rate_cap_bps,
    )?;

    // C2 fix: Rate is computed as bps-per-period but applied per-slot in accrue_market_to.
    // Divide by slots_per_period AFTER capping to get per-slot rate.
    let slots_per_period = if market.funding_period_seconds > 0 {
        // ~2.5 slots/sec on Solana
        (market.funding_period_seconds as u64) * 5 / 2
    } else {
        1
    };
    // C1 (R3): Scale rate up by FUNDING_RATE_PRECISION BEFORE dividing by slots_per_period
    // to prevent integer truncation (e.g. 10 / 9000 = 0 without scaling).
    // The stored rate is now in scaled units; accrue_market_to divides out the precision.
    // L2 (R4): The integer division below introduces ~0.1% truncation per funding period.
    // This is acceptable: the error is small, bounded, and non-cumulative since the rate
    // is recomputed each period. The FUNDING_RATE_PRECISION scaling minimizes truncation.
    let rate_per_slot = if slots_per_period > 1 {
        let rate_scaled = rate.checked_mul(FUNDING_RATE_PRECISION)
            .ok_or(PerkError::MathOverflow)?;
        rate_scaled / (slots_per_period as i64)
    } else {
        rate.checked_mul(FUNDING_RATE_PRECISION)
            .ok_or(PerkError::MathOverflow)?
    };

    set_funding_rate(market, rate_per_slot);
    market.last_mark_price_for_funding = current_mark_price;

    Ok(())
}
