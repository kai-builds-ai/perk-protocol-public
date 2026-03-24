/// Reclaim an empty position account. Permissionless.
///
/// Anyone can call on a flat position (base_size == 0) with no open orders.
/// Uses risk::reclaim_empty_account to sweep dust to insurance.
/// Closes the position account and returns rent.
///
/// C5 + H1: Added accrue → settle → warmup before emptiness check,
/// minimum age, fee debt check, and dust threshold.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::engine::{risk, warmup, oracle};
use crate::errors::PerkError;
use crate::state::{Market, UserPosition};

#[derive(Accounts)]
pub struct ReclaimEmptyAccount<'info> {
    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        close = rent_receiver,
        seeds = [b"position", market.key().as_ref(), position_owner.key().as_ref()],
        bump = user_position.bump,
        constraint = user_position.market == market.key() @ PerkError::Unauthorized,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Oracle account for price reading (H1: needed for accrue pattern)
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: The original owner of the position (used for PDA derivation)
    pub position_owner: UncheckedAccount<'info>,

    /// CHECK: Receives the rent from the closed account.
    /// M11 fix: Must be the position owner (not arbitrary caller) to prevent rent theft.
    #[account(
        mut,
        constraint = rent_receiver.key() == user_position.authority @ PerkError::Unauthorized,
    )]
    pub rent_receiver: UncheckedAccount<'info>,

    /// Anyone can call this
    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<ReclaimEmptyAccount>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;
    let clock = Clock::get()?;

    // ── H1 + C5: Standard accrue → settle → warmup BEFORE checking emptiness ──
    let oracle_price = oracle::read_oracle_price(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        clock.unix_timestamp,
    )?.price;

    risk::accrue_market_to(market, clock.slot, oracle_price)?;
    risk::settle_side_effects(position, market)?;
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // M4 (R4): Settle losses and convert profit BEFORE emptiness checks
    // A position may appear non-empty due to unsettled PnL
    risk::settle_losses(position, market);
    risk::do_profit_conversion(position, market);
    risk::resolve_flat_negative(position, market);

    // ── Validate position is empty ──
    require!(position.base_size == 0, PerkError::PositionNotEmpty);
    require!(position.open_trigger_orders == 0, PerkError::PositionHasOpenOrders);

    // C5: Minimum age check — prevent griefing newly created accounts
    require!(
        clock.slot.saturating_sub(position.last_activity_slot) > MIN_RECLAIM_DELAY_SLOTS,
        PerkError::ReclaimTooSoon
    );

    // C5/M3: Don't forgive fee debt — require non-negative fee_credits
    require!(position.fee_credits >= 0, PerkError::ReclaimFeeDebt);

    // C5: Dust threshold — only reclaimable if collateral below DUST_THRESHOLD
    require!(
        position.deposited_collateral <= DUST_THRESHOLD,
        PerkError::ReclaimCollateralAboveDust
    );

    // Use the engine's reclaim function (sweeps dust, validates, zeros state)
    risk::reclaim_empty_account(position, market)?;

    // Decrement user count
    market.total_users = market.total_users.saturating_sub(1);

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // Account closed via `close = rent_receiver`
    msg!("Empty position reclaimed for market {}", market.market_index);
    Ok(())
}
