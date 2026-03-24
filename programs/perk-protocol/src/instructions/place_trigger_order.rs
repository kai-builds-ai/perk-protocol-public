/// C4: Fix trigger order PDA seeds — use monotonic counter (next_order_id)

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::{Market, UserPosition, TriggerOrder, TriggerOrderType, Side};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct TriggerOrderParams {
    pub order_type: TriggerOrderType,
    pub side: Side,
    pub size: u64,
    pub trigger_price: u64,
    pub leverage: u32,
    pub reduce_only: bool,
    pub expiry: i64,
}

#[derive(Accounts)]
#[instruction(params: TriggerOrderParams)]
pub struct PlaceTriggerOrder<'info> {
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

    // C4: Use next_order_id for PDA seeds (monotonically increasing)
    #[account(
        init,
        payer = user,
        space = TriggerOrder::SIZE,
        seeds = [
            b"trigger",
            market.key().as_ref(),
            user.key().as_ref(),
            &user_position.next_order_id.to_le_bytes(),
        ],
        bump,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    #[account(constraint = user.key() == user_position.authority @ PerkError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<PlaceTriggerOrder>, params: TriggerOrderParams) -> Result<()> {
    let market = &ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(market.active, PerkError::MarketNotActive);
    require!(params.size > 0, PerkError::InvalidAmount);
    require!(params.trigger_price > 0, PerkError::InvalidAmount);

    // Check max trigger orders (uses open_trigger_orders count, NOT next_order_id)
    require!(
        position.open_trigger_orders < position.max_trigger_orders,
        PerkError::MaxTriggerOrdersReached
    );

    // For stop/TP orders, require an existing position
    if params.order_type == TriggerOrderType::StopLoss
        || params.order_type == TriggerOrderType::TakeProfit
    {
        require!(position.base_size != 0, PerkError::NoOpenPosition);
    }

    // Create the trigger order
    let order = &mut ctx.accounts.trigger_order;
    let clock = Clock::get()?;

    order.authority = ctx.accounts.user.key();
    order.market = market.key();
    // C4: Use next_order_id for the order_id
    order.order_id = position.next_order_id;
    order.order_type = params.order_type;
    order.side = params.side;
    order.size = params.size;
    order.trigger_price = params.trigger_price;
    order.leverage = params.leverage;
    order.reduce_only = params.reduce_only;
    order.created_at = clock.unix_timestamp;
    order.expiry = params.expiry;
    order.bump = ctx.bumps.trigger_order;

    // C4: Increment monotonic counter (never decremented)
    position.next_order_id = position
        .next_order_id
        .checked_add(1)
        .ok_or(PerkError::MathOverflow)?;

    // Increment open order count (for max-orders check)
    position.open_trigger_orders = position
        .open_trigger_orders
        .checked_add(1)
        .ok_or(PerkError::MaxTriggerOrdersReached)?;

    msg!(
        "Trigger order placed: type={:?}, side={:?}, size={}, trigger_price={}, order_id={}",
        order.order_type,
        order.side,
        order.size,
        order.trigger_price,
        order.order_id,
    );

    Ok(())
}
