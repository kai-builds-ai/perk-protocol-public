/// Withdraw collateral from a market position.
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup → withdraw
/// Oracle-derived margin check post-withdrawal.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, TransferChecked, Mint};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition};
use crate::engine::{warmup, risk, oracle};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
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

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    /// Collateral mint (needed for transfer_checked — validated against market)
    #[account(constraint = collateral_mint.key() == market.collateral_mint @ PerkError::TokenMintMismatch)]
    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.mint == market.collateral_mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(constraint = user.key() == user_position.authority @ PerkError::Unauthorized)]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
    let market_account_info = ctx.accounts.market.to_account_info();
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(amount > 0, PerkError::InvalidAmount);

    let clock = Clock::get()?;

    // ── Standard accrue pattern ──
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    risk::accrue_market_to(market, clock.slot, oracle_price)?;
    risk::settle_side_effects(position, market)?;
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // H5 (R3): Settle losses and resolve flat negative after warmup advance
    risk::settle_losses(position, market);
    risk::resolve_flat_negative(position, market);

    // ── Withdrawal logic ──
    require!(
        amount <= position.deposited_collateral,
        PerkError::InsufficientCollateral
    );

    let new_collateral = position
        .deposited_collateral
        .checked_sub(amount)
        .ok_or(PerkError::InsufficientCollateral)?;

    // H3 (Pashov3): Check effective position too — base_size==0 doesn't mean no exposure
    let eff = risk::effective_position_q(position, market);
    if position.base_size != 0 || eff != 0 {
        // Temporarily set collateral to post-withdrawal value for margin check
        // H3 fix: Use initial margin for withdrawal check (stricter than maintenance)
        let old_collateral = position.deposited_collateral;
        position.deposited_collateral = new_collateral;
        let is_above = risk::is_above_initial_margin(position, market, oracle_price);
        position.deposited_collateral = old_collateral; // restore
        require!(is_above, PerkError::WithdrawalWouldLiquidate);
    }

    // ── CPI transfer from vault to user (transfer_checked for Token-2022 compat) ──
    let decimals = ctx.accounts.collateral_mint.decimals;
    let token_mint_key = market.token_mint;
    let creator_key = market.creator;
    let market_bump = market.bump;
    let seeds = &[b"market" as &[u8], token_mint_key.as_ref(), creator_key.as_ref(), &[market_bump]];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = TransferChecked {
        from: ctx.accounts.vault.to_account_info(),
        mint: ctx.accounts.collateral_mint.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: market_account_info.clone(),
    };
    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer_seeds,
        ),
        amount,
        decimals,
    )?;

    // ── Update balances — track c_tot delta ──
    position.deposited_collateral = new_collateral;
    market.vault_balance = market
        .vault_balance
        .checked_sub(amount as u128)
        .ok_or(PerkError::MathOverflow)?;
    market.c_tot = market
        .c_tot
        .checked_sub(amount as u128)
        .ok_or(PerkError::MathOverflow)?;

    // C5: Update last activity slot
    position.last_activity_slot = clock.slot;

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!("Withdrew {} tokens from market {}", amount, market.market_index);
    Ok(())
}
