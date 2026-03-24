# Kani Proof Specification — Properties to Verify

Extracted from Percolator reference (186 proofs) + red team findings.
Each property must have at least one native Kani proof against Perk's engine.

## Category 1: Arithmetic (wide_math, i128_types)
- P1.1: floor_div_signed_conservative is correct floor division
- P1.2: mul_div_floor algebraic identity (q*c + r == a*b, r < c)
- P1.3: mul_div_ceil == floor + (r != 0 ? 1 : 0)
- P1.4: mul_div_floor/ceil match reference for u8 range
- P1.5: fee_debt_u128_checked: negative fc → abs, positive → 0
- P1.6: saturating_mul_u256_u64 saturates at MAX
- P1.7: ceil_div_positive_checked matches reference
- P1.8: wide_signed_mul_div_floor correct sign and rounding
- P1.9: wide_signed_mul_div_floor_from_k_pair correct with K-difference
- P1.10: K-pair with equal k_now/k_then returns 0
- P1.11: Zero inputs produce zero results
- P1.12: Notional is zero for flat position
- P1.13: Notional is monotone in price
- P1.14: fused_delta_k no double rounding
- P1.15: haircut_mul_div conservative (floor, never overshoots)

## Category 2: Safety (conservation, bounds, no-mint)
- P2.1: Deposit conserves vault balance
- P2.2: Withdrawal conserves vault balance
- P2.3: Trade conserves total value (zero-sum PnL)
- P2.4: Liquidation conserves total value
- P2.5: Haircut ratio bounded: h_num <= h_den, h_den != 0
- P2.6: Equity non-negative for flat position
- P2.7: **FUNDING CANNOT MINT TOKENS** (critical — was vacuous in R1)
- P2.8: ADL enqueue correctness (a_new < a_old, epoch increments)
- P2.9: ADL dust bounds (remainder < k after mul_div)
- P2.10: Insurance buffer respects epoch cap
- P2.11: Insurance buffer respects floor
- P2.12: absorb_protocol_loss respects haircut floor
- P2.13: Fee debt sweep conservation
- P2.14: Fee credits never i128::MIN
- P2.15: reclaim_empty_account rejects open positions
- P2.16: reclaim_empty_account rejects live capital
- P2.17: Phantom dust drain no revert
- P2.18: Protected principal (capital can't go below zero)
- P2.19: Trading loss seniority (PnL debt before capital)
- P2.20: compute_trade_pnl no panic at boundary

## Category 3: Invariants (state machine properties)
- P3.1: set_pnl maintains pnl_pos_tot aggregate
- P3.2: set_capital maintains c_tot aggregate
- P3.3: set_position_basis_q maintains OI/count tracking
- P3.4: check_conservation holds after deposit
- P3.5: check_conservation holds after loss settlement
- P3.6: Effective position returns 0 for flat
- P3.7: Effective position returns 0 for epoch mismatch
- P3.8: attach_effective_position updates side counts correctly
- P3.9: Warmup release bounded by reserved_pnl
- P3.10: Warmup release bounded by slope * elapsed

## Category 4: Liveness (system makes progress)
- P4.1: maybe_finalize_ready_reset_sides auto-finalizes
- P4.2: Precision exhaustion terminal drain works
- P4.3: Bankruptcy liquidation routes quantity when D=0
- P4.4: Pure PnL bankruptcy path works
- P4.5: check_and_clear_phantom_dust clears correctly

## Category 5: Funding (MUST USE PRE-SCALED RATES)
- P5.1: accrue_market_to mark delta matches eager computation (non-zero funding)
- P5.2: Funding K-deltas correct for long payer
- P5.3: Funding K-deltas correct for short payer
- P5.4: Funding rate clamped to max
- P5.5: set_funding_rate_for_next_interval stores correctly
- P5.6: calculate_funding_rate correct (if exists)
- P5.7: update_funding correct (if exists)

## Category 6: Margin & Liquidation
- P6.1: account_equity_maint_raw_wide correct computation
- P6.2: account_equity_net correct computation
- P6.3: account_equity_init_raw correct computation
- P6.4: is_above_maintenance_margin correct threshold
- P6.5: is_above_initial_margin correct threshold
- P6.6: calculate_liquidation deficit correct
- P6.7: enforce_post_trade_margin correct (if exists)
- P6.8: validate_position_bounds correct (if exists)

## Category 7: Engine functions needing NEW proofs (red team finding)
- P7.1: consume_released_pnl conservation
- P7.2: do_profit_conversion conservation
- P7.3: update_oi_delta correctness
- P7.4: touch_account_full end-to-end settlement
- P7.5: deposit_fee_credits checked arithmetic
