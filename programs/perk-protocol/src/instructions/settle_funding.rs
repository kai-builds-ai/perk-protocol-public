/// Settle accrued funding PnL into collateral without closing the position.
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup →
/// settle_losses + do_profit_conversion → update activity slot.
///
/// This lets users realize accumulated funding gains (or absorb losses)
/// while keeping their position open. No vault/USDC interaction — purely
/// an on-chain accounting operation.
///
/// - Matured released profit is converted to collateral (via do_profit_conversion)
/// - Negative PnL is deducted from collateral (via settle_losses)
/// - Reserved (warming-up) PnL stays intact — continues warming for next settle
/// - Position size, basis, and vAMM are untouched

use anchor_lang::prelude::*;
use crate::engine::{risk, warmup, oracle};
use crate::errors::PerkError;
use crate::state::{Market, UserPosition};

#[derive(Accounts)]
pub struct SettleFunding<'info> {
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

pub fn handler(ctx: Context<SettleFunding>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    // Position must be open
    require!(position.base_size != 0, PerkError::NoOpenPosition);

    let clock = Clock::get()?;

    // ── Standard accrue pattern (same as close_position) ──
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

    // Min 1-slot holding period (same as close_position)
    require!(
        clock.slot > position.last_activity_slot,
        PerkError::MinHoldingPeriodNotMet
    );

    // ── Settle PnL into collateral ──
    // settle_losses: if PnL < 0, deducts from collateral (no-op if PnL >= 0)
    // do_profit_conversion: if released matured PnL > 0, credits haircutted amount
    //   to collateral via consume_released_pnl + set_capital (no-op if released == 0)
    // Both maintain all aggregates (pnl_pos_tot, pnl_matured_pos_tot, c_tot) correctly.
    risk::settle_losses(position, market);
    if risk::released_pos(position) > 0 {
        risk::do_profit_conversion(position, market);
    }

    // H1 (Apex/Predator): Sweep fee debt after profit conversion.
    // Without this, a user with fee debt from a prior close could convert profit
    // to collateral and withdraw without repaying — stealing from insurance.
    risk::fee_debt_sweep(position, market);

    // H2 (Apex/Predator): If settle_side_effects zeroed the position (epoch mismatch
    // or q_eff_new == 0), resolve any remaining negative PnL via insurance fund.
    // Without this, the position enters an unrecoverable zombie state.
    if position.base_size == 0 {
        risk::resolve_flat_negative(position, market);
    }

    // Update last activity slot
    position.last_activity_slot = clock.slot;

    // Finalize any pending resets
    risk::finalize_pending_resets(market);

    // Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!(
        "Funding settled: pnl={}, collateral={}",
        position.pnl,
        position.deposited_collateral,
    );

    Ok(())
}
