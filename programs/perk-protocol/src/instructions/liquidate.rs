/// Liquidate an underwater position. Permissionless.
///
/// Pattern: accrue_market_to → settle_side_effects → advance_warmup → check margin → liquidate
/// Uses oracle-derived equity for deficit. enqueue_adl uses risk::Side enum.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::engine::{vamm, risk, warmup, oracle, liquidation as liq_engine};
use crate::errors::PerkError;
use crate::state::{Market, Protocol, UserPosition};

#[derive(Accounts)]
pub struct Liquidate<'info> {
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
        seeds = [b"position", market.key().as_ref(), target_user.key().as_ref()],
        bump = user_position.bump,
    )]
    pub user_position: Box<Account<'info, UserPosition>>,

    /// CHECK: Oracle account for price reading
    #[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
    pub oracle: UncheckedAccount<'info>,

    /// CHECK: Target user whose position is being liquidated
    pub target_user: UncheckedAccount<'info>,

    #[account(
        mut,
        constraint = liquidator_token_account.mint == market.token_mint,
        constraint = liquidator_token_account.owner == liquidator.key(),
    )]
    pub liquidator_token_account: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"vault", market.key().as_ref()],
        bump = market.vault_bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub liquidator: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<Liquidate>) -> Result<()> {
    let market_account_info = ctx.accounts.market.to_account_info();
    let market = &mut ctx.accounts.market;
    let position = &mut ctx.accounts.user_position;

    require!(position.base_size != 0, PerkError::NoOpenPosition);

    let clock = Clock::get()?;

    // ── Standard accrue pattern ──
    let oracle_price = oracle::read_oracle_price(
        &market.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        clock.unix_timestamp,
    )?.price;

    risk::accrue_market_to(market, clock.slot, oracle_price)?;
    risk::settle_side_effects(position, market)?;
    let warmup_period = market.warmup_period_slots;
    warmup::advance_warmup(position, market, warmup_period, clock.slot);

    // ── Check below maintenance margin ──
    let is_above_mm = risk::is_above_maintenance_margin(position, market, oracle_price);
    require!(!is_above_mm, PerkError::NotLiquidatable);

    // ── Calculate liquidation details ──
    let liq_result = liq_engine::calculate_liquidation(position, market, oracle_price)?;

    // ── Execute vAMM reverse trade ──
    let is_long = position.base_size > 0;
    // C2 (Apex R2): Use effective position (after A/K), not raw base_size,
    // for both vAMM swap sizing and enqueue_adl to prevent underflow after ADL.
    let eff = risk::effective_position_q(position, market);
    let abs_eff = eff.unsigned_abs();

    let swap_result = if is_long {
        vamm::simulate_short(market, abs_eff)?
    } else {
        vamm::simulate_long(market, abs_eff)?
    };
    vamm::apply_swap(market, &swap_result);

    // ── Compute deficit from raw equity (C1 fix: use raw, not clamped) ──
    let eq_raw = risk::account_equity_maint_raw(position);
    let deficit = if eq_raw < 0 { eq_raw.unsigned_abs() } else { 0u128 };

    // H2 (R3): Cap insurance fee and liquidator reward to what's actually available
    // from the liquidated user's collateral. Prevents phantom token inflation when
    // the position is underwater.
    let old_collateral = position.deposited_collateral as u128;
    let available_for_fees = old_collateral.saturating_sub(deficit);
    let actual_liq_reward = core::cmp::min(liq_result.liquidator_reward as u128, available_for_fees);
    let remaining_after_reward = available_for_fees.saturating_sub(actual_liq_reward);
    let actual_insurance_fee = core::cmp::min(liq_result.insurance_fee as u128, remaining_after_reward);

    // Socialize deficit via A/K — use risk::Side enum
    let liq_side = if is_long { risk::Side::Long } else { risk::Side::Short };

    // C1 fix: ALL liquidation paths go through enqueue_adl for proper A/K adjustment
    // C2 (Apex R2): Use abs_eff (effective position) instead of raw abs_base
    risk::enqueue_adl(market, liq_side, abs_eff, deficit)?;

    // M3 (Pashov3): Insurance fee credited AFTER enqueue_adl drains insurance buffer,
    // so that the ADL deficit resolution uses the pre-credit balance.
    market.insurance_fund_balance = market
        .insurance_fund_balance
        .saturating_add(actual_insurance_fee as u64);

    // Update total_long/short_position using raw abs_base for raw tracking
    let abs_base = (position.base_size as i64).unsigned_abs() as u128;
    if is_long {
        market.total_long_position = market.total_long_position.saturating_sub(abs_base);
    } else {
        market.total_short_position = market.total_short_position.saturating_sub(abs_base);
    }

    // ── Reset position ──
    let old_collateral = position.deposited_collateral as u128;
    market.c_tot = market.c_tot.checked_sub(old_collateral)
        .ok_or(PerkError::MathOverflow)?;

    warmup::reset_warmup_on_liquidation(position, market);
    position.base_size = 0;
    position.quote_entry_amount = 0;
    risk::set_pnl(position, market, 0);
    position.deposited_collateral = 0;
    risk::attach_effective_position(position, market, 0);
    market.total_positions = market.total_positions.saturating_sub(1);

    // ── Transfer liquidator reward ──
    // H2 (R3): Use the capped reward, not the uncapped engine result
    let liquidator_reward_u64 = actual_liq_reward as u64;
    if liquidator_reward_u64 > 0 {
        // Pashov: cap to vault balance
        let vault_amount = ctx.accounts.vault.amount;
        let actual_reward = core::cmp::min(liquidator_reward_u64, vault_amount);

        if actual_reward > 0 {
            let token_mint_key = market.token_mint;
            let market_bump = market.bump;
            let seeds = &[b"market" as &[u8], token_mint_key.as_ref(), &[market_bump]];
            let signer_seeds = &[&seeds[..]];

            let cpi_accounts = Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.liquidator_token_account.to_account_info(),
                authority: market_account_info.clone(),
            };
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds,
                ),
                actual_reward,
            )?;
            market.vault_balance = market.vault_balance.checked_sub(actual_reward as u128)
                .ok_or(PerkError::MathOverflow)?;
        }
    }

    // H2: Check phantom dust clearance after OI reduction
    risk::check_and_clear_phantom_dust(market, liq_side);
    risk::check_and_clear_phantom_dust(market, risk::opposite_side(liq_side));

    // C5: Update last activity slot
    position.last_activity_slot = clock.slot;

    // C2 (R3): Finalize any pending resets after all engine calls
    risk::finalize_pending_resets(market);

    // M3 (R4): Conservation invariant check
    require!(risk::check_conservation(market), PerkError::CorruptState);

    msg!(
        "Liquidated: notional={}, liq_fee={}, reward={}, deficit={}",
        liq_result.closing_notional, liq_result.total_liq_fee, liq_result.liquidator_reward, deficit,
    );
    Ok(())
}
