/// Claim accumulated fees from the vault.
/// Creator claims creator_claimable_fees; protocol admin claims protocol_claimable_fees.
///
/// Fix: verify recipient_token_account.owner == claimer.key()

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::engine::risk;
use crate::errors::PerkError;
use crate::state::{Market, Protocol};

#[derive(Accounts)]
pub struct ClaimFees<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = recipient_token_account.mint == market.token_mint,
        // FIX: verify recipient_token_account.owner == claimer
        constraint = recipient_token_account.owner == claimer.key() @ PerkError::Unauthorized,
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,

    pub claimer: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<ClaimFees>) -> Result<()> {
    let market_account_info = ctx.accounts.market.to_account_info();
    let market = &mut ctx.accounts.market;
    let claimer = ctx.accounts.claimer.key();

    // Determine claim amount based on who is calling
    let claim_amount: u64;

    if claimer == market.creator {
        claim_amount = market.creator_claimable_fees;
        require!(claim_amount > 0, PerkError::NoFeesToClaim);
        market.creator_claimable_fees = 0;
    } else if claimer == ctx.accounts.protocol.admin {
        claim_amount = market.protocol_claimable_fees;
        require!(claim_amount > 0, PerkError::NoFeesToClaim);
        market.protocol_claimable_fees = 0;
    } else {
        return Err(PerkError::Unauthorized.into());
    }

    // Cap to vault balance to prevent CPI failure
    let vault_amount = ctx.accounts.vault.amount;
    let actual_claim = core::cmp::min(claim_amount, vault_amount);
    require!(actual_claim > 0, PerkError::VaultInsufficient);

    // If we can't claim the full amount, put the remainder back
    if actual_claim < claim_amount {
        let remainder = claim_amount - actual_claim;
        if claimer == market.creator {
            market.creator_claimable_fees = remainder;
        } else {
            market.protocol_claimable_fees = remainder;
        }
    }

    // CPI transfer from vault using market PDA as signer
    let token_mint_key = market.token_mint;
    let market_bump = market.bump;
    let seeds = &[b"market" as &[u8], token_mint_key.as_ref(), &[market_bump]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault.to_account_info(),
        to: ctx.accounts.recipient_token_account.to_account_info(),
        authority: market_account_info.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        signer_seeds,
    );
    token::transfer(cpi_ctx, actual_claim)?;

    // Update vault balance
    market.vault_balance = market.vault_balance.checked_sub(actual_claim as u128)
        .ok_or(PerkError::MathOverflow)?;

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!("Fees claimed: {} by {}", actual_claim, claimer);
    Ok(())
}
