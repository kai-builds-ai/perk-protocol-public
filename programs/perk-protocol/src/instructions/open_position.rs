/// Open a leveraged position via vAMM.
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup → open
/// Uses the new engine API: attach_effective_position, update_oi_delta, set_pnl(i128).
/// Pashov: total_positions only incremented on NEW positions (old base_size == 0).

use anchor_lang::prelude::*;
use crate::engine::{vamm, risk, warmup, oracle};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition, Side};

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref()],
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

pub fn handler(
    ctx: Context<OpenPosition>,
    side: Side,
    base_size: u64,
    leverage: u32,
    max_slippage_bps: u16,
) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(!ctx.accounts.protocol.paused, PerkError::ProtocolPaused);
    require!(market.active, PerkError::MarketNotActive);
    require!(base_size > 0, PerkError::InvalidAmount);

    // H5: Prevent base_size as i64 wrapping
    require!(base_size <= i64::MAX as u64, PerkError::MathOverflow);

    // Validate leverage
    require!(
        leverage >= crate::constants::MIN_LEVERAGE && leverage <= market.max_leverage,
        PerkError::InvalidLeverage
    );

    let clock = Clock::get()?;
    let is_long = side == Side::Long;

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

    // ── Pre-trade checks ──
    let old_base_size = position.base_size;

    // Reject position flipping (must close first, then reopen)
    if old_base_size != 0 {
        let existing_is_long = old_base_size > 0;
        require!(existing_is_long == is_long, PerkError::PositionFlipNotAllowed);
    }

    // Check side is open for new positions
    require!(
        risk::side_allows_increase(market, is_long),
        PerkError::SideBlocked
    );

    // H1: Check position size limits
    if market.max_position_size > 0 {
        let new_abs_size = if is_long {
            (position.base_size as i64)
                .checked_add(base_size as i64)
                .ok_or(PerkError::MathOverflow)?
                .unsigned_abs() as u128
        } else {
            (position.base_size as i64)
                .checked_sub(base_size as i64)
                .ok_or(PerkError::MathOverflow)?
                .unsigned_abs() as u128
        };
        require!(new_abs_size <= market.max_position_size, PerkError::PositionSizeLimitExceeded);
    }

    // H1: Check OI limits
    // M4 (Apex R2): Use effective OI (oi_eff_long_q/oi_eff_short_q) instead of raw tracking
    if market.max_oi > 0 {
        let new_oi = if is_long {
            market.oi_eff_long_q.checked_add(base_size as u128).ok_or(PerkError::MathOverflow)?
        } else {
            market.oi_eff_short_q.checked_add(base_size as u128).ok_or(PerkError::MathOverflow)?
        };
        require!(new_oi <= market.max_oi, PerkError::OiLimitExceeded);
    }

    // ── Pre-trade mark price for slippage check ──
    let pre_trade_mark = vamm::calculate_mark_price(market)?;

    // H3 (R3): TWAP sample on every trade for more funding rate observations
    // M2 (R4): Volume-weighted TWAP — weight by trade notional
    let trade_notional_for_twap = vamm::calculate_notional(base_size as u128, oracle_price)?;
    // ATK-07 fix: Cap single trade's TWAP contribution to prevent manipulation
    let max_twap_weight = market.k / 10; // 10% of vAMM invariant
    let capped_twap_weight = core::cmp::min(trade_notional_for_twap, max_twap_weight);
    market.mark_price_accumulator = market.mark_price_accumulator
        .saturating_add((pre_trade_mark as u128).saturating_mul(capped_twap_weight));
    market.twap_volume_accumulator = market.twap_volume_accumulator
        .saturating_add(capped_twap_weight);
    market.twap_observation_count = market.twap_observation_count.saturating_add(1);

    // ── Execute against vAMM ──
    let swap_result = if is_long {
        vamm::simulate_long(market, base_size as u128)?
    } else {
        vamm::simulate_short(market, base_size as u128)?
    };

    // Slippage check
    let slippage = vamm::calculate_slippage_bps(swap_result.execution_price, pre_trade_mark)?;
    require!(slippage <= max_slippage_bps, PerkError::SlippageExceeded);

    vamm::apply_swap(market, &swap_result);

    // ── Calculate and charge fee ──
    let notional = vamm::calculate_notional(base_size as u128, oracle_price)?;
    let total_fee = vamm::calculate_fee(notional, market.trading_fee_bps)?;

    let creator_fee_share = ctx.accounts.protocol.creator_fee_share_bps;
    let (creator_fee, protocol_fee) = if ctx.accounts.user.key() == market.creator {
        (0u128, total_fee)
    } else {
        vamm::split_fee(total_fee, creator_fee_share)?
    };

    // H4: Overflow check before u64 cast
    require!(total_fee <= u64::MAX as u128, PerkError::MathOverflow);
    let fee_u64 = total_fee as u64;
    position.deposited_collateral = position
        .deposited_collateral
        .checked_sub(fee_u64)
        .ok_or(PerkError::InsufficientCollateral)?;
    // M1: Use checked_sub instead of saturating_sub
    market.c_tot = market.c_tot.checked_sub(fee_u64 as u128)
        .ok_or(PerkError::MathOverflow)?;

    // ── Update position ──
    // Capture old effective for OI tracking
    let old_eff = risk::effective_position_q(position, market);

    if is_long {
        position.base_size = position.base_size
            .checked_add(base_size as i64)
            .ok_or(PerkError::MathOverflow)?;
    } else {
        position.base_size = position.base_size
            .checked_sub(base_size as i64)
            .ok_or(PerkError::MathOverflow)?;
    }
    position.quote_entry_amount = position
        .quote_entry_amount
        .checked_add(swap_result.quote_amount)
        .ok_or(PerkError::MathOverflow)?;

    // C4 fix: Compute new effective position from old_eff + trade_delta (not raw base_size)
    let trade_delta = if is_long { base_size as i128 } else { -(base_size as i128) };
    let new_eff_pos = old_eff.checked_add(trade_delta).ok_or(PerkError::MathOverflow)?;
    risk::attach_effective_position(position, market, new_eff_pos);

    // ── Update OI ──
    let new_eff = risk::effective_position_q(position, market);
    risk::update_oi_delta(market, old_eff, new_eff)?;

    // Pashov: total_long/short_position tracking
    if is_long {
        market.total_long_position = market.total_long_position
            .checked_add(base_size as u128)
            .ok_or(PerkError::MathOverflow)?;
    } else {
        market.total_short_position = market.total_short_position
            .checked_add(base_size as u128)
            .ok_or(PerkError::MathOverflow)?;
    }

    // Pashov: only increment total_positions on NEW positions
    if old_base_size == 0 {
        market.total_positions = market.total_positions.saturating_add(1);
    }

    // ── Margin check AFTER all state updates ──
    let is_margin_ok = risk::is_above_initial_margin(position, market, oracle_price);
    require!(is_margin_ok, PerkError::InsufficientMargin);

    // H4: Overflow checks for fee splits
    require!(creator_fee <= u64::MAX as u128, PerkError::MathOverflow);
    require!(protocol_fee <= u64::MAX as u128, PerkError::MathOverflow);

    // ── Track fees ──
    market.creator_claimable_fees = market.creator_claimable_fees
        .checked_add(creator_fee as u64).ok_or(PerkError::MathOverflow)?;
    market.protocol_claimable_fees = market.protocol_claimable_fees
        .checked_add(protocol_fee as u64).ok_or(PerkError::MathOverflow)?;
    market.creator_fees_earned = market.creator_fees_earned.saturating_add(creator_fee as u64);
    market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(protocol_fee as u64);
    market.total_volume = market.total_volume.saturating_add(notional);

    let protocol_mut = &mut ctx.accounts.protocol;
    protocol_mut.total_volume = protocol_mut.total_volume.saturating_add(notional);
    protocol_mut.total_fees_collected = protocol_mut.total_fees_collected.saturating_add(total_fee);

    // C5: Update last activity slot
    position.last_activity_slot = clock.slot;

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    msg!(
        "Position opened: side={:?}, size={}, leverage={}x, notional={}, fee={}",
        side, base_size, leverage, notional, total_fee,
    );

    Ok(())
}
