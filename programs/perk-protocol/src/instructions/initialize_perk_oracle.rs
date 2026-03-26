use anchor_lang::prelude::*;
use anchor_spl::token::Mint;
use crate::constants::*;
use crate::state::{Protocol, PerkOraclePrice};
use crate::errors::PerkError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitPerkOracleParams {
    pub min_sources: u8,
    pub max_staleness_seconds: u32,
    /// Max allowed price change per update in basis points. 0 = no banding (memecoins).
    /// 3000 = 30% max change per update (deep liquidity tokens).
    pub max_price_change_bps: u16,
    /// Circuit breaker: max deviation from EMA in bps. 0 = disabled.
    pub circuit_breaker_deviation_bps: u16,
}

#[derive(Accounts)]
pub struct InitializePerkOracle<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        init,
        payer = admin,
        space = PerkOraclePrice::SIZE,
        seeds = [b"perk_oracle", token_mint.key().as_ref()],
        bump,
    )]
    pub perk_oracle: Box<Account<'info, PerkOraclePrice>>,

    /// Token mint to create oracle for (validated as real SPL Mint)
    pub token_mint: Account<'info, Mint>,

    /// The initial oracle authority (cranker)
    /// CHECK: Can be any pubkey — validated by admin's intent
    pub oracle_authority: UncheckedAccount<'info>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePerkOracle>, params: InitPerkOracleParams) -> Result<()> {
    // Validate min_sources in [1, MAX_MIN_SOURCES]
    require!(params.min_sources >= 1, PerkError::InvalidAmount);
    require!(params.min_sources <= MAX_MIN_SOURCES, PerkError::InvalidAmount);
    // Validate max_staleness in [MIN, MAX] range
    require!(params.max_staleness_seconds >= MIN_ORACLE_STALENESS_SECONDS, PerkError::InvalidAmount);
    require!(params.max_staleness_seconds <= MAX_ORACLE_STALENESS_SECONDS, PerkError::InvalidAmount);
    // Validate price banding (0 = disabled, otherwise must be within [MIN, MAX] bounds)
    require!(
        params.max_price_change_bps == 0 || params.max_price_change_bps >= MIN_PRICE_CHANGE_BPS,
        PerkError::InvalidAmount
    );
    require!(params.max_price_change_bps <= MAX_PRICE_CHANGE_BPS, PerkError::InvalidAmount);
    // ATK-05 R2 fix: Validate circuit breaker bounds
    require!(
        params.circuit_breaker_deviation_bps == 0
            || params.circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS,
        PerkError::InvalidAmount
    );
    require!(params.circuit_breaker_deviation_bps <= MAX_CIRCUIT_BREAKER_BPS, PerkError::InvalidAmount);

    let oracle = &mut ctx.accounts.perk_oracle;
    oracle.bump = ctx.bumps.perk_oracle;
    oracle.token_mint = ctx.accounts.token_mint.key();
    oracle.authority = ctx.accounts.oracle_authority.key();
    oracle.price = 0;
    oracle.confidence = 0;
    oracle.timestamp = 0;
    oracle.num_sources = 0;
    oracle.min_sources = params.min_sources;
    oracle.last_slot = 0;
    oracle.ema_price = 0;
    oracle.max_staleness_seconds = params.max_staleness_seconds;
    oracle.is_frozen = false;
    oracle.created_at = Clock::get()?.unix_timestamp;
    oracle.total_updates = 0;
    oracle._reserved = [0u8; 64];
    // Store max_price_change_bps in _reserved as little-endian u16
    let bps_bytes = params.max_price_change_bps.to_le_bytes();
    oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS] = bps_bytes[0];
    oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS + 1] = bps_bytes[1];
    // Store circuit_breaker_deviation_bps in _reserved
    let cb_bytes = params.circuit_breaker_deviation_bps.to_le_bytes();
    oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS] = cb_bytes[0];
    oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS + 1] = cb_bytes[1];

    msg!("PerkOracle initialized for mint {}", oracle.token_mint);
    Ok(())
}
