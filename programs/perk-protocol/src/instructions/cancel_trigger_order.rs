use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::{Market, UserPosition, TriggerOrder};

#[derive(Accounts)]
pub struct CancelTriggerOrder<'info> {
    #[account(
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

    // M6 (Pashov3): PDA seed validation to prevent spoofed trigger orders
    #[account(
        mut,
        close = user,
        seeds = [b"trigger", market.key().as_ref(), user.key().as_ref(), &trigger_order.order_id.to_le_bytes()],
        bump = trigger_order.bump,
        constraint = trigger_order.authority == user.key() @ PerkError::Unauthorized,
        constraint = trigger_order.market == market.key() @ PerkError::Unauthorized,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    #[account(constraint = user.key() == user_position.authority @ PerkError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,
}

pub fn handler(ctx: Context<CancelTriggerOrder>) -> Result<()> {
    let position = &mut ctx.accounts.user_position;
    let order = &ctx.accounts.trigger_order;

    // Decrement trigger order count
    position.open_trigger_orders = position.open_trigger_orders.saturating_sub(1);

    msg!(
        "Trigger order cancelled: order_id={}, type={:?}",
        order.order_id,
        order.order_type,
    );

    // Account is closed via `close = user` constraint, rent returned

    Ok(())
}
