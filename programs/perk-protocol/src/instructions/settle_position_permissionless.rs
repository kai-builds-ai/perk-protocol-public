/// v2.1: Permissionless position settlement — anyone can settle any position.
///
/// Identical to settle_funding but without authority constraint.
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup
///
/// SAFETY: Does NOT run settle_losses or do_profit_conversion.
/// Those change collateral and could push a position below maintenance margin,
/// letting a malicious caller trigger a liquidation-ready state.
/// This instruction only: settles K-diff PNL into warmup, advances warmup timer,
/// and claims liquidation rewards (which only increase collateral).

use anchor_lang::prelude::*;
use crate::engine::{risk, warmup, oracle};
use crate::errors::PerkError;
use crate::state::{Market, UserPosition};

#[derive(Accounts)]
pub struct SettlePositionPermissionless<'info> {
    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"position", market.key().as_ref(), position_owner.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.market == market.key(),
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    /// CHECK: The original owner of the position (used for PDA derivation)
    pub position_owner: UncheckedAccount<'info>,

    /// Anyone can call this — cranker pays the TX fee
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<SettlePositionPermissionless>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    // Position must be open
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

    // settle_side_effects: settles K-diff PNL + liquidation rewards (v2.1)
    risk::settle_side_effects(position, market)?;

    // Advance warmup timer (matures reserved PNL)
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // NOTE: Deliberately NO settle_losses, do_profit_conversion, or resolve_flat_negative.
    // Those change collateral and could push a position below maintenance margin.
    // A permissionless caller must not be able to alter a position's margin state.

    // Finalize any pending resets
    risk::finalize_pending_resets(market);

    // Pashov F2: Conservation check (same as all other state-mutating instructions)
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!(
        "Position settled (permissionless): base_size={}, collateral={}",
        position.base_size,
        position.deposited_collateral,
    );

    Ok(())
}
