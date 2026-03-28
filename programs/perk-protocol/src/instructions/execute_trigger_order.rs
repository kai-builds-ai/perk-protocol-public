/// Execute a trigger order. Permissionless — anyone can call (cranker incentive).
///
/// COMPLETE REWRITE — uses new engine API (i128 PnL, attach_effective_position, etc.)
/// All known bugs fixed. See module-level comments for details.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, TransferChecked, Mint};
use crate::constants::*;
use crate::engine::{vamm, oracle, risk, warmup};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition, TriggerOrder, TriggerOrderType, Side};

#[derive(Accounts)]
pub struct ExecuteTriggerOrder<'info> {
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
        seeds = [b"position", market.key().as_ref(), trigger_order.authority.as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    // M6 fix: PDA seed validation to prevent spoofed trigger orders
    #[account(
        mut,
        close = executor,
        seeds = [b"trigger", market.key().as_ref(), trigger_order.authority.as_ref(), &trigger_order.order_id.to_le_bytes()],
        bump = trigger_order.bump,
        constraint = trigger_order.market == market.key() @ PerkError::Unauthorized,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    /// Collateral mint (needed for transfer_checked — validated against market)
    #[account(constraint = collateral_mint.key() == market.collateral_mint @ PerkError::TokenMintMismatch)]
    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = executor_token_account.mint == market.collateral_mint,
        constraint = executor_token_account.owner == executor.key(),
    )]
    pub executor_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub executor: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<ExecuteTriggerOrder>) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let market_account_info = ctx.accounts.market.to_account_info();
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;
    let order = &ctx.accounts.trigger_order;

    // ── Checks ──
    require!(!protocol.paused, PerkError::ProtocolPaused);
    require!(market.active, PerkError::MarketNotActive);

    let clock = Clock::get()?;

    if order.expiry > 0 {
        require!(clock.unix_timestamp <= order.expiry, PerkError::TriggerOrderExpired);
    }
    let order_age = clock.unix_timestamp.saturating_sub(order.created_at);
    require!(order_age <= MAX_TRIGGER_ORDER_AGE_SECONDS, PerkError::TriggerOrderTooOld);

    // ── Read oracle price ──
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    // ── Check trigger condition ──
    let condition_met = match order.order_type {
        TriggerOrderType::Limit => match order.side {
            Side::Long => oracle_price <= order.trigger_price,
            Side::Short => oracle_price >= order.trigger_price,
        },
        TriggerOrderType::StopLoss => match order.side {
            Side::Long => oracle_price <= order.trigger_price,
            Side::Short => oracle_price >= order.trigger_price,
        },
        TriggerOrderType::TakeProfit => match order.side {
            Side::Long => oracle_price >= order.trigger_price,
            Side::Short => oracle_price <= order.trigger_price,
        },
    };
    require!(condition_met, PerkError::TriggerConditionNotMet);

    // ── Standard accrue pattern ──
    risk::accrue_market_to(market, clock.slot, oracle_price)?;
    risk::settle_side_effects(position, market)?;
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // H3 (R3): TWAP sample on every trade for more funding rate observations
    // M2 (R4): Volume-weighted TWAP — weight by trade notional (computed after trade path)
    let current_mark = vamm::calculate_mark_price(market)?;

    let old_base_size = position.base_size;

    // H5: Prevent base_size as i64 wrapping
    require!(order.size <= i64::MAX as u64, PerkError::MathOverflow);

    // ══════════════════════════════════════════════════════════════════════
    let trade_notional: u128;

    if order.reduce_only {
        // ── REDUCE-ONLY PATH ──
        require!(position.base_size != 0, PerkError::NoOpenPosition);

        // H4 (Pashov3): Min 1-slot holding period to prevent atomic TWAP manipulation
        require!(
            clock.slot > position.last_activity_slot,
            PerkError::MinHoldingPeriodNotMet
        );

        let is_long = position.base_size > 0;
        let abs_pos = (position.base_size as i64).unsigned_abs() as u128;
        let close_size = core::cmp::min(order.size as u128, abs_pos);

        // M5 (Pashov3): Enforce MIN_REMAINING_POSITION_SIZE for partial closes
        let remaining = abs_pos.saturating_sub(close_size);
        if remaining > 0 {
            require!(remaining >= MIN_REMAINING_POSITION_SIZE as u128, PerkError::RemainingPositionTooSmall);
        }

        // C4: Capture old effective position BEFORE changes
        let old_eff = risk::effective_position_q(position, market);

        // C4: Use effective position for vAMM close size
        let eff_close_size = if old_eff == 0 {
            close_size
        } else {
            let eff_abs = old_eff.unsigned_abs();
            if close_size == abs_pos {
                eff_abs
            } else {
                eff_abs.checked_mul(close_size)
                    .ok_or(PerkError::MathOverflow)?
                    .checked_div(abs_pos)
                    .ok_or(PerkError::MathOverflow)?
            }
        };

        // Execute reverse trade (vAMM adjusts reserves only — NOT PnL source)
        let swap_result = if is_long {
            vamm::simulate_short(market, eff_close_size)?
        } else {
            vamm::simulate_long(market, eff_close_size)?
        };

        // C2 fix: NO vAMM-derived PnL. PnL comes exclusively from K-diff
        // (already applied by settle_side_effects above)

        vamm::apply_swap(market, &swap_result);

        // Update position size
        if is_long {
            position.base_size = position.base_size
                .checked_sub(close_size as i64).ok_or(PerkError::MathOverflow)?;
        } else {
            position.base_size = position.base_size
                .checked_add(close_size as i64).ok_or(PerkError::MathOverflow)?;
        }
        let entry_quote_proportion = if abs_pos > 0 {
            position.quote_entry_amount
                .checked_mul(close_size).ok_or(PerkError::MathOverflow)?
                .checked_div(abs_pos).ok_or(PerkError::MathOverflow)?
        } else { 0u128 };
        position.quote_entry_amount = position.quote_entry_amount.saturating_sub(entry_quote_proportion);

        // Charge trading fee
        let close_notional = vamm::calculate_notional(close_size, oracle_price)?;
        let trading_fee = vamm::calculate_fee(close_notional, market.trading_fee_bps)?;

        // H4: Overflow check before u64 cast
        require!(trading_fee <= u64::MAX as u128, PerkError::MathOverflow);

        // M1: Use checked_sub instead of saturating_sub for c_tot
        // H1 (Pashov3): Fee split moved inside branches — only credit actually-collected amount
        let fee_u64 = trading_fee as u64;
        let is_creator_ro = order.authority == market.creator;
        if let Some(new_col) = position.deposited_collateral.checked_sub(fee_u64) {
            market.c_tot = market.c_tot.checked_sub(fee_u64 as u128)
                .ok_or(PerkError::MathOverflow)?;
            position.deposited_collateral = new_col;
            // Credit full fee
            let (cr_fee, pr_fee) = vamm::compute_fee_split(trading_fee, protocol.creator_fee_share_bps, is_creator_ro);
            market.creator_claimable_fees = market.creator_claimable_fees
                .checked_add(cr_fee as u64).ok_or(PerkError::MathOverflow)?;
            market.protocol_claimable_fees = market.protocol_claimable_fees
                .checked_add(pr_fee as u64).ok_or(PerkError::MathOverflow)?;
            market.creator_fees_earned = market.creator_fees_earned.saturating_add(cr_fee as u64);
            market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(pr_fee as u64);
        } else {
            // H3 (Pashov2): Fee exceeds collateral — deduct what we can from collateral,
            // charge remainder through fee_credits (recoverable debt) instead of PnL.
            let col_part = position.deposited_collateral;
            market.c_tot = market.c_tot.checked_sub(col_part as u128)
                .ok_or(PerkError::MathOverflow)?;
            position.deposited_collateral = 0;
            let remaining_fee = (fee_u64 as u128).saturating_sub(col_part as u128);
            risk::charge_fee_to_insurance(position, market, remaining_fee)?;
            // Only credit the portion actually collected
            let actually_collected = col_part as u128;
            let (cr_fee, pr_fee) = vamm::compute_fee_split(actually_collected, protocol.creator_fee_share_bps, is_creator_ro);
            market.creator_claimable_fees = market.creator_claimable_fees
                .checked_add(cr_fee as u64).ok_or(PerkError::MathOverflow)?;
            market.protocol_claimable_fees = market.protocol_claimable_fees
                .checked_add(pr_fee as u64).ok_or(PerkError::MathOverflow)?;
            market.creator_fees_earned = market.creator_fees_earned.saturating_add(cr_fee as u64);
            market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(pr_fee as u64);
        }

        // C4 fix: Compute new_eff from old_eff + trade_delta
        // C1 (Apex R2): Use eff_close_size, not raw close_size, for trade delta
        let trade_delta = if is_long { -(eff_close_size as i128) } else { eff_close_size as i128 };
        let new_eff_pos = old_eff.checked_add(trade_delta).ok_or(PerkError::MathOverflow)?;
        risk::attach_effective_position(position, market, new_eff_pos);
        let new_eff = risk::effective_position_q(position, market);
        risk::update_oi_delta(market, old_eff, new_eff)?;

        if is_long {
            market.total_long_position = market.total_long_position.saturating_sub(close_size);
        } else {
            market.total_short_position = market.total_short_position.saturating_sub(close_size);
        }

        if position.base_size == 0 {
            position.quote_entry_amount = 0;
            market.total_positions = market.total_positions.saturating_sub(1);

            // H6 + C2: Use proper Percolator flow for PnL settlement
            risk::do_profit_conversion(position, market);
            risk::settle_losses(position, market);
            risk::resolve_flat_negative(position, market);
            // M2 fix: Removed unconditional set_pnl(0)
            // M2 (R3): PnL may be slightly positive due to rounding; only negative is wrong
            debug_assert!(position.pnl >= 0, "PnL should be non-negative after full close settlement");
        }

        // H2: Check phantom dust clearance after OI reduction
        let close_side = if is_long { risk::Side::Long } else { risk::Side::Short };
        risk::check_and_clear_phantom_dust(market, close_side);

        trade_notional = close_notional;
    } else {
        // ── NON-REDUCE-ONLY PATH (open/increase) ──
        let is_long = order.side == Side::Long;
        let base_size = order.size as u128;

        // Validate leverage
        require!(
            order.leverage >= crate::constants::MIN_LEVERAGE && order.leverage <= market.max_leverage,
            PerkError::InvalidLeverage
        );

        // Check position flip
        if old_base_size != 0 {
            let existing_is_long = old_base_size > 0;
            require!(existing_is_long == is_long, PerkError::PositionFlipNotAllowed);
        }

        // Check side allows increase
        require!(risk::side_allows_increase(market, is_long), PerkError::SideBlocked);

        // H1: Position size limits
        if market.max_position_size > 0 {
            let new_abs = if is_long {
                (position.base_size as i64)
                    .checked_add(base_size as i64).ok_or(PerkError::MathOverflow)?
                    .unsigned_abs() as u128
            } else {
                (position.base_size as i64)
                    .checked_sub(base_size as i64).ok_or(PerkError::MathOverflow)?
                    .unsigned_abs() as u128
            };
            require!(new_abs <= market.max_position_size, PerkError::PositionSizeLimitExceeded);
        }

        // H1: OI limits
        // M4 (Apex R2): Use effective OI instead of raw tracking
        if market.max_oi > 0 {
            let new_oi = if is_long {
                market.oi_eff_long_q.checked_add(base_size).ok_or(PerkError::MathOverflow)?
            } else {
                market.oi_eff_short_q.checked_add(base_size).ok_or(PerkError::MathOverflow)?
            };
            require!(new_oi <= market.max_oi, PerkError::OiLimitExceeded);
        }

        let swap_result = if is_long {
            vamm::simulate_long(market, base_size)?
        } else {
            vamm::simulate_short(market, base_size)?
        };
        vamm::apply_swap(market, &swap_result);

        // Fee
        let notional = vamm::calculate_notional(order.size as u128, oracle_price)?;
        let trading_fee = vamm::calculate_fee(notional, market.trading_fee_bps)?;

        // H4: Overflow check before u64 cast
        require!(trading_fee <= u64::MAX as u128, PerkError::MathOverflow);

        let (creator_fee, protocol_fee_share) = if order.authority == market.creator {
            (0u128, trading_fee)
        } else {
            vamm::split_fee(trading_fee, protocol.creator_fee_share_bps)?
        };

        // H4: Overflow checks for fee splits
        require!(creator_fee <= u64::MAX as u128, PerkError::MathOverflow);
        require!(protocol_fee_share <= u64::MAX as u128, PerkError::MathOverflow);

        // M1: Use checked_sub instead of saturating_sub
        let fee_u64 = trading_fee as u64;
        position.deposited_collateral = position.deposited_collateral
            .checked_sub(fee_u64).ok_or(PerkError::InsufficientCollateral)?;
        market.c_tot = market.c_tot.checked_sub(fee_u64 as u128)
            .ok_or(PerkError::MathOverflow)?;

        // Update position
        let old_eff = risk::effective_position_q(position, market);

        if is_long {
            position.base_size = position.base_size
                .checked_add(base_size as i64).ok_or(PerkError::MathOverflow)?;
            market.total_long_position = market.total_long_position
                .checked_add(base_size).ok_or(PerkError::MathOverflow)?;
        } else {
            position.base_size = position.base_size
                .checked_sub(base_size as i64).ok_or(PerkError::MathOverflow)?;
            market.total_short_position = market.total_short_position
                .checked_add(base_size).ok_or(PerkError::MathOverflow)?;
        }
        position.quote_entry_amount = position.quote_entry_amount
            .checked_add(swap_result.quote_amount).ok_or(PerkError::MathOverflow)?;

        // C4 fix: Compute new_eff from old_eff + trade_delta
        let trade_delta = if is_long { base_size as i128 } else { -(base_size as i128) };
        let new_eff_pos = old_eff.checked_add(trade_delta).ok_or(PerkError::MathOverflow)?;
        risk::attach_effective_position(position, market, new_eff_pos);

        let new_eff = risk::effective_position_q(position, market);
        risk::update_oi_delta(market, old_eff, new_eff)?;

        // Margin check after all updates
        let is_margin_ok = risk::is_above_initial_margin(position, market, oracle_price);
        require!(is_margin_ok, PerkError::InsufficientMargin);

        // Pashov: only increment total_positions on NEW positions
        if old_base_size == 0 {
            market.total_positions = market.total_positions.saturating_add(1);
        }

        market.creator_claimable_fees = market.creator_claimable_fees
            .checked_add(creator_fee as u64).ok_or(PerkError::MathOverflow)?;
        market.protocol_claimable_fees = market.protocol_claimable_fees
            .checked_add(protocol_fee_share as u64).ok_or(PerkError::MathOverflow)?;
        market.creator_fees_earned = market.creator_fees_earned.saturating_add(creator_fee as u64);
        market.protocol_fees_earned = market.protocol_fees_earned.saturating_add(protocol_fee_share as u64);

        trade_notional = notional;
    }

    // M2 (R4): Volume-weighted TWAP update using trade_notional
    // ATK-07 fix: Cap single trade's TWAP contribution to prevent manipulation
    let max_twap_weight = market.k / 10; // 10% of vAMM invariant
    let capped_twap_weight = core::cmp::min(trade_notional, max_twap_weight);
    market.mark_price_accumulator = market.mark_price_accumulator
        .saturating_add((current_mark as u128).saturating_mul(capped_twap_weight));
    market.twap_volume_accumulator = market.twap_volume_accumulator
        .saturating_add(capped_twap_weight);
    market.twap_observation_count = market.twap_observation_count.saturating_add(1);

    // ══════════════════════════════════════════════════════════════════════
    // Execution fee (0.01%) — paid to executor via CPI
    // ══════════════════════════════════════════════════════════════════════
    let execution_fee = vamm::calculate_fee(trade_notional, TRIGGER_EXECUTION_FEE_BPS)?;
    let exec_fee_u64 = execution_fee as u64;

    // M4 (Pashov3): Proper fee routing for execution fee shortfall
    let actual_deducted;
    if let Some(new_col) = position.deposited_collateral.checked_sub(exec_fee_u64) {
        position.deposited_collateral = new_col;
        market.c_tot = market.c_tot.checked_sub(exec_fee_u64 as u128)
            .ok_or(PerkError::MathOverflow)?;
        actual_deducted = exec_fee_u64;
    } else {
        let col_part = position.deposited_collateral;
        position.deposited_collateral = 0;
        market.c_tot = market.c_tot.checked_sub(col_part as u128)
            .ok_or(PerkError::MathOverflow)?;
        let remaining = (exec_fee_u64 as u128).saturating_sub(col_part as u128);
        risk::charge_fee_to_insurance(position, market, remaining)?;
        actual_deducted = col_part;
    }

    // C6 fix: Cap CPI transfer to actual_deducted (what user had), not exec_fee_u64
    let vault_amount = ctx.accounts.vault.amount;
    let actual_transfer = core::cmp::min(actual_deducted as u64, vault_amount);

    if actual_transfer > 0 {
        let decimals = ctx.accounts.collateral_mint.decimals;
        let token_mint_key = market.token_mint;
        let creator_key = market.creator;
        let market_bump = market.bump;
        let seeds = &[b"market" as &[u8], token_mint_key.as_ref(), creator_key.as_ref(), &[market_bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi_accounts = TransferChecked {
            from: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.executor_token_account.to_account_info(),
            authority: market_account_info.clone(),
        };
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
            actual_transfer,
            decimals,
        )?;
        market.vault_balance = market.vault_balance.checked_sub(actual_transfer as u128)
            .ok_or(PerkError::MathOverflow)?;
    }

    // C5: Update last activity slot
    position.last_activity_slot = clock.slot;

    position.open_trigger_orders = position.open_trigger_orders.saturating_sub(1);
    market.total_volume = market.total_volume.saturating_add(trade_notional);

    let protocol_mut = &mut ctx.accounts.protocol;
    protocol_mut.total_volume = protocol_mut.total_volume.saturating_add(trade_notional);

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!("Trigger order executed: type={:?}, size={}, exec_fee={}", order.order_type, order.size, execution_fee);
    Ok(())
}
