/// Deposit collateral into a market position.
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup → deposit
/// Funding is settled through K-coefficients in accrue_market_to + settle_side_effects.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, TokenInterface, TokenAccount, TransferChecked, Mint};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition};
use crate::engine::{warmup, risk, oracle};

#[derive(Accounts)]
pub struct Deposit<'info> {
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
        constraint = user_position.authority == user.key() @ PerkError::Unauthorized,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Oracle account for price reading — validated against market.oracle_address
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    /// Token mint (needed for transfer_checked — validated against market)
    #[account(constraint = token_mint.key() == market.token_mint @ PerkError::TokenMintMismatch)]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        constraint = user_token_account.mint == market.token_mint,
        constraint = user_token_account.owner == user.key(),
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handler(ctx: Context<Deposit>, amount: u64) -> Result<()> {
    let protocol = &ctx.accounts.protocol;
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(!protocol.paused, PerkError::ProtocolPaused);
    require!(market.active, PerkError::MarketNotActive);
    require!(amount > 0, PerkError::InvalidAmount);
    require!(
        amount >= crate::constants::MIN_DEPOSIT_AMOUNT,
        PerkError::DepositBelowMinimum
    );

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

    // 1. Accrue market (updates K-coefficients from oracle, applies funding through K)
    risk::accrue_market_to(market, clock.slot, oracle_price)?;

    // 2. Settle side effects (K-diff PnL + funding for this user)
    risk::settle_side_effects(position, market)?;

    // 3. Advance warmup
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // ── Transfer tokens from user to vault (transfer_checked for Token-2022 compat) ──
    let decimals = ctx.accounts.token_mint.decimals;
    let cpi_accounts = TransferChecked {
        from: ctx.accounts.user_token_account.to_account_info(),
        mint: ctx.accounts.token_mint.to_account_info(),
        to: ctx.accounts.vault.to_account_info(),
        authority: ctx.accounts.user.to_account_info(),
    };
    token_interface::transfer_checked(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts),
        amount,
        decimals,
    )?;

    // ── Update position and market — track c_tot delta ──
    position.deposited_collateral = position
        .deposited_collateral
        .checked_add(amount)
        .ok_or(PerkError::MathOverflow)?;

    market.vault_balance = market
        .vault_balance
        .checked_add(amount as u128)
        .ok_or(PerkError::MathOverflow)?;

    market.c_tot = market
        .c_tot
        .checked_add(amount as u128)
        .ok_or(PerkError::MathOverflow)?;

    // H5 (R3): Settle losses and resolve flat negative after warmup advance
    risk::settle_losses(position, market);
    risk::resolve_flat_negative(position, market);

    // M1 (R3): Update last_activity_slot on deposit
    position.last_activity_slot = clock.slot;

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!("Deposited {} tokens to market {}", amount, market.market_index);
    Ok(())
}
