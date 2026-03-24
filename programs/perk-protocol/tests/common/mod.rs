//! Shared test helpers for Kani formal proofs.
//!
//! These build Market and UserPosition structs with sensible defaults,
//! exposing only the fields proofs need to customize.

pub use perk_protocol::state::market::*;
pub use perk_protocol::state::user_position::*;
pub use perk_protocol::engine::*;
pub use perk_protocol::engine::risk::*;
pub use perk_protocol::engine::wide_math::*;
pub use perk_protocol::engine::i128_types::*;
pub use perk_protocol::engine::margin::*;
pub use perk_protocol::engine::liquidation::*;
pub use perk_protocol::engine::funding::*;
pub use perk_protocol::engine::warmup::*;
pub use perk_protocol::constants::*;
pub use anchor_lang::prelude::Pubkey;

// ============================================================================
// Constants
// ============================================================================

pub const DEFAULT_ORACLE: u64 = 1_000;
pub const DEFAULT_SLOT: u64 = 100;

// Small-model constants for CBMC tractability
pub const S_POS_SCALE: u128 = POS_SCALE;   // Use real scale
pub const S_ADL_ONE: u128 = ADL_ONE;        // Use real scale

// ============================================================================
// Factory: Market with sensible defaults
// ============================================================================

pub fn test_market() -> Market {
    let mut m = Market::default();
    m.active = true;
    m.maintenance_margin_bps = 500;     // 5%
    m.trading_fee_bps = 10;             // 0.1%
    m.liquidation_fee_bps = 100;        // 1%
    m.max_leverage = 2000;
    m.warmup_period_slots = 100;
    m.funding_period_seconds = 3600;
    m.funding_rate_cap_bps = 10;
    m.long_a = ADL_ONE;
    m.short_a = ADL_ONE;
    m.long_epoch = 1;
    m.short_epoch = 1;
    m.long_state = SideState::Normal;
    m.short_state = SideState::Normal;
    m.haircut_numerator = 1;
    m.haircut_denominator = 1;
    m.current_slot = DEFAULT_SLOT;
    m.last_market_slot = DEFAULT_SLOT;
    m.last_oracle_price = DEFAULT_ORACLE;
    m.base_reserve = 1_000_000_000;
    m.quote_reserve = 1_000_000_000;
    m.k = m.base_reserve * m.quote_reserve;
    m.peg_multiplier = DEFAULT_ORACLE as u128;
    m
}

// Zero-fee market for conservation proofs (no fee noise)
pub fn zero_fee_market() -> Market {
    let mut m = test_market();
    m.trading_fee_bps = 0;
    m.liquidation_fee_bps = 0;
    m
}

// ============================================================================
// Factory: UserPosition with sensible defaults
// ============================================================================

pub fn test_position() -> UserPosition {
    let mut p = UserPosition::default();
    p.a_snapshot = ADL_ONE;
    p.epoch_snapshot = 1;
    p
}

// Position with collateral deposited
pub fn funded_position(collateral: u64) -> UserPosition {
    let mut p = test_position();
    p.deposited_collateral = collateral;
    p
}

// ============================================================================
// Helper: simulate deposit (updates position + market aggregates)
// ============================================================================

pub fn sim_deposit(pos: &mut UserPosition, market: &mut Market, amount: u64) {
    let old_cap = pos.deposited_collateral as u128;
    let new_cap = old_cap + amount as u128;
    set_capital(pos, market, new_cap).unwrap();
    market.vault_balance += amount as u128;
}

// ============================================================================
// Helper: give a position a non-zero basis (for PnL/settlement proofs)
// ============================================================================

pub fn set_long_position(pos: &mut UserPosition, market: &mut Market, size_q: u128) {
    let basis = size_q as i128;
    set_position_basis_q(pos, market, basis);
    pos.a_snapshot = market.long_a;
    pos.k_snapshot = market.long_k_index;
    pos.epoch_snapshot = market.long_epoch;
    market.oi_eff_long_q += size_q;
}

pub fn set_short_position(pos: &mut UserPosition, market: &mut Market, size_q: u128) {
    let basis = -(size_q as i128);
    set_position_basis_q(pos, market, basis);
    pos.a_snapshot = market.short_a;
    pos.k_snapshot = market.short_k_index;
    pos.epoch_snapshot = market.short_epoch;
    market.oi_eff_short_q += size_q;
}
