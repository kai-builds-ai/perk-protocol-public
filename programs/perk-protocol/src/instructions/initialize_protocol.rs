use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::Protocol;

#[derive(Accounts)]
pub struct InitializeProtocol<'info> {
    #[account(
        init,
        payer = admin,
        space = Protocol::SIZE,
        seeds = [b"protocol"],
        bump,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(mut)]
    pub admin: Signer<'info>,

    /// CHECK: Protocol fee vault token account
    pub protocol_fee_vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeProtocol>) -> Result<()> {
    let protocol = &mut ctx.accounts.protocol;
    protocol.admin = ctx.accounts.admin.key();
    protocol.paused = false;
    protocol.market_count = 0;
    protocol.protocol_fee_vault = ctx.accounts.protocol_fee_vault.key();
    protocol.creator_fee_share_bps = CREATOR_FEE_SHARE_BPS;
    protocol.min_trading_fee_bps = MIN_TRADING_FEE_BPS;
    protocol.max_trading_fee_bps = MAX_TRADING_FEE_BPS as u16;
    // M9 fix: Use MIN_INITIAL_K for meaningful depth. Note: u64 can hold up to ~1.8e19, 1e18 fits.
    protocol.min_initial_liquidity = MIN_INITIAL_K as u64;
    protocol.total_volume = 0;
    protocol.total_fees_collected = 0;
    protocol.total_users = 0;
    protocol.bump = ctx.bumps.protocol;
    // M3 fix: Default market creation fee
    protocol.market_creation_fee = DEFAULT_MARKET_CREATION_FEE;
    // M5 fix: No pending admin initially
    protocol.pending_admin = None;

    msg!("Protocol initialized. Admin: {}", protocol.admin);
    Ok(())
}
