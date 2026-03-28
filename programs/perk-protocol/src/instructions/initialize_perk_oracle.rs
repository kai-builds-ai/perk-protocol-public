use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;
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

/// Permissionless oracle initialization.
/// Anyone can pay rent to create a PerkOracle for any SPL token.
/// The oracle authority is read from the Protocol account (set by admin).
#[derive(Accounts)]
pub struct InitializePerkOracle<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        init,
        payer = payer,
        space = PerkOraclePrice::SIZE,
        seeds = [b"perk_oracle", token_mint.key().as_ref()],
        bump,
    )]
    pub perk_oracle: Box<Account<'info, PerkOraclePrice>>,

    /// Token mint to create oracle for (validated as real SPL or Token-2022 Mint)
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializePerkOracle>, params: InitPerkOracleParams) -> Result<()> {
    let protocol = &ctx.accounts.protocol;

    // Oracle authority must be configured by admin before permissionless init works
    require!(
        protocol.oracle_authority != Pubkey::default(),
        PerkError::InvalidAmount
    );

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
    // Authority comes from Protocol — cranker pubkey set by admin
    oracle.authority = protocol.oracle_authority;
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

    msg!("PerkOracle initialized for mint {} (authority: {})", oracle.token_mint, oracle.authority);
    Ok(())
}
