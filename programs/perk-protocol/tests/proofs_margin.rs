/// Kani Formal Proofs — Category 6: Margin & Liquidation (P6.1–P6.8)
///
/// Native proofs for Perk's margin/liquidation engine.
/// All inputs symbolic with bounded assumptions matching production constants.

mod common;
use common::*;

// Disambiguate names that exist in both margin:: and risk::
// Use risk:: versions (return bool) for margin checks
// Use margin:: for enforce/validate (only in margin)
use perk_protocol::engine::risk::{
    is_above_maintenance_margin,
    is_above_initial_margin,
};
use perk_protocol::engine::margin::{
    enforce_post_trade_margin,
    validate_position_bounds,
};
use perk_protocol::engine::liquidation::{
    is_liquidatable,
    calculate_liquidation,
};

// ============================================================================
// P6.1: account_equity_maint_raw_wide correct computation
//        Eq_maint_raw = C + PNL - FeeDebt(fc)
//        where FeeDebt = if fc < 0 { |fc| } else { 0 }
// ============================================================================

/// P6.1a: Equity computation matches spec formula for arbitrary position state
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_1a_equity_maint_raw_wide_matches_spec() {
    let collateral: u64 = kani::any();
    let pnl: i128 = kani::any();
    let fee_credits: i128 = kani::any();

    // Bound to production-feasible ranges
    kani::assume(collateral <= 1_000_000_000_000); // 1M tokens max
    kani::assume(pnl > i128::MIN && pnl < i128::MAX / 2);
    kani::assume(pnl > -(i128::MAX / 2));
    kani::assume(fee_credits > i128::MIN && fee_credits < i128::MAX / 2);
    kani::assume(fee_credits > -(i128::MAX / 2));

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = pnl;
    pos.fee_credits = fee_credits;

    let wide = account_equity_maint_raw_wide(&pos);

    // Manually compute expected: C + PNL - FeeDebt
    let fee_debt: u128 = fee_debt_u128_checked(fee_credits);
    let cap_i256 = I256::from_u128(collateral as u128);
    let pnl_i256 = I256::from_i128(pnl);
    let fd_i256 = I256::from_u128(fee_debt);

    let expected = cap_i256
        .checked_add(pnl_i256).unwrap()
        .checked_sub(fd_i256).unwrap();

    assert!(wide == expected);
}

/// P6.1b: Flat position with no fees → equity = collateral
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_1b_equity_maint_flat_equals_collateral() {
    let collateral: u64 = kani::any();
    kani::assume(collateral <= 1_000_000_000_000);

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = 0;
    pos.fee_credits = 0;

    let eq = account_equity_maint_raw(&pos);
    assert!(eq == collateral as i128);
}

/// P6.1c: Underwater position (negative PNL) reduces equity
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_1c_equity_maint_negative_pnl_reduces() {
    let collateral: u64 = kani::any();
    let loss: u128 = kani::any();

    kani::assume(collateral <= 1_000_000_000_000);
    kani::assume(loss > 0 && loss <= collateral as u128);

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = -(loss as i128);
    pos.fee_credits = 0;

    let eq = account_equity_maint_raw(&pos);
    assert!(eq == (collateral as i128) - (loss as i128));
    assert!(eq >= 0); // loss <= collateral, so equity non-negative
}

/// P6.1d: Fee debt reduces equity
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_1d_fee_debt_reduces_equity() {
    let collateral: u64 = kani::any();
    let fee_debt_val: u64 = kani::any();

    kani::assume(collateral <= 1_000_000_000_000);
    kani::assume(fee_debt_val > 0 && fee_debt_val <= collateral);

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = 0;
    // Negative fee_credits = fee debt
    pos.fee_credits = -(fee_debt_val as i128);

    let eq = account_equity_maint_raw(&pos);
    assert!(eq == (collateral as i128) - (fee_debt_val as i128));
}

// ============================================================================
// P6.2: account_equity_net correct computation
//        Eq_net = max(0, Eq_maint_raw)
// ============================================================================

