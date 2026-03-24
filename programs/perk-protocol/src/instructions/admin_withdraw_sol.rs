/// H1 (R3): Withdraw accumulated creation fee SOL from the Protocol PDA.
/// Admin only. Preserves rent-exempt minimum.

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::Protocol;

#[derive(Accounts)]
pub struct AdminWithdrawSol<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
        constraint = protocol.admin == admin.key() @ PerkError::Unauthorized,
    )]
    pub protocol: Account<'info, Protocol>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<AdminWithdrawSol>, amount: u64) -> Result<()> {
    require!(amount > 0, PerkError::InvalidAmount);

    let protocol_info = ctx.accounts.protocol.to_account_info();
    let protocol_lamports = protocol_info.lamports();
    let rent_exempt = Rent::get()?.minimum_balance(Protocol::SIZE);
    let available = protocol_lamports.saturating_sub(rent_exempt);
    let transfer_amount = core::cmp::min(amount, available);

    require!(transfer_amount > 0, PerkError::InvalidAmount);

    // Transfer SOL from Protocol PDA to admin via lamport manipulation
    // (Protocol is an Anchor account owned by this program, so we can directly adjust lamports)
    **protocol_info.try_borrow_mut_lamports()? -= transfer_amount;
    **ctx.accounts.admin.to_account_info().try_borrow_mut_lamports()? += transfer_amount;

    msg!("Admin withdrew {} lamports from protocol", transfer_amount);
    Ok(())
}
