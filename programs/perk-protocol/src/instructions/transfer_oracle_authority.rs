use anchor_lang::prelude::*;
use crate::state::{Protocol, PerkOraclePrice};
use crate::errors::PerkError;

/// Transfer oracle authority. Can be called by EITHER:
/// - Current authority (normal key rotation)
/// - Protocol admin (emergency recovery — M-04 fix)
#[derive(Accounts)]
pub struct TransferOracleAuthority<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"perk_oracle", perk_oracle.token_mint.as_ref()],
        bump = perk_oracle.bump,
    )]
    pub perk_oracle: Box<Account<'info, PerkOraclePrice>>,

    /// Signer must be either the current oracle authority or the protocol admin
    pub signer: Signer<'info>,

    /// CHECK: New authority — can be any pubkey (but not zero)
    pub new_authority: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<TransferOracleAuthority>) -> Result<()> {
    let oracle = &mut ctx.accounts.perk_oracle;
    let protocol = &ctx.accounts.protocol;
    let signer = ctx.accounts.signer.key();

    // Must be current authority OR protocol admin
    let is_authority = signer == oracle.authority;
    let is_admin = signer == protocol.admin;
    require!(is_authority || is_admin, PerkError::Unauthorized);

    // Prevent bricking the oracle by transferring to zero address
    require!(
        ctx.accounts.new_authority.key() != Pubkey::default(),
        PerkError::InvalidAmount
    );

    let old = oracle.authority;
    oracle.authority = ctx.accounts.new_authority.key();
    msg!("Oracle authority transferred: {} -> {} (by {})",
        old, oracle.authority, if is_admin { "admin" } else { "authority" });
    Ok(())
}
