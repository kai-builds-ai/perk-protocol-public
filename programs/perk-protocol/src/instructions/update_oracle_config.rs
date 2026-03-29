use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::{Protocol, PerkOraclePrice};
use crate::errors::PerkError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdateOracleConfigParams {
    /// New max price change per update in bps. 0 = no banding.
    pub max_price_change_bps: Option<u16>,
    /// Minimum number of sources required for oracle updates.
    pub min_sources: Option<u8>,
    /// Maximum staleness in seconds before oracle is considered stale.
    pub max_staleness_seconds: Option<u32>,
    /// Circuit breaker: max deviation from EMA in bps. 0 = disabled.
    pub circuit_breaker_deviation_bps: Option<u16>,
    /// v1.4.0: Per-oracle max confidence band in bps. 0 = use global default (200 bps).
    /// Range: 50-2000 bps (0.5%-20%). Wider for memecoins, tighter for majors.
    pub max_confidence_bps: Option<u16>,
}

#[derive(Accounts)]
pub struct UpdateOracleConfig<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"perk_oracle", perk_oracle.token_mint.as_ref()],
        bump = perk_oracle.bump,
    )]
    pub perk_oracle: Box<Account<'info, PerkOraclePrice>>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateOracleConfig>, params: UpdateOracleConfigParams) -> Result<()> {
    // M-02 fix: require oracle to be frozen before config changes.
    // Prevents admin from silently disabling banding on a live oracle.
    require!(ctx.accounts.perk_oracle.is_frozen, PerkError::OracleNotFrozen);

    let oracle = &mut ctx.accounts.perk_oracle;

    if let Some(max_price_change_bps) = params.max_price_change_bps {
        require!(
            max_price_change_bps == 0 || max_price_change_bps >= MIN_PRICE_CHANGE_BPS,
            PerkError::InvalidAmount
        );
        require!(max_price_change_bps <= MAX_PRICE_CHANGE_BPS, PerkError::InvalidAmount);
        let bps_bytes = max_price_change_bps.to_le_bytes();
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS] = bps_bytes[0];
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS + 1] = bps_bytes[1];
        msg!("  max_price_change_bps={}", max_price_change_bps);
    }

    if let Some(min_sources) = params.min_sources {
        require!(min_sources >= 1, PerkError::InvalidAmount);
        require!(min_sources <= MAX_MIN_SOURCES, PerkError::InvalidAmount);
        oracle.min_sources = min_sources;
        msg!("  min_sources={}", min_sources);
    }

    if let Some(max_staleness_seconds) = params.max_staleness_seconds {
        require!(max_staleness_seconds >= MIN_ORACLE_STALENESS_SECONDS, PerkError::InvalidAmount);
        require!(max_staleness_seconds <= MAX_ORACLE_STALENESS_SECONDS, PerkError::InvalidAmount);
        oracle.max_staleness_seconds = max_staleness_seconds;
        msg!("  max_staleness_seconds={}", max_staleness_seconds);
    }

    if let Some(circuit_breaker_deviation_bps) = params.circuit_breaker_deviation_bps {
        // ATK-05 R2 fix: Validate bounds (0 = disabled, otherwise [MIN, MAX])
        require!(
            circuit_breaker_deviation_bps == 0
                || circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS,
            PerkError::InvalidAmount
        );
        require!(
            circuit_breaker_deviation_bps <= MAX_CIRCUIT_BREAKER_BPS,
            PerkError::InvalidAmount
        );
        let cb_bytes = circuit_breaker_deviation_bps.to_le_bytes();
        oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS] = cb_bytes[0];
        oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS + 1] = cb_bytes[1];
        msg!("  circuit_breaker_deviation_bps={}", circuit_breaker_deviation_bps);
    }

    // v1.4.0: Per-oracle confidence threshold
    if let Some(max_confidence_bps) = params.max_confidence_bps {
        // 0 = reset to global default; otherwise must be in [50, 2000] bps
        require!(
            max_confidence_bps == 0
                || (max_confidence_bps >= 50 && max_confidence_bps <= 2000),
            PerkError::InvalidAmount
        );
        let conf_bytes = max_confidence_bps.to_le_bytes();
        oracle._reserved[RESERVED_OFFSET_MAX_CONFIDENCE_BPS] = conf_bytes[0];
        oracle._reserved[RESERVED_OFFSET_MAX_CONFIDENCE_BPS + 1] = conf_bytes[1];
        msg!("  max_confidence_bps={}", max_confidence_bps);
    }

    msg!("Oracle config updated for mint {}", oracle.token_mint);
    Ok(())
}
