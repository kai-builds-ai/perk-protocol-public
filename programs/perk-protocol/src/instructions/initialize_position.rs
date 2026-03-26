/// C12: Separate position initialization instruction.
/// Replaces init_if_needed from deposit.

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition};

#[derive(Accounts)]
pub struct InitializePosition<'info> {
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
        init,
        payer = user,
        space = UserPosition::SIZE,
        seeds = [b"position", market.key().as_ref(), user.key().as_ref()],
        bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePosition>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(!ctx.accounts.protocol.paused, PerkError::ProtocolPaused);
    require!(market.active, PerkError::MarketNotActive);

    position.authority = ctx.accounts.user.key();
    position.market = market.key();
    position.max_trigger_orders = crate::constants::MAX_TRIGGER_ORDERS_PER_USER;
    position.bump = ctx.bumps.user_position;
    position.a_snapshot = crate::constants::ADL_ONE;
    position.next_order_id = 0;
    // M3 (Apex R2): Set last_activity_slot on initialization
    position.last_activity_slot = Clock::get()?.slot;

    market.total_users = market.total_users.saturating_add(1);

    // Medium fix: Update protocol-level user count
    let protocol_mut = &mut ctx.accounts.protocol;
    protocol_mut.total_users = protocol_mut.total_users.saturating_add(1);

    msg!("Position initialized for market {}", market.market_index);
    Ok(())
}
