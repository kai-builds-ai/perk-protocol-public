use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum OracleSource {
    #[default]
    Pyth,
    DexPool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum SideState {
    #[default]
    Normal,
    DrainOnly,
    ResetPending,
}

#[account]
#[derive(Default)]
pub struct Market {
    // Identity
    pub market_index: u64,
    pub token_mint: Pubkey,
    pub collateral_mint: Pubkey,
    pub creator: Pubkey,

    // Vault
    pub vault: Pubkey,
    pub vault_bump: u8,

    // vAMM State
    pub base_reserve: u128,
    pub quote_reserve: u128,
    pub k: u128,
    pub peg_multiplier: u128,
    pub total_long_position: u128,
    pub total_short_position: u128,

    // Market parameters (set at creation; trading_fee_bps and max_leverage are admin-updatable via admin_update_market)
    pub max_leverage: u32,
    pub trading_fee_bps: u16,
    pub liquidation_fee_bps: u16,
    pub maintenance_margin_bps: u16,

    // Oracle
    pub oracle_source: OracleSource,
    pub oracle_address: Pubkey,

    // Risk engine state (from Percolator)
    pub insurance_fund_balance: u64,
    pub haircut_numerator: u128,
    pub haircut_denominator: u128,

    // ADL side state — long
    pub long_a: u128,
    pub long_k_index: i128,
    pub long_epoch: u64,
    pub long_state: SideState,
    pub long_epoch_start_k: i128,

    // ADL side state — short
    pub short_a: u128,
    pub short_k_index: i128,
    pub short_epoch: u64,
    pub short_state: SideState,
    pub short_epoch_start_k: i128,

    // Funding
    pub last_funding_time: i64,
    pub cumulative_long_funding: i128,
    pub cumulative_short_funding: i128,
    pub funding_period_seconds: u32,
    pub funding_rate_cap_bps: u16,

    // Warmup
    pub warmup_period_slots: u64,

    // Fee tracking
    pub creator_fees_earned: u64,
    pub protocol_fees_earned: u64,
    pub total_volume: u128,

    // State
    pub active: bool,
    pub total_users: u32,
    pub total_positions: u32,

    // Aggregates for risk engine (spec §2.2)
    pub c_tot: u128,
    pub pnl_pos_tot: u128,
    pub pnl_matured_pos_tot: u128,
    pub vault_balance: u128,

    // OI tracking
    pub oi_eff_long_q: u128,
    pub oi_eff_short_q: u128,
    pub stored_pos_count_long: u64,
    pub stored_pos_count_short: u64,

    pub bump: u8,
    pub created_at: i64,

    // === Fields for security fixes ===

    // H1: Position size limits
    pub max_position_size: u128,
    pub max_oi: u128,

    // H3: Peg update cooldown
    pub last_peg_update_slot: u64,

    // H4: TWAP mark price for funding
    pub last_mark_price_for_funding: u64,

    // C7: Claimable fee balances
    pub creator_claimable_fees: u64,
    pub protocol_claimable_fees: u64,

    // H6: Insurance fund epoch tracking
    pub insurance_epoch_start: i64,
    pub insurance_epoch_payout: u64,

    // === Percolator accrue_market_to state ===

    /// Last oracle price used in accrue_market_to (spec §5.4)
    pub last_oracle_price: u64,

    /// Last slot used in accrue_market_to
    pub last_market_slot: u64,

    /// Current slot (updated on every touch)
    pub current_slot: u64,

    /// Stored funding rate for anti-retroactivity (bps per slot, spec §5.5)
    pub funding_rate_bps_per_slot_last: i64,

    /// Funding price sample for anti-retroactivity
    pub funding_price_sample_last: u64,

    /// Insurance floor (spec §4.7)
    pub insurance_floor: u128,

    /// Stale account counts per side (for ResetPending drain tracking)
    pub stale_account_count_long: u64,
    pub stale_account_count_short: u64,

    /// Dynamic phantom dust bounds (spec §4.6, §5.7)
    pub phantom_dust_bound_long_q: u128,
    pub phantom_dust_bound_short_q: u128,

    /// Insurance fee revenue tracking
    pub insurance_fee_revenue: u128,

    // H4 fix: Deferred reset flags for enqueue_adl
    pub pending_reset_long: bool,
    pub pending_reset_short: bool,

    // M8 fix: TWAP accumulator for funding
    pub mark_price_accumulator: u128,
    pub twap_observation_count: u32,

    // M2 (R4): Volume-weighted TWAP accumulator
    pub twap_volume_accumulator: u128,

    // M3 fix: Market creation fee (tracked for protocol treasury)
    // (Fee is transferred at creation, this records it was paid)
    pub creation_fee_paid: u64,
}

impl Market {
    pub const SIZE: usize = 8 + 2000; // discriminator + generous padding for all fields
}
