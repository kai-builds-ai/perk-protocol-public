/// Permissionless: Settle a stale position's side effects without closing it.
///
/// After ADL epoch-bumps a side, existing positions become "stale" — their
/// epoch_snapshot no longer matches the market's epoch. settle_side_effects
/// handles this by zeroing base_size and decrementing stale/stored counts.
///
/// Previously, the only way to trigger this was through reclaim_empty_account,
/// which also requires collateral <= DUST_THRESHOLD. If a stale position has
/// legitimate collateral, reclaim fails, the settle rolls back, and the side
/// stays stuck in ResetPending forever.
///
/// This instruction runs ONLY the settle path — no reclaim, no account close.
/// The position stays open with the owner's collateral intact. But the side
/// counts get decremented, allowing maybe_finalize_ready_reset_sides to
/// transition the side back to Normal.
///
/// Anyone can call this. The position owner loses nothing.

use anchor_lang::prelude::*;
use crate::engine::{risk, warmup, oracle};
use crate::state::{Market, UserPosition};

#[derive(Accounts)]
pub struct SettleStalePosition<'info> {
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
    #[account(constraint = oracle.key() == market.oracle_address)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    /// CHECK: The original owner of the position (used for PDA derivation)
    pub position_owner: UncheckedAccount<'info>,

    /// Anyone can call this
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<SettleStalePosition>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;
    let clock = Clock::get()?;

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

    risk::settle_losses(position, market);
    risk::do_profit_conversion(position, market);
    risk::resolve_flat_negative(position, market);

    // Finalize any pending resets (may transition side back to Normal)
    risk::finalize_pending_resets(market);

    msg!(
        "Stale position settled: base_size={}, collateral={}",
        position.base_size,
        position.deposited_collateral,
    );

    Ok(())
}
