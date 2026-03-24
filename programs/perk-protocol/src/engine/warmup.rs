/// PnL Warmup Window — Full-Fidelity Port from Percolator v11.26
///
/// Anti-oracle-manipulation: new profit enters reserved_pnl (locked)
/// and converts to matured profit linearly over warmup_period_slots.
///
/// All modifications to reserved_pnl go through risk::set_reserved_pnl
/// to maintain pnl_matured_pos_tot aggregate atomically.
///
/// Uses saturating_mul_u128_u64 from wide_math for warmup cap computation.

use crate::engine::risk;
use crate::engine::wide_math::saturating_mul_u128_u64;
use crate::state::{Market, UserPosition};

/// Advance profit warmup: release reserved PnL based on elapsed slots (spec §4.9)
///
/// release = min(reserved_pnl, slope * elapsed_slots)
/// Uses saturating_mul_u128_u64 for cap computation (faithful to reference).
pub fn advance_warmup(
    position: &mut UserPosition,
    market: &mut Market,
    warmup_period_slots: u64,
    current_slot: u64,
) {
    let r = position.reserved_pnl;
    if r == 0 {
        position.warmup_slope = 0;
        position.warmup_started_at_slot = current_slot;
        return;
    }

    if warmup_period_slots == 0 {
        risk::set_reserved_pnl(position, market, 0);
        position.warmup_slope = 0;
        position.warmup_started_at_slot = current_slot;
        return;
    }

    let elapsed = current_slot.saturating_sub(position.warmup_started_at_slot);
    let cap = saturating_mul_u128_u64(position.warmup_slope, elapsed);
    let release = core::cmp::min(r, cap);

    if release > 0 {
        let new_reserved = r.saturating_sub(release);
        risk::set_reserved_pnl(position, market, new_reserved);
    }

    if position.reserved_pnl == 0 {
        position.warmup_slope = 0;
    }

    position.warmup_started_at_slot = current_slot;
}

/// Reset warmup on liquidation path — Issue #22 fix
///
/// When a position is liquidated, the warmup slope MUST be reset to prevent
/// stale warmup state from carrying over if the user opens a new position.
pub fn reset_warmup_on_liquidation(position: &mut UserPosition, market: &mut Market) {
    risk::set_reserved_pnl(position, market, 0);
    position.warmup_slope = 0;
    position.warmup_started_at_slot = 0;
}
