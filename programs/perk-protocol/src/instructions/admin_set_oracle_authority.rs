use anchor_lang::prelude::*;
use crate::state::Protocol;

#[derive(Accounts)]
pub struct AdminSetOracleAuthority<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSetOracleAuthority>, new_authority: Pubkey) -> Result<()> {
    require!(new_authority != Pubkey::default(), crate::errors::PerkError::InvalidAmount);

    ctx.accounts.protocol.oracle_authority = new_authority;

    msg!("Oracle authority set to {}", new_authority);
    Ok(())
}
