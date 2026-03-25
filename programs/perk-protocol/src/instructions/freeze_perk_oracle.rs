use anchor_lang::prelude::*;
use crate::constants::*;
use crate::state::{Protocol, PerkOraclePrice};

#[derive(Accounts)]
pub struct FreezePerkOracle<'info> {
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

pub fn handler(ctx: Context<FreezePerkOracle>, frozen: bool) -> Result<()> {
    let oracle = &mut ctx.accounts.perk_oracle;
    oracle.is_frozen = frozen;

    // H-01 fix: On unfreeze, zero the price and set a pending flag.
    // This forces read_perk_oracle_price to reject (price > 0 check fails),
    // so no instruction can use the stale pre-freeze price.
    // The update_perk_oracle handler checks unfreeze_pending to bypass
    // the gap attack check for exactly one update.
    if !frozen {
        // C-01 fix: store pre-freeze price in _reserved[3..11] for post-unfreeze banding.
        // The update handler will band the first post-unfreeze price against this reference,
        // preventing a compromised cranker from posting an arbitrary price after unfreeze.
        let pre_freeze_bytes = oracle.price.to_le_bytes();
        oracle._reserved[RESERVED_OFFSET_PRE_FREEZE_PRICE..RESERVED_OFFSET_PRE_FREEZE_PRICE + 8]
            .copy_from_slice(&pre_freeze_bytes);

        // Capture pre-freeze price before zeroing (needed for EMA + window anchoring)
        let pre_freeze_price = oracle.price;

        // ATK-01 R2 fix: Preserve pre-freeze price as EMA anchor so circuit breaker
        // is active on the first post-unfreeze update (prevents triple bypass).
        oracle.ema_price = pre_freeze_price;

        // ATK-01/ATK-06 R2 fix: Reset sliding window to pre-freeze price + current slot.
        // Prevents stale window reference from either blocking legitimate updates (short freeze)
        // or allowing unchecked jumps (long freeze).
        let clock = Clock::get()?;
        oracle._reserved[RESERVED_OFFSET_WINDOW_REF_PRICE..RESERVED_OFFSET_WINDOW_REF_PRICE + 8]
            .copy_from_slice(&pre_freeze_price.to_le_bytes());
        oracle._reserved[RESERVED_OFFSET_WINDOW_REF_SLOT..RESERVED_OFFSET_WINDOW_REF_SLOT + 8]
            .copy_from_slice(&clock.slot.to_le_bytes());

        oracle.price = 0;
        // Signal to update_perk_oracle that one gap-check bypass is allowed.
        oracle._reserved[RESERVED_OFFSET_UNFREEZE_PENDING] = 1;
    }

    msg!("PerkOracle {} {}", oracle.token_mint, if frozen { "FROZEN" } else { "UNFROZEN" });
    Ok(())
}
