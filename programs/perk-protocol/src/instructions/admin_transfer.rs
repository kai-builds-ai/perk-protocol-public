/// M5 fix: Two-step admin transfer.
/// - propose_admin: current admin sets pending_admin
/// - accept_admin: pending_admin signs and becomes new admin

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::Protocol;

// ── Propose Admin ──

#[derive(Accounts)]
pub struct ProposeAdmin<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
        constraint = protocol.admin == admin.key() @ PerkError::Unauthorized,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    pub admin: Signer<'info>,
}

pub fn handler_propose(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    // M3 (R3): Prevent overwriting an existing pending admin transfer
    require!(protocol.pending_admin.is_none(), PerkError::AdminTransferPending);
    protocol.pending_admin = Some(new_admin);
    msg!("Admin transfer proposed: pending={}", new_admin);
    Ok(())
}

// ── Accept Admin ──

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    pub new_admin: Signer<'info>,
}

pub fn handler_accept(ctx: Context<AcceptAdmin>) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    let pending = protocol.pending_admin
        .ok_or(PerkError::Unauthorized)?;
    require!(pending == ctx.accounts.new_admin.key(), PerkError::Unauthorized);

    protocol.admin = pending;
    protocol.pending_admin = None;
    msg!("Admin transfer accepted: new_admin={}", pending);
    Ok(())
}
