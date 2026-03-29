/// Admin-only: Reset K indices on a market with no open positions.
///
/// Zeroes long_k_index, short_k_index, long_epoch_start_k, short_epoch_start_k.
/// Safe ONLY when total_long_position == 0 AND total_short_position == 0 —
/// otherwise existing positions' k_snapshots would mismatch the reset K values,
/// producing phantom PNL in the opposite direction.
///
/// Enforced on-chain: rejects if any open interest exists.

use anchor_lang::prelude::*;
use crate::errors::PerkError;
use crate::state::{Market, Protocol};

#[derive(Accounts)]
pub struct AdminResetKIndices<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        has_one = admin,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminResetKIndices>) -> Result<()> {
    let market = &mut ctx.accounts.market;

    // Safety: K reset is only valid when no positions exist
    require!(
        market.total_long_position == 0 && market.total_short_position == 0,
        PerkError::MarketHasOpenPositions
    );

    let old_long_k = market.long_k_index;
    let old_short_k = market.short_k_index;

    market.long_k_index = 0;
    market.short_k_index = 0;
    market.long_epoch_start_k = 0;
    market.short_epoch_start_k = 0;

    msg!(
        "K indices reset: long_k {} -> 0, short_k {} -> 0",
        old_long_k,
        old_short_k,
    );

    Ok(())
}