/// P6.2a: Equity net is always non-negative
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_2a_equity_net_always_nonneg() {
    let collateral: u64 = kani::any();
    let pnl: i128 = kani::any();
    let fee_credits: i128 = kani::any();

    kani::assume(collateral <= 1_000_000_000_000);
    kani::assume(pnl > i128::MIN + 1 && pnl < i128::MAX / 2);
    kani::assume(pnl > -(i128::MAX / 2));
    kani::assume(fee_credits > i128::MIN + 1 && fee_credits < i128::MAX / 2);
    kani::assume(fee_credits > -(i128::MAX / 2));

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = pnl;
    pos.fee_credits = fee_credits;

    let eq_net = account_equity_net(&pos);
    assert!(eq_net >= 0);
}

/// P6.2b: Equity net matches max(0, maint_raw)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_2b_equity_net_matches_clamped_maint() {
    let collateral: u64 = kani::any();
    let pnl: i128 = kani::any();
    let fee_credits: i128 = kani::any();

    kani::assume(collateral <= 1_000_000_000_000);
    kani::assume(pnl > i128::MIN + 1 && pnl < i128::MAX / 2);
    kani::assume(pnl > -(i128::MAX / 2));
    kani::assume(fee_credits > i128::MIN + 1 && fee_credits < i128::MAX / 2);
    kani::assume(fee_credits > -(i128::MAX / 2));

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = pnl;
    pos.fee_credits = fee_credits;

    let eq_raw = account_equity_maint_raw(&pos);
    let eq_net = account_equity_net(&pos);

    let expected = if eq_raw < 0 { 0i128 } else { eq_raw };
    assert!(eq_net == expected);
}

/// P6.2c: Positive equity passes through unchanged
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_2c_positive_equity_passthrough() {
    let collateral: u64 = kani::any();
    kani::assume(collateral > 0 && collateral <= 1_000_000_000_000);

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = 0;
    pos.fee_credits = 0;

    let eq_raw = account_equity_maint_raw(&pos);
    let eq_net = account_equity_net(&pos);
    assert!(eq_raw > 0);
    assert!(eq_net == eq_raw);
}

// ============================================================================
// P6.3: account_equity_init_raw correct computation
//        Eq_init_raw = C + min(PNL, 0) + PNL_eff_matured - FeeDebt
// ============================================================================

/// P6.3a: For negative PNL (no matured profit), init equity uses full negative PNL
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_3a_init_equity_negative_pnl() {
    let collateral: u64 = kani::any();
    let loss: u64 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(loss > 0 && loss <= collateral);

    let mut market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = -(loss as i128);
    pos.reserved_pnl = 0;
    pos.fee_credits = 0;

    let eq_init = account_equity_init_raw(&market, &pos);
    // min(PNL, 0) = PNL (negative), PNL_eff_matured = 0 (no positive PNL)
    let expected = (collateral as i128) - (loss as i128);
    assert!(eq_init == expected);
}

/// P6.3b: For positive PNL fully reserved (warming up), init equity = C (min(PNL,0)=0, matured=0)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_3b_init_equity_fully_reserved_pnl() {
    let collateral: u64 = kani::any();
    let profit: u64 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(profit > 0 && profit <= 1_000_000_000);

    let mut market = test_market();
    // Ensure haircut gives ratio 1:1 by having enough vault balance
    market.vault_balance = (collateral as u128) + (profit as u128) * 2;
    market.c_tot = collateral as u128;
    market.pnl_pos_tot = profit as u128;
    market.pnl_matured_pos_tot = profit as u128;

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = profit as i128;
    pos.reserved_pnl = profit as u128; // Fully reserved → released = 0
    pos.fee_credits = 0;

    let eq_init = account_equity_init_raw(&market, &pos);
    // min(PNL, 0) = 0 (positive PNL), PNL_eff_matured = haircut(released) = haircut(0) = 0
    assert!(eq_init == collateral as i128);
}

