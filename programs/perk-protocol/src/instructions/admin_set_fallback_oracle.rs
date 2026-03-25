/// Set or remove the fallback oracle on a market. Admin only.
///
/// When setting a PerkOracle fallback, validates the oracle's token_mint matches
/// the market's token_mint (prevents cross-token oracle attacks).
/// Pass Pubkey::default() as address to remove fallback.

use anchor_lang::prelude::*;
use crate::engine::oracle;
use crate::errors::PerkError;
use crate::state::{Market, Protocol, OracleSource};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SetFallbackOracleParams {
    pub fallback_oracle_source: OracleSource,
    pub fallback_oracle_address: Pubkey,
}

#[derive(Accounts)]
pub struct AdminSetFallbackOracle<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: The fallback oracle account to validate. Pass any account when removing fallback.
    pub fallback_oracle: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSetFallbackOracle>, params: SetFallbackOracleParams) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Removing fallback (setting to default)
    if params.fallback_oracle_address == Pubkey::default() {
        market.fallback_oracle_source = OracleSource::Pyth; // doesn't matter, won't be used
        market.fallback_oracle_address = Pubkey::default();
        msg!("Fallback oracle removed from market {}", market.token_mint);
        return Ok(());
    }

    // Validate the passed account matches the requested address
    require!(
        ctx.accounts.fallback_oracle.key() == params.fallback_oracle_address,
        PerkError::InvalidOracleSource
    );

    // Prevent setting fallback to same as primary (confusing, not useful)
    require!(
        params.fallback_oracle_address != market.oracle_address,
        PerkError::InvalidOracleSource
    );

    // Validate the oracle account is real and readable
    oracle::validate_oracle(
        &params.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
    )?;

    // For PerkOracle fallbacks: validate token_mint matches market
    if params.fallback_oracle_source == OracleSource::PerkOracle {
        oracle::validate_perk_oracle_mint(
            &ctx.accounts.fallback_oracle.to_account_info(),
            &market.token_mint,
        )?;
    }

    market.fallback_oracle_source = params.fallback_oracle_source;
    market.fallback_oracle_address = params.fallback_oracle_address;

    msg!(
        "Fallback oracle set for market {}: source={:?}, address={}",
        market.token_mint,
        params.fallback_oracle_source,
        params.fallback_oracle_address
    );
    Ok(())
}
