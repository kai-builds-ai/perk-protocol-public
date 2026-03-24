pub mod i128_types;
pub mod wide_math;
pub mod vamm;
pub mod risk;
pub mod funding;
pub mod margin;
pub mod liquidation;
pub mod oracle;
pub mod warmup;

// Selective re-exports to avoid ambiguity between risk:: and margin:: functions
pub use i128_types::*;
pub use wide_math::*;
pub use vamm::*;
pub use funding::*;
pub use oracle::*;
pub use warmup::*;

// Re-export risk (primary engine) and liquidation directly
// margin functions accessed via margin:: prefix to avoid collisions
pub use risk::{
    Side, side_of_i128, opposite_side, i128_clamp_pos,
    haircut_ratio, released_pos, effective_matured_pnl,
    effective_position_q, notional,
    set_pnl, set_reserved_pnl, consume_released_pnl,
    set_capital, set_position_basis_q,
    settle_side_effects, accrue_market_to,
    attach_effective_position, attach_position,
    side_allows_increase,
    begin_full_drain_reset, finalize_side_reset, maybe_finalize_ready_reset_sides,
    use_insurance_buffer, absorb_protocol_loss,
    enqueue_adl,
    settle_losses, resolve_flat_negative, do_profit_conversion, fee_debt_sweep,
    charge_fee_to_insurance, deposit_fee_credits,
    touch_account_full, advance_profit_warmup,
    reclaim_empty_account, update_oi_delta,
    check_conservation, compute_trade_pnl,
    set_funding_rate_for_next_interval, check_and_clear_phantom_dust,
    account_equity_maint_raw_wide, account_equity_maint_raw,
    account_equity_net, account_equity_init_raw,
    finalize_pending_resets,
};
pub use liquidation::*;