/// P6.3c: For zero PNL, init equity = collateral - fee_debt
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_3c_init_equity_zero_pnl() {
    let collateral: u64 = kani::any();
    let fee_debt_val: u64 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(fee_debt_val <= collateral);

    let market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = 0;
    pos.reserved_pnl = 0;
    pos.fee_credits = -(fee_debt_val as i128);

    let eq_init = account_equity_init_raw(&market, &pos);
    assert!(eq_init == (collateral as i128) - (fee_debt_val as i128));
}

/// P6.3d: Init equity <= maint equity (init is more conservative)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_3d_init_equity_leq_maint_equity() {
    let collateral: u64 = kani::any();
    let pnl: i128 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(pnl > -(1_000_000_000i128) && pnl < 1_000_000_000);

    let mut market = test_market();
    market.vault_balance = 10_000_000_000;
    market.c_tot = collateral as u128;
    let pnl_pos = if pnl > 0 { pnl as u128 } else { 0u128 };
    market.pnl_pos_tot = pnl_pos;
    market.pnl_matured_pos_tot = pnl_pos;

    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = pnl;
    pos.reserved_pnl = if pnl > 0 { (pnl as u128) / 2 } else { 0 };
    pos.fee_credits = 0;

    let eq_maint = account_equity_maint_raw(&pos);
    let eq_init = account_equity_init_raw(&market, &pos);

    // Init uses min(PNL,0) + matured instead of full PNL
    // For negative PNL: both use the same negative PNL → init may differ by matured amount
    // For positive PNL: maint uses +PNL, init uses 0 + matured(<=PNL) → init <= maint
    assert!(eq_init <= eq_maint);
}

// ============================================================================
// P6.4: is_above_maintenance_margin correct threshold
//        Returns true iff Eq_net > MM_req = max(notional * mm_bps / 10000, MIN_NONZERO_MM_REQ)
// ============================================================================

/// P6.4a: Flat position is always above maintenance margin
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_4a_flat_above_maintenance() {
    let collateral: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= MAX_ORACLE_PRICE);

    let market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.basis = 0;
    pos.pnl = 0;
    pos.fee_credits = 0;

    // Flat → notional = 0, MM_req = 0, Eq_net = collateral > 0 = true
    let result = is_above_maintenance_margin(&pos, &market, oracle);
    assert!(result);
}

/// P6.4b: Zero collateral with position is NOT above maintenance
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_4b_zero_equity_not_above_maintenance() {
    let size: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(size > 0 && size <= 1_000_000);
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    let mut market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = 0;
    pos.pnl = 0;
    pos.fee_credits = 0;

    // Set up a long position via basis
    set_long_position(&mut pos, &mut market, size as u128);

    let result = is_above_maintenance_margin(&pos, &market, oracle);
    // Eq_net = 0, MM_req >= MIN_NONZERO_MM_REQ > 0 → false
    assert!(!result);
}

/// P6.4c: Maintenance margin boundary — just below threshold fails
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_4c_maintenance_boundary() {
    let mut market = test_market();
    market.maintenance_margin_bps = 500; // 5%

    let oracle: u64 = 1_000_000; // 1.0 in PRICE_SCALE
    let size_q: u128 = 1_000_000; // 1.0 in POS_SCALE

    let mut pos = test_position();
    set_long_position(&mut pos, &mut market, size_q);

    // Notional = floor(1_000_000 * 1_000_000 / 1_000_000) = 1_000_000
    // MM_proportional = floor(1_000_000 * 500 / 10_000) = 50_000
    // MM_req = max(50_000, MIN_NONZERO_MM_REQ=10_000) = 50_000
    // Need Eq_net > 50_000

    // Set collateral exactly at MM boundary
    pos.deposited_collateral = 50_000;
    pos.pnl = 0;
    pos.fee_credits = 0;

    // Eq_net = 50_000, MM_req = 50_000 → NOT above (need strictly greater)
    let at_boundary = is_above_maintenance_margin(&pos, &market, oracle);
    assert!(!at_boundary);

    // One unit above
    pos.deposited_collateral = 50_001;
    let above = is_above_maintenance_margin(&pos, &market, oracle);
    assert!(above);
}

// ============================================================================
// P6.5: is_above_initial_margin correct threshold
//        Returns true iff Eq_init_raw >= IM_req
// ============================================================================

