use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::PerkOraclePrice;
use crate::errors::PerkError;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct UpdatePerkOracleParams {
    pub price: u64,
    pub confidence: u64,
    pub num_sources: u8,
}

#[derive(Accounts)]
pub struct UpdatePerkOracle<'info> {
    #[account(
        mut,
        seeds = [b"perk_oracle", perk_oracle.token_mint.as_ref()],
        bump = perk_oracle.bump,
        has_one = authority,
    )]
    pub perk_oracle: Box<Account<'info, PerkOraclePrice>>,

    pub authority: Signer<'info>,
}

pub fn handler(ctx: Context<UpdatePerkOracle>, params: UpdatePerkOracleParams) -> Result<()> {
    let oracle = &mut ctx.accounts.perk_oracle;
    let clock = Clock::get()?;

    // Security check: not frozen
    require!(!oracle.is_frozen, PerkError::OracleFrozen);

    // Security check: price must be positive and within normative bounds
    require!(params.price > 0, PerkError::OraclePriceInvalid);
    require!(params.price <= MAX_ORACLE_PRICE, PerkError::OraclePriceInvalid);

    // Security check: minimum sources met
    require!(params.num_sources >= oracle.min_sources, PerkError::OracleInsufficientSources);

    // Security check: rate limit — max one update per slot
    require!(clock.slot > oracle.last_slot, PerkError::OracleUpdateTooFrequent);

    // Security check: no gap attack — if oracle was stale for >2x max_staleness,
    // require admin to unfreeze first (prevents stale→wild jump exploitation).
    // H-01 fix: unfreeze_pending flag — bypasses gap check once after unfreeze.
    let unfreeze_pending = oracle._reserved[RESERVED_OFFSET_UNFREEZE_PENDING] == 1;
    if oracle.timestamp > 0 && !unfreeze_pending {
        let gap = clock.unix_timestamp.saturating_sub(oracle.timestamp);
        let max_gap = (oracle.max_staleness_seconds as i64).saturating_mul(2);
        require!(gap <= max_gap, PerkError::OracleGapTooLarge);
    }
    // Clear the unfreeze_pending flag after use
    if unfreeze_pending {
        oracle._reserved[RESERVED_OFFSET_UNFREEZE_PENDING] = 0;
    }

    // Security check: price banding — if max_price_change_bps is set (non-zero),
    // reject updates that move price more than X% from the reference price.
    // 0 = no banding (memecoins).
    // Reference price: oracle.price if available, otherwise pre-freeze price
    // (C-01 fix — prevents banding bypass after unfreeze).
    let max_change_bps = u16::from_le_bytes([
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS],
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS + 1],
    ]);
    if max_change_bps > 0 {
        let reference_price = if oracle.price > 0 {
            oracle.price
        } else {
            // Post-unfreeze or first update — check for stored pre-freeze price
            let pre_freeze_bytes: [u8; 8] = oracle._reserved[RESERVED_OFFSET_PRE_FREEZE_PRICE..RESERVED_OFFSET_PRE_FREEZE_PRICE + 8]
                .try_into()
                .unwrap_or([0u8; 8]);
            u64::from_le_bytes(pre_freeze_bytes)
        };

        if reference_price > 0 {
            let diff = if params.price > reference_price {
                params.price - reference_price
            } else {
                reference_price - params.price
            };
            let change_bps = diff
                .checked_mul(BPS_DENOMINATOR)
                .ok_or(PerkError::MathOverflow)?
                / reference_price;
            require!(change_bps <= max_change_bps as u64, PerkError::OraclePriceInvalid);
        }
    }

    // Capture old EMA before update for circuit breaker check
    let old_ema = oracle.ema_price;

    // Update EMA (simple exponential: ema = (price + 9 * old_ema) / 10)
    // First update: set EMA to price directly.
    // Uses saturating math — EMA is non-critical (not consumed by any instruction),
    // so overflow must NOT brick the oracle by reverting the update.
    if oracle.ema_price == 0 {
        oracle.ema_price = params.price;
    } else {
        let raw_ema = params.price
            .saturating_add(oracle.ema_price.saturating_mul(9))
            / 10;
        // M-01 fix: cap EMA to MAX_ORACLE_PRICE — prevents saturating math
        // from corrupting EMA to ~u64::MAX when prices are extreme.
        oracle.ema_price = raw_ema.min(MAX_ORACLE_PRICE);
    }

    // Circuit breaker: reject if price deviates too far from EMA
    let cb_bps = u16::from_le_bytes([
        oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS],
        oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS + 1],
    ]);
    if cb_bps > 0 && old_ema > 0 {
        let deviation = if params.price > old_ema {
            params.price - old_ema
        } else {
            old_ema - params.price
        };
        let deviation_bps = deviation
            .checked_mul(BPS_DENOMINATOR)
            .ok_or(PerkError::MathOverflow)?
            / old_ema;
        require!(deviation_bps <= cb_bps as u64, PerkError::OracleCircuitBreakerTripped);
    }

    // Sliding window banding: limit cumulative price change over a window
    let max_change_bps_val = u16::from_le_bytes([
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS],
        oracle._reserved[RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS + 1],
    ]);
    if max_change_bps_val > 0 {
        let window_ref_bytes: [u8; 8] = oracle._reserved[RESERVED_OFFSET_WINDOW_REF_PRICE..RESERVED_OFFSET_WINDOW_REF_PRICE + 8]
            .try_into().unwrap_or([0u8; 8]);
        let window_ref_price = u64::from_le_bytes(window_ref_bytes);
        let window_ref_slot_bytes: [u8; 8] = oracle._reserved[RESERVED_OFFSET_WINDOW_REF_SLOT..RESERVED_OFFSET_WINDOW_REF_SLOT + 8]
            .try_into().unwrap_or([0u8; 8]);
        let window_ref_slot = u64::from_le_bytes(window_ref_slot_bytes);

        if window_ref_price > 0 {
            let slots_since = clock.slot.saturating_sub(window_ref_slot);
            if slots_since <= CIRCUIT_BREAKER_WINDOW_SLOTS {
                // Within window — check cumulative deviation from window start
                let window_max_bps = (max_change_bps_val as u64).saturating_mul(WINDOW_BAND_MULTIPLIER);
                let window_diff = if params.price > window_ref_price {
                    params.price - window_ref_price
                } else {
                    window_ref_price - params.price
                };
                let window_change_bps = window_diff
                    .checked_mul(BPS_DENOMINATOR)
                    .ok_or(PerkError::MathOverflow)?
                    / window_ref_price;
                require!(window_change_bps <= window_max_bps, PerkError::OraclePriceInvalid);
            } else {
                // Window expired — start new window with current price
                oracle._reserved[RESERVED_OFFSET_WINDOW_REF_PRICE..RESERVED_OFFSET_WINDOW_REF_PRICE + 8]
                    .copy_from_slice(&params.price.to_le_bytes());
                oracle._reserved[RESERVED_OFFSET_WINDOW_REF_SLOT..RESERVED_OFFSET_WINDOW_REF_SLOT + 8]
                    .copy_from_slice(&clock.slot.to_le_bytes());
            }
        } else {
            // First update — initialize window reference
            oracle._reserved[RESERVED_OFFSET_WINDOW_REF_PRICE..RESERVED_OFFSET_WINDOW_REF_PRICE + 8]
                .copy_from_slice(&params.price.to_le_bytes());
            oracle._reserved[RESERVED_OFFSET_WINDOW_REF_SLOT..RESERVED_OFFSET_WINDOW_REF_SLOT + 8]
                .copy_from_slice(&clock.slot.to_le_bytes());
        }
    }

    // Update fields
    oracle.price = params.price;
    oracle.confidence = params.confidence;
    oracle.timestamp = clock.unix_timestamp;
    oracle.num_sources = params.num_sources;
    oracle.last_slot = clock.slot;
    oracle.total_updates = oracle.total_updates.saturating_add(1);

    Ok(())
}
