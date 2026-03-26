/// Update AMM peg multiplier to re-anchor to oracle. Permissionless.
///
/// H3: Peg update cooldown enforced.

use anchor_lang::prelude::*;
use crate::constants::*;
use crate::engine::{vamm, oracle, risk};
use crate::errors::PerkError;
use crate::state::Market;

#[derive(Accounts)]
pub struct UpdateAmm<'info> {
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

    pub caller: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateAmm>) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let clock = Clock::get()?;

    require!(market.active, PerkError::MarketNotActive);

    // H3: Enforce cooldown between peg updates
    let slots_since_last = clock.slot.saturating_sub(market.last_peg_update_slot);
    require!(slots_since_last >= PEG_UPDATE_COOLDOWN_SLOTS, PerkError::PegCooldownNotElapsed);

    // Read oracle price
    let oracle_price = oracle::read_oracle_price_with_fallback(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        &market.fallback_oracle_source,
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.fallback_oracle_address,
        clock.unix_timestamp,
    )?.price;

    // Accrue market first
    risk::accrue_market_to(market, clock.slot, oracle_price)?;

    // Calculate current mark price
    let mark_price = vamm::calculate_mark_price(market)?;

    // Check if drift exceeds threshold
    let drift_bps = vamm::calculate_slippage_bps(mark_price as u128, oracle_price)?;
    require!(drift_bps > AMM_PEG_THRESHOLD_BPS, PerkError::AmmPegWithinThreshold);

    // H3 (R3): Sample TWAP BEFORE the peg update to capture real mark-oracle divergence.
    // Sampling after peg update always yields mark ≈ oracle, defeating TWAP's purpose.
    // M2 (R4): No trade notional for peg updates — use weight=1 (plain observation)
    let pre_update_mark = vamm::calculate_mark_price(market)?;
    let peg_twap_weight: u128 = 1_000_000; // Fixed weight for non-trade observations
    // ATK-07 fix: Cap TWAP contribution to prevent manipulation (applies even to peg updates)
    let max_twap_weight = market.k / 10; // 10% of vAMM invariant
    let capped_twap_weight = core::cmp::min(peg_twap_weight, max_twap_weight);
    market.mark_price_accumulator = market.mark_price_accumulator
        .saturating_add((pre_update_mark as u128).saturating_mul(capped_twap_weight));
    market.twap_volume_accumulator = market.twap_volume_accumulator
        .saturating_add(capped_twap_weight);
    market.twap_observation_count = market.twap_observation_count.saturating_add(1);

    // Calculate and apply new peg
    let old_peg = market.peg_multiplier;
    let new_peg = vamm::calculate_new_peg(market, oracle_price)?;
    market.peg_multiplier = new_peg;

    // H3: Record last peg update slot
    market.last_peg_update_slot = clock.slot;

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    msg!("AMM peg updated: old={}, new={}, drift={}bps", old_peg, new_peg, drift_bps);
    Ok(())
}
