use anchor_lang::prelude::*;

#[account]
pub struct PerkOraclePrice {
    pub bump: u8,
    pub token_mint: Pubkey,           // What token this prices
    pub authority: Pubkey,            // Who can update (cranker)
    pub price: u64,                   // Price in PRICE_SCALE (1e6) — unsigned, always positive
    pub confidence: u64,              // Spread across sources (1e6 scale)
    pub timestamp: i64,               // Unix timestamp of last update
    pub num_sources: u8,              // How many sources contributed to this price
    pub min_sources: u8,              // Minimum sources required for a valid update
    pub last_slot: u64,               // Solana slot of last update
    pub ema_price: u64,               // Exponential moving average (smoothed)
    pub max_staleness_seconds: u32,   // After this, oracle is considered stale
    pub is_frozen: bool,              // Admin emergency freeze
    pub created_at: i64,
    pub total_updates: u64,           // Lifetime update counter
    pub _reserved: [u8; 64],         // Future-proofing
}

impl PerkOraclePrice {
    pub const SIZE: usize = 8   // discriminator
        + 1    // bump
        + 32   // token_mint
        + 32   // authority
        + 8    // price
        + 8    // confidence
        + 8    // timestamp
        + 1    // num_sources
        + 1    // min_sources
        + 8    // last_slot
        + 8    // ema_price
        + 4    // max_staleness_seconds
        + 1    // is_frozen
        + 8    // created_at
        + 8    // total_updates
        + 64;  // _reserved
}