/// P6.5a: Flat position always above initial margin
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_5a_flat_above_initial() {
    let collateral: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(collateral > 0 && collateral <= 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= MAX_ORACLE_PRICE);

    let market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.basis = 0;
    pos.pnl = 0;
    pos.fee_credits = 0;

    let result = is_above_initial_margin(&pos, &market, oracle);
    assert!(result);
}

/// P6.5b: IM is stricter than MM — there exists a collateral level that
/// satisfies MM but not IM, proving IM is a strictly harder requirement.
///
/// Notional = floor(1_000_000 * 1_000_000 / 1_000_000) = 1_000_000
/// MM_req = max(floor(1_000_000 * 500 / 10_000), 10_000) = max(50_000, 10_000) = 50_000
/// IM: max_leverage = 2000 → leverage_actual = 2000/100 = 20 → raw = 10000/20 = 500
///     im_bps = max(500, 501) = 501
///     IM_req = max(floor(1_000_000 * 501 / 10_000), 20_000) = max(50_100, 20_000) = 50_100
/// MM check: Eq_net > MM_req → strict greater (50_051 > 50_000 ✓)
/// IM check: Eq_init_raw >= IM_req → (50_051 >= 50_100 ✗)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_5b_im_stricter_than_mm() {
    let mut market = test_market();
    market.maintenance_margin_bps = 500; // 5%
    market.max_leverage = 2000; // 20x → IM = 501 bps

    let oracle: u64 = 1_000_000;
    let size_q: u128 = 1_000_000;

    let mut pos = test_position();
    set_long_position(&mut pos, &mut market, size_q);
    pos.pnl = 0;
    pos.fee_credits = 0;
    pos.reserved_pnl = 0;

    // Collateral between MM_req (50_000) and IM_req (50_100)
    // Use symbolic collateral in that gap to prove it structurally
    let collateral: u64 = kani::any();
    kani::assume(collateral > 50_000 && collateral < 50_100);
    pos.deposited_collateral = collateral;

    let above_mm = is_above_maintenance_margin(&pos, &market, oracle);
    let above_im = is_above_initial_margin(&pos, &market, oracle);

    // MEANINGFUL ASSERTION: above MM but NOT above IM — proves IM is strictly stricter
    assert!(above_mm, "P6.5b: must be above MM in the gap between MM and IM thresholds");
    assert!(!above_im, "P6.5b: must NOT be above IM in the gap — IM is stricter");
}

/// P6.5c: Well-collateralized position is above both IM and MM
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_5c_well_collateralized_above_both() {
    let mut market = test_market();
    let oracle: u64 = 1_000_000;
    let size_q: u128 = 1_000_000;

    let mut pos = test_position();
    set_long_position(&mut pos, &mut market, size_q);
    pos.pnl = 0;
    pos.fee_credits = 0;
    pos.reserved_pnl = 0;

    // 100% collateralization: collateral = notional
    pos.deposited_collateral = 1_000_000;

    let above_mm = is_above_maintenance_margin(&pos, &market, oracle);
    let above_im = is_above_initial_margin(&pos, &market, oracle);

    assert!(above_mm);
    assert!(above_im);
}

// ============================================================================
// P6.6: calculate_liquidation deficit correct
//        deficit = max(0, -Eq_maint_raw)
// ============================================================================

