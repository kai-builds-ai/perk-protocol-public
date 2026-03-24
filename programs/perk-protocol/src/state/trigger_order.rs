use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum TriggerOrderType {
    #[default]
    Limit,
    StopLoss,
    TakeProfit,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Default, Debug)]
pub enum Side {
    #[default]
    Long,
    Short,
}

#[account]
#[derive(Default)]
pub struct TriggerOrder {
    pub authority: Pubkey,
    pub market: Pubkey,
    pub order_id: u64,

    pub order_type: TriggerOrderType,
    pub side: Side,
    pub size: u64,
    pub trigger_price: u64,
    pub leverage: u32,

    pub reduce_only: bool,

    pub created_at: i64,
    pub expiry: i64, // 0 = GTC

    pub bump: u8,
}

impl TriggerOrder {
    pub const SIZE: usize = 8 + 200; // discriminator + padding
}
