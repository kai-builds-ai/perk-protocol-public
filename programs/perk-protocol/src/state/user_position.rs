use anchor_lang::prelude::*;

#[account]
#[derive(Default)]
pub struct UserPosition {
    pub authority: Pubkey,
    pub market: Pubkey,

    // Collateral (capital in Percolator terms)
    pub deposited_collateral: u64,

    // Position (0 = flat)
    pub base_size: i64,                // Positive = long, negative = short, 0 = flat
    pub quote_entry_amount: u128,      // Quote amount at entry (for PnL calc)
    pub last_cumulative_funding: i128, // Funding index at last settlement

    // Risk engine per-account state (from Percolator spec §2.1)
    pub pnl: i128,                     // Realized PnL (i128 for full Percolator range)
    pub reserved_pnl: u128,            // Warming up profit (u128 for full range)
    pub warmup_started_at_slot: u64,
    pub warmup_slope: u128,            // Linear warmup slope (u128 for full range)
    pub basis: i128,                   // Position basis in q-units (signed, i128 for full range)
    pub a_snapshot: u128,              // ADL A snapshot
    pub k_snapshot: i128,              // ADL K snapshot
    pub epoch_snapshot: u64,           // ADL epoch snapshot

    // Fee credits (spec §8.1) — signed: negative means debt
    pub fee_credits: i128,
    pub last_fee_slot: u64,

    // Trigger orders
    pub open_trigger_orders: u8,
    pub max_trigger_orders: u8,

    // C4: Monotonic trigger order counter (never decremented)
    pub next_order_id: u64,

    // C5: Last interaction slot for reclaim delay
    pub last_activity_slot: u64,

    pub bump: u8,

    // v1.4.0: Peg multiplier snapshot at position open time.
    // 0 = legacy position (opened before v1.4.0) — frontend falls back to historical lookup.
    pub peg_at_entry: u128,
}

impl UserPosition {
    pub const SIZE: usize = 8 + 600; // discriminator + generous padding
}