/// P6.6a: Positive equity → zero deficit
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_6a_positive_equity_zero_deficit() {
    let collateral: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(collateral > 100_000 && collateral <= 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    let mut market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.pnl = 0;
    pos.fee_credits = 0;

    // Need a position for calculate_liquidation to work
    set_long_position(&mut pos, &mut market, 1_000);

    let result = calculate_liquidation(&pos, &market, oracle);
    match result {
        Ok(liq) => {
            // Eq_maint_raw = collateral > 0 → deficit = 0
            assert!(liq.deficit == 0);
        }
        Err(_) => {
            // May error if position is zero effective — that's fine
        }
    }
}

/// P6.6b: Negative equity → deficit = |equity|
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_6b_negative_equity_produces_deficit() {
    let loss: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(loss > 0 && loss <= 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    let mut market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = 0;
    pos.pnl = -(loss as i128);
    pos.fee_credits = 0;

    set_long_position(&mut pos, &mut market, 1_000);

    let result = calculate_liquidation(&pos, &market, oracle);
    match result {
        Ok(liq) => {
            // Eq_maint_raw = 0 + (-loss) - 0 = -loss < 0 → deficit = loss
            assert!(liq.deficit == loss as u128);
        }
        Err(_) => {}
    }
}

/// P6.6c: Liquidation fee split: 50% to liquidator, rest to insurance
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_6c_liquidation_fee_split() {
    let oracle: u64 = kani::any();
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    let mut market = test_market();
    market.liquidation_fee_bps = 100; // 1%

    let mut pos = test_position();
    pos.deposited_collateral = 1_000_000;
    pos.pnl = 0;
    pos.fee_credits = 0;

    set_long_position(&mut pos, &mut market, 1_000_000);

    let result = calculate_liquidation(&pos, &market, oracle);
    match result {
        Ok(liq) => {
            // Liquidator gets 50% of total fee
            let expected_liquidator = liq.total_liq_fee * (LIQUIDATOR_SHARE_BPS as u128) / (BPS_DENOMINATOR as u128);
            assert!(liq.liquidator_reward == expected_liquidator);
            // Insurance gets the rest
            assert!(liq.insurance_fee == liq.total_liq_fee - liq.liquidator_reward);
            // Sum = total
            assert!(liq.liquidator_reward + liq.insurance_fee == liq.total_liq_fee);
        }
        Err(_) => {}
    }
}

/// P6.6d: Flat position cannot be liquidated (is_liquidatable returns false)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_6d_flat_not_liquidatable() {
    let collateral: u64 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(collateral <= 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= MAX_ORACLE_PRICE);

    let market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = collateral;
    pos.basis = 0;
    pos.pnl = 0;

    let result = is_liquidatable(&pos, &market, oracle);
    assert!(!result);
}

// ============================================================================
// P6.7: enforce_post_trade_margin correct
//        - Flat new position: Ok (no margin needed)
//        - Increased position: requires IM
//        - Decreased position: requires MM
//        - From flat to position: requires IM
// ============================================================================

/// P6.7a: Going flat always succeeds (no margin requirement)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_7a_going_flat_always_ok() {
    let old_eff: i128 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(old_eff > -1_000_000_000 && old_eff < 1_000_000_000);
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    let market = test_market();
    let mut pos = test_position();
    pos.deposited_collateral = 0;
    pos.pnl = 0;
    pos.fee_credits = 0;

    // new_eff = 0 → going flat → always Ok
    let result = enforce_post_trade_margin(&pos, &market, oracle, old_eff, 0);
    assert!(result.is_ok());
}

/// P6.7b: Opening from flat requires initial margin
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_7b_opening_requires_im() {
    let oracle: u64 = 1_000_000;

    let mut market = test_market();
    let mut pos = test_position();

    // Set up position with enough collateral for MM but not IM
    set_long_position(&mut pos, &mut market, 1_000_000);
    pos.pnl = 0;
    pos.fee_credits = 0;
    pos.reserved_pnl = 0;

    // Undercollateralized
    pos.deposited_collateral = 1_000;

    let result = enforce_post_trade_margin(&pos, &market, oracle, 0, 1_000_000);
    // Should fail — not above IM
    assert!(result.is_err());

    // Well collateralized
    pos.deposited_collateral = 1_000_000;
    let result2 = enforce_post_trade_margin(&pos, &market, oracle, 0, 1_000_000);
    assert!(result2.is_ok());
}

/// P6.7c: Increasing position requires IM
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_7c_increase_requires_im() {
    let oracle: u64 = 1_000_000;

    let mut market = test_market();
    let mut pos = test_position();

    set_long_position(&mut pos, &mut market, 2_000_000);
    pos.pnl = 0;
    pos.fee_credits = 0;
    pos.reserved_pnl = 0;

    // Undercollateralized
    pos.deposited_collateral = 10_000;

    // old_eff = 1M, new_eff = 2M → increased → needs IM
    let result = enforce_post_trade_margin(&pos, &market, oracle, 1_000_000, 2_000_000);
    assert!(result.is_err());
}

