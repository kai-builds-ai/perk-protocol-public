/// Admin-only: Fix a market whose accrue state was never initialized.
///
/// Sets last_market_slot and current_slot to now, and last_oracle_price to the
/// current oracle reading. This closes the phantom slot gap that causes
/// catastrophic K-coefficient accumulation in accrue_market_to.
///
/// Does NOT reset K indices — active positions already have k_snapshots
/// synchronised to current K values, so resetting would create a new mismatch.

use anchor_lang::prelude::*;
use crate::engine::oracle;
use crate::errors::PerkError;
use crate::state::{Market, Protocol};

#[derive(Accounts)]
pub struct AdminFixMarketAccrue<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: Oracle account — validated against market.oracle_address
    #[account(constraint = oracle_account.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle_account: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminFixMarketAccrue>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    let old_last_market_slot = market.last_market_slot;
    let old_last_oracle_price = market.last_oracle_price;

    // Read current oracle price
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle_account.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    // Close the slot gap — this is the critical fix.
    // Without this, every interaction processes millions of phantom funding slots.
    market.last_market_slot = clock.slot;
    market.current_slot = clock.slot;
    market.last_oracle_price = oracle_price;
    market.funding_price_sample_last = oracle_price;

    msg!(
        "Market accrue state fixed: last_market_slot {} -> {}, last_oracle_price {} -> {}",
        old_last_market_slot,
        clock.slot,
        old_last_oracle_price,
        oracle_price,
    );

    Ok(())
}
