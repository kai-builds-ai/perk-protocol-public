/// Crank the funding rate. Permissionless.
///
/// Calls accrue_market_to first, then computes and stores the new funding rate.
/// Funding is now applied through K-coefficients in accrue_market_to (not cumulative indices).

use anchor_lang::prelude::*;
use crate::constants::INSURANCE_EPOCH_SECONDS;
use crate::engine::{funding, vamm, oracle, risk};
use crate::errors::PerkError;
use crate::state::Market;

#[derive(Accounts)]
pub struct CrankFunding<'info> {
    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Fallback oracle account (pass any account if no fallback configured)
    pub fallback_oracle: UncheckedAccount<'info>,

    pub cranker: Signer<'info>,
}

pub fn handler(ctx: Context<CrankFunding>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    require!(market.active, PerkError::MarketNotActive);

    // Check funding period elapsed
    require!(
        funding::is_funding_due(market, clock.unix_timestamp),
        PerkError::FundingPeriodNotElapsed
    );

    // H4: Check minimum OI on both sides
    require!(
        funding::has_sufficient_oi_for_funding(market),
        PerkError::InsufficientOiForFunding
    );

    // Read oracle price
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    // Accrue market FIRST
    risk::accrue_market_to(market, clock.slot, oracle_price)?;

    // Calculate mark price
    let mark_price = vamm::calculate_mark_price(market)?;

    // Compute and store new funding rate for the next interval
    // funding::update_funding computes TWAP rate and calls set_funding_rate
    funding::update_funding(market, mark_price, oracle_price)?;

    // Update last funding time
    market.last_funding_time = clock.unix_timestamp;

    // M8 fix: Reset TWAP accumulators after each funding period
    market.mark_price_accumulator = 0;
    market.twap_observation_count = 0;
    // M2 (R4): Reset volume-weighted TWAP accumulator
    market.twap_volume_accumulator = 0;

    // H3 fix: Reset insurance epoch on its own 24-hour timer, not funding period.
    // This prevents the timing attack where frequent crank_funding resets the counter.
    let epoch_elapsed = clock.unix_timestamp.saturating_sub(market.insurance_epoch_start);
    if epoch_elapsed >= INSURANCE_EPOCH_SECONDS {
        market.insurance_epoch_start = clock.unix_timestamp;
        market.insurance_epoch_payout = 0;
    }

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    msg!("Funding cranked: mark={}, oracle={}", mark_price, oracle_price);
    Ok(())
}