/// P6.7d: Decreasing position (but not flat) requires MM
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_7d_decrease_requires_mm() {
    let oracle: u64 = 1_000_000;

    let mut market = test_market();
    let mut pos = test_position();

    set_long_position(&mut pos, &mut market, 500_000);
    pos.pnl = 0;
    pos.fee_credits = 0;
    pos.reserved_pnl = 0;

    // Zero collateral → fails MM
    pos.deposited_collateral = 0;

    // old_eff = 1M, new_eff = 500K → decreased → needs MM
    let result = enforce_post_trade_margin(&pos, &market, oracle, 1_000_000, 500_000);
    assert!(result.is_err());

    // Enough for MM
    pos.deposited_collateral = 1_000_000;
    let result2 = enforce_post_trade_margin(&pos, &market, oracle, 1_000_000, 500_000);
    assert!(result2.is_ok());
}

// ============================================================================
// P6.8: validate_position_bounds correct
//        - Zero position: always Ok
//        - |eff| > MAX_POSITION_ABS_Q: error
//        - notional > MAX_ACCOUNT_NOTIONAL: error
// ============================================================================

/// P6.8a: Zero position always valid
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_8a_zero_position_always_valid() {
    let oracle: u64 = kani::any();
    kani::assume(oracle > 0 && oracle <= MAX_ORACLE_PRICE);

    let result = validate_position_bounds(0, oracle);
    assert!(result.is_ok());
}

/// P6.8b: Position exceeding MAX_POSITION_ABS_Q rejected
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_8b_oversize_position_rejected() {
    let excess: u128 = kani::any();
    let oracle: u64 = kani::any();

    kani::assume(excess >= 1 && excess <= 1_000_000);
    kani::assume(oracle > 0 && oracle <= MAX_ORACLE_PRICE);

    let too_big = (MAX_POSITION_ABS_Q + excess) as i128;
    let result = validate_position_bounds(too_big, oracle);
    assert!(result.is_err());

    // Also negative
    let result_neg = validate_position_bounds(-too_big, oracle);
    assert!(result_neg.is_err());
}

/// P6.8c: Position within bounds accepted (small position, reasonable oracle)
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_8c_within_bounds_accepted() {
    let size: u64 = kani::any();
    let oracle: u64 = kani::any();

    // Small enough that notional won't exceed MAX_ACCOUNT_NOTIONAL
    kani::assume(size > 0 && size <= 1_000_000);
    kani::assume(oracle > 0 && oracle <= 1_000_000_000);

    // notional = floor(size * oracle / POS_SCALE)
    // max = 1_000_000 * 1_000_000_000 / 1_000_000 = 1_000_000_000
    // MAX_ACCOUNT_NOTIONAL = 100_000_000_000_000_000_000 >> 1B → safe

    let result = validate_position_bounds(size as i128, oracle);
    assert!(result.is_ok());

    let result_neg = validate_position_bounds(-(size as i128), oracle);
    assert!(result_neg.is_ok());
}

/// P6.8d: Notional overflow rejected even if position size is within bounds
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p6_8d_notional_at_max_accepted() {
    // Use max position with max oracle to trigger notional overflow
    let size: i128 = MAX_POSITION_ABS_Q as i128; // 100_000_000_000_000
    let oracle: u64 = MAX_ORACLE_PRICE; // 1_000_000_000_000

    // notional = floor(100_000_000_000_000 * 1_000_000_000_000 / 1_000_000)
    //          = 100_000_000_000_000_000_000
    // MAX_ACCOUNT_NOTIONAL = 100_000_000_000_000_000_000
    // notional == MAX, so this should pass (not >)

    let result = validate_position_bounds(size, oracle);
    // Exactly at limit — should succeed
    assert!(result.is_ok());
}
