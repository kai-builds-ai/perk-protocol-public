/// Admin-only: Override the side state (long_state / short_state) on a market.
///
/// Use cases:
/// - Unblock a side stuck in ResetPending or DrainOnly
/// - Force-drain a side (set to DrainOnly) for controlled wind-down
/// - Emergency recovery after ADL or K-reset edge cases
///
/// WARNING: Setting a side to Normal while stale position counts or OI are
/// non-zero may leave the market in an inconsistent state. Use with caution.

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::{Market, Protocol, SideState};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AdminSetSideStateParams {
    /// 0 = long, 1 = short
    pub side: u8,
    /// 0 = Normal, 1 = DrainOnly, 2 = ResetPending
    pub state: u8,
}

#[derive(Accounts)]
pub struct AdminSetSideState<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        constraint = protocol.admin == admin.key() @ PerkError::Unauthorized,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSetSideState>, params: AdminSetSideStateParams) -> Result<()> {
    let market = &mut ctx.accounts.market;

    let new_state = match params.state {
        0 => SideState::Normal,
        1 => SideState::DrainOnly,
        2 => SideState::ResetPending,
        _ => return Err(PerkError::CorruptState.into()),
    };

    match params.side {
        0 => {
            let old = market.long_state;
            market.long_state = new_state;
            msg!("Long side state: {:?} -> {:?}", old, new_state);
        }
        1 => {
            let old = market.short_state;
            market.short_state = new_state;
            msg!("Short side state: {:?} -> {:?}", old, new_state);
        }
        _ => return Err(PerkError::CorruptState.into()),
    }

    Ok(())
}
