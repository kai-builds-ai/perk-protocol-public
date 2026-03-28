use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct Protocol {
    pub admin: Pubkey,
    pub paused: bool,
    pub market_count: u64,
    pub protocol_fee_vault: Pubkey,

    // Protocol fee config
    pub creator_fee_share_bps: u16, // 1000 = 10%
    pub min_trading_fee_bps: u16,   // 3 = 0.03%
    pub max_trading_fee_bps: u16,   // 100 = 1%
    pub min_initial_liquidity: u64,

    // Global stats
    pub total_volume: u128,
    pub total_fees_collected: u128,
    pub total_users: u64,

    pub bump: u8,

    // M3 fix: Admin-configurable market creation fee
    pub market_creation_fee: u64,

    // M5 fix: Two-step admin transfer
    pub pending_admin: Option<Pubkey>,

    // Default oracle authority for permissionless oracle init
    // Set once by admin; all new PerkOracles inherit this as their update authority
    pub oracle_authority: Pubkey,
}

impl Protocol {
    pub const SIZE: usize = 8 // discriminator
        + 32  // admin
        + 1   // paused
        + 8   // market_count
        + 32  // protocol_fee_vault
        + 2   // creator_fee_share_bps
        + 2   // min_trading_fee_bps
        + 2   // max_trading_fee_bps
        + 8   // min_initial_liquidity
        + 16  // total_volume
        + 16  // total_fees_collected
        + 8   // total_users
        + 1   // bump
        + 8   // market_creation_fee
        + 33  // pending_admin (Option<Pubkey>)
        + 32  // oracle_authority
        + 32; // padding (was 64, carved 32 for oracle_authority)
}
