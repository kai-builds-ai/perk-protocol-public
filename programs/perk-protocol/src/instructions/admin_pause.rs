use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::Protocol;

#[derive(Accounts)]
pub struct AdminPause<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin @ PerkError::Unauthorized,
    )]
    pub protocol: Account<'info, Protocol>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminPause>, paused: bool) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    protocol.paused = paused;

    msg!("Protocol paused: {}", paused);
    Ok(())
}
