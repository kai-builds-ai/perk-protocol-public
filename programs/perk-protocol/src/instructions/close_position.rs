/// Close a position (fully or partially).
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup → close
/// Uses effective_matured_pnl for settlement (warmup-aware with haircut).
/// PnL from entry vs exit, applied via set_pnl(i128).

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::engine::{vamm, risk, warmup, oracle};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition};

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump = user_position.bump,
        has_one = authority @ PerkError::Unauthorized,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    #[account(constraint = user.key() == user_position.authority @ PerkError::Unauthorized)]
    pub authority: Signer<'info>,

    pub user: Signer<'info>,
}

pub fn handler(ctx: Context<ClosePosition>, base_size_to_close: Option<u64>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(position.base_size != 0, PerkError::NoOpenPosition);

    let clock = Clock::get()?;

    // ── Standard accrue pattern ──
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    risk::accrue_market_to(market, clock.slot, oracle_price)?;
    risk::settle_side_effects(position, market)?;
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // H4 (Pashov3): Min 1-slot holding period to prevent atomic TWAP manipulation
    require!(
        clock.slot > position.last_activity_slot,
        PerkError::MinHoldingPeriodNotMet
    );

    // ── Determine close size ──
    let is_long = position.base_size > 0;
    let abs_position = (position.base_size as i64).unsigned_abs();

    let close_size = match base_size_to_close {
        Some(size) => {
            require!(size > 0 && size <= abs_position, PerkError::InvalidAmount);
            let remaining = abs_position.checked_sub(size).unwrap_or(0);
            if remaining > 0 {
                require!(remaining >= MIN_REMAINING_POSITION_SIZE, PerkError::RemainingPositionTooSmall);
            }
            size
        }
        None => abs_position,
    };

    // H3 (R3): TWAP sample on every trade for more funding rate observations
    // M2 (R4): Volume-weighted TWAP — weight by trade notional
    let current_mark = vamm::calculate_mark_price(market)?;
    let close_notional_for_twap = vamm::calculate_notional(close_size as u128, oracle_price)?;
    // ATK-07 fix: Cap single trade's TWAP contribution to prevent manipulation
    let max_twap_weight = market.k / 10; // 10% of vAMM invariant
    let capped_twap_weight = core::cmp::min(close_notional_for_twap, max_twap_weight);
    market.mark_price_accumulator = market.mark_price_accumulator
        .saturating_add((current_mark as u128).saturating_mul(capped_twap_weight));
    market.twap_volume_accumulator = market.twap_volume_accumulator
        .saturating_add(capped_twap_weight);
    market.twap_observation_count = market.twap_observation_count.saturating_add(1);

    // C4: Capture old effective position BEFORE any changes (preserves A/K)
    let old_eff = risk::effective_position_q(position, market);

    // ── Execute reverse trade against vAMM (adjusts reserves, NOT PnL source) ──
    // C4: Use effective position for close size in vAMM, not raw base_size
    let eff_close_size = if old_eff == 0 {
        close_size as u128
    } else {
        let eff_abs = old_eff.unsigned_abs();
        if close_size as u64 == abs_position {
            // Full close — use entire effective position
            eff_abs
        } else {
            // Partial close — proportional effective size
            eff_abs.checked_mul(close_size as u128)
                .ok_or(PerkError::MathOverflow)?
                .checked_div(abs_position as u128)
                .ok_or(PerkError::MathOverflow)?
        }
    };

    let swap_result = if is_long {
        vamm::simulate_short(market, eff_close_size)?
    } else {
        vamm::simulate_long(market, eff_close_size)?
    };

    // C2 fix: NO vAMM-derived PnL computation. PnL comes EXCLUSIVELY from K-diff
    // (already applied by settle_side_effects above). The vAMM swap only adjusts reserves.

    // ── Calculate and charge trading fee ──
    let closing_notional = vamm::calculate_notional(close_size as u128, oracle_price)?;
    let total_fee = vamm::calculate_fee(closing_notional, market.trading_fee_bps)?;

    // H4: Overflow check before u64 cast
    require!(total_fee <= u64::MAX as u128, PerkError::MathOverflow);

    let creator_fee_share = ctx.accounts.protocol.creator_fee_share_bps;

    // M1: Use checked_sub instead of saturating_sub for fee deduction from c_tot
    // H1 (Pashov3): Fee split moved inside branches — only credit actually-collected amount
    let fee_u64 = total_fee as u64;
    let is_creator = ctx.accounts.user.key() == market.creator;
    if let Some(new_collateral) = position.deposited_collateral.checked_sub(fee_u64) {
        market.c_tot = market.c_tot.checked_sub(fee_u64 as u128)
            .ok_or(PerkError::MathOverflow)?;
        position.deposited_collateral = new_collateral;
        // Credit full fee
        let (cr_fee, pr_fee) = vamm::compute_fee_split(total_fee, creator_fee_share, is_creator);
        market.creator_claimable_fees = market.creator_claimable_fees
            .checked_add(cr_fee as u64).ok_or(PerkError::MathOverflow)?;
        market.protocol_claimable_fees = market.protocol_claimable_fees
            .checked_add(pr_fee as u64).ok_or(PerkError::MathOverflow)?;
        market.creator_fees_earned = market.creator_fees_earned.saturating_add(cr_fee as u64);
        market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(pr_fee as u64);
    } else {
        // H3 (Pashov2): Fee exceeds collateral — deduct what we can from collateral,
        // charge remainder through fee_credits (recoverable debt) instead of PnL.
        let collateral_part = position.deposited_collateral;
        market.c_tot = market.c_tot.checked_sub(collateral_part as u128)
            .ok_or(PerkError::MathOverflow)?;
        position.deposited_collateral = 0;
        let remaining_fee = (fee_u64 as u128).saturating_sub(collateral_part as u128);
        risk::charge_fee_to_insurance(position, market, remaining_fee)?;
        // Only credit the portion actually collected
        let actually_collected = collateral_part as u128;
        let (cr_fee, pr_fee) = vamm::compute_fee_split(actually_collected, creator_fee_share, is_creator);
        market.creator_claimable_fees = market.creator_claimable_fees
            .checked_add(cr_fee as u64).ok_or(PerkError::MathOverflow)?;
        market.protocol_claimable_fees = market.protocol_claimable_fees
            .checked_add(pr_fee as u64).ok_or(PerkError::MathOverflow)?;
        market.creator_fees_earned = market.creator_fees_earned.saturating_add(cr_fee as u64);
        market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(pr_fee as u64);
    }

    // Apply swap to vAMM
    vamm::apply_swap(market, &swap_result);

    // ── Update position size ──
    if is_long {
        position.base_size = position.base_size
            .checked_sub(close_size as i64).ok_or(PerkError::MathOverflow)?;
    } else {
        position.base_size = position.base_size
            .checked_add(close_size as i64).ok_or(PerkError::MathOverflow)?;
    }

    // Update entry quote proportionally
    let entry_quote_proportion = if abs_position > 0 {
        position.quote_entry_amount
            .checked_mul(close_size as u128)
            .ok_or(PerkError::MathOverflow)?
            .checked_div(abs_position as u128)
            .ok_or(PerkError::MathOverflow)?
    } else {
        0u128
    };
    position.quote_entry_amount = position.quote_entry_amount.saturating_sub(entry_quote_proportion);

    // ── C4 fix: Compute new effective position from old_eff + trade_delta ──
    // C1 (Apex R2): Use eff_close_size, not raw close_size, for trade delta
    let trade_delta = if is_long {
        -(eff_close_size as i128)
    } else {
        eff_close_size as i128
    };
    let new_eff_pos = old_eff.checked_add(trade_delta).ok_or(PerkError::MathOverflow)?;
    risk::attach_effective_position(position, market, new_eff_pos);

    let new_eff = risk::effective_position_q(position, market);
    risk::update_oi_delta(market, old_eff, new_eff)?;

    // Update total_long/short_position
    if is_long {
        market.total_long_position = market.total_long_position.saturating_sub(close_size as u128);
    } else {
        market.total_short_position = market.total_short_position.saturating_sub(close_size as u128);
    }

    // Position count
    if position.base_size == 0 {
        position.quote_entry_amount = 0;
        market.total_positions = market.total_positions.saturating_sub(1);
    }

    // ── Track volume (fees already credited inside the if/else above) ──
    market.total_volume = market.total_volume.saturating_add(closing_notional);

    // ── PnL settlement ──
    if position.base_size == 0 {
        // Full close: use proper Percolator flow
        risk::do_profit_conversion(position, market);
        risk::settle_losses(position, market);
        risk::resolve_flat_negative(position, market);
        // M2 fix: Removed unconditional set_pnl(0). The conversion/settle/resolve
        // sequence should leave PnL at 0. Verify with debug_assert.
        // M2 (R3): PnL may be slightly positive due to rounding; only negative is wrong
        debug_assert!(position.pnl >= 0, "PnL should be non-negative after full close settlement");
    } else {
        // M10 fix: Call do_profit_conversion on partial closes too (when released PnL exists)
        // This prevents warmup bypass by partial-closing to extract unreleased profit.
        if risk::released_pos(position) > 0 {
            risk::do_profit_conversion(position, market);
        }
    }

    // H2: Check phantom dust clearance after OI reduction
    let close_side = if is_long { risk::Side::Long } else { risk::Side::Short };
    risk::check_and_clear_phantom_dust(market, close_side);

    // C5: Update last activity slot
    position.last_activity_slot = clock.slot;

    // Protocol stats
    let protocol_mut = &mut ctx.accounts.protocol;
    protocol_mut.total_volume = protocol_mut.total_volume.saturating_add(closing_notional);
    protocol_mut.total_fees_collected = protocol_mut.total_fees_collected.saturating_add(total_fee);

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!("Position closed: size={}, fee={}", close_size, total_fee);
    Ok(())
}
