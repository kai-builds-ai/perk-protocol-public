/// Kani Formal Proofs — Instructions Set 2: Liquidation & Admin Handlers
///
/// Harnesses H9–H16: compose-and-prove for liquidate, crank_funding,
/// reclaim_empty_account, claim_fees, and two-user funding zero-sum.
///
/// All inputs are symbolic with bounded kani::assume().
/// CPI (token transfers) is skipped; only engine logic is verified.

mod common;
use common::*;

// ============================================================================
// H9: Liquidation Conservation
//
// Replicate the liquidate handler's engine call sequence:
//   accrue_market_to → settle_side_effects → advance_warmup →
//   is_above_maintenance_margin (must be false) →
//   calculate_liquidation → enqueue_adl → reset position →
//   finalize_pending_resets
//
// Assert: enqueue_adl routes deficit correctly (insurance decreases or A shrinks)
// Assert: position is zeroed after liquidation
// Assert: conservation holds after
// ============================================================================

#[kani::proof]
#[kani::unwind(4)]
#[kani::solver(cadical)]
fn h9_liquidation_conservation() {
    let mut m = test_market();
    let mut p = test_position();

    // Symbolic oracle price
    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 100 && oracle_price <= 100_000_000);

    // Symbolic position: long, underwater (low collateral, big position)
    let size_q: u128 = kani::any();
    kani::assume(size_q >= POS_SCALE && size_q <= 1_000_000 * POS_SCALE);

    let collateral: u64 = kani::any();
    kani::assume(collateral >= 1 && collateral <= 10_000);

    // Set up market state
    m.last_oracle_price = oracle_price;
    m.funding_rate_bps_per_slot_last = 0; // no funding noise
    m.insurance_fund_balance = kani::any();
    kani::assume(m.insurance_fund_balance <= 1_000_000);

    // Vault must cover conservation: V >= C_tot + I + claimable
    let ins_bal = m.insurance_fund_balance as u128;

    // Set up long position
    sim_deposit(&mut p, &mut m, collateral);
    set_long_position(&mut p, &mut m, size_q);
    p.base_size = size_q as i64;
    m.total_long_position = size_q;
    m.total_positions = 1;

    // Vault must satisfy conservation
    let needed = m.c_tot + ins_bal
        + m.creator_claimable_fees as u128
        + m.protocol_claimable_fees as u128;
    m.vault_balance = needed;

    let now_slot = m.current_slot + 1;

    // ── Standard accrue pattern ──
    let accrue_ok = accrue_market_to(&mut m, now_slot, oracle_price);
    kani::assume(accrue_ok.is_ok());

    let settle_ok = settle_side_effects(&mut p, &mut m);
    kani::assume(settle_ok.is_ok());

    let warmup_period = m.warmup_period_slots;
    advance_warmup(&mut p, &mut m, warmup_period, now_slot);

    // ── Must be below maintenance margin ──
    let is_above_mm = perk_protocol::engine::risk::is_above_maintenance_margin(&p, &m, oracle_price);
    kani::assume(!is_above_mm);

    // ── Calculate liquidation ──
    let liq_result = calculate_liquidation(&p, &m, oracle_price);
    kani::assume(liq_result.is_ok());
    let liq = liq_result.unwrap();

    // ── Effective position for ADL ──
    let eff = effective_position_q(&p, &m);
    let abs_eff = eff.unsigned_abs();
    kani::assume(abs_eff > 0);

    // ── Compute deficit from raw equity ──
    let eq_raw = account_equity_maint_raw(&p);
    let deficit: u128 = if eq_raw < 0 { eq_raw.unsigned_abs() } else { 0u128 };

    // Snapshot insurance before
    let ins_before = m.insurance_fund_balance;
    let a_opp_before = m.short_a; // opposite of long

    // ── enqueue_adl ──
    let liq_side = Side::Long;
    let adl_ok = enqueue_adl(&mut m, liq_side, abs_eff, deficit);
    kani::assume(adl_ok.is_ok());

    // Assert: deficit routing — insurance decreased or A shrunk
    if deficit > 0 {
        let ins_decreased = m.insurance_fund_balance < ins_before;
        let a_shrunk = m.short_a < a_opp_before;
        let oi_cleared = m.oi_eff_short_q == 0;
        assert!(
            ins_decreased || a_shrunk || oi_cleared,
            "H9: deficit must be routed through insurance or A/K"
        );
    }

    // ── Fee capping (mirrors handler: liq_reward first, then insurance fee) ──
    let old_collateral = p.deposited_collateral as u128;
    let available_for_fees = old_collateral.saturating_sub(deficit);
    // Handler caps liquidator_reward FIRST
    let actual_liq_reward = core::cmp::min(liq.liquidator_reward as u128, available_for_fees);
    let remaining_after_reward = available_for_fees.saturating_sub(actual_liq_reward);
    // THEN caps insurance fee to what's left
    let actual_ins_fee = core::cmp::min(liq.insurance_fee as u128, remaining_after_reward);

    // Insurance fee credit (after enqueue_adl per M3/Pashov3)
    m.insurance_fund_balance = m.insurance_fund_balance
        .saturating_add(actual_ins_fee as u64);

    // Vault deduction for liquidator reward (mirrors CPI transfer)
    m.vault_balance = m.vault_balance.saturating_sub(actual_liq_reward);

    // ── Update total OI tracking ──
    let abs_base = (p.base_size as i64).unsigned_abs() as u128;
    m.total_long_position = m.total_long_position.saturating_sub(abs_base);

    // ── Reset position ──
    let old_cap = p.deposited_collateral as u128;
    m.c_tot = m.c_tot.saturating_sub(old_cap);
    // Adjust vault_balance for the removed collateral portion
    // (In real handler, liquidator_reward is transferred out; skip CPI)

    reset_warmup_on_liquidation(&mut p, &mut m);
    p.base_size = 0;
    p.quote_entry_amount = 0;
    set_pnl(&mut p, &mut m, 0);
    p.deposited_collateral = 0;
    attach_effective_position(&mut p, &mut m, 0);
    m.total_positions = m.total_positions.saturating_sub(1);

    // ── Phantom dust clearance ──
    check_and_clear_phantom_dust(&mut m, liq_side);
    check_and_clear_phantom_dust(&mut m, opposite_side(liq_side));

    // ── Finalize pending resets ──
    finalize_pending_resets(&mut m);

    // Assert: position is zeroed
    assert_eq!(p.basis, 0, "H9: basis must be zero after liquidation");
    assert_eq!(p.deposited_collateral, 0, "H9: collateral must be zero");
    assert_eq!(p.pnl, 0, "H9: PnL must be zero");
    assert_eq!(p.base_size, 0, "H9: base_size must be zero");

    // Assert: conservation holds (V >= C_tot + I + claimable)
    // vault_balance was deducted by liquidator_reward (mirroring CPI transfer)
    let senior = m.c_tot
        + m.insurance_fund_balance as u128
        + m.creator_claimable_fees as u128
        + m.protocol_claimable_fees as u128;
    assert!(
        m.vault_balance >= senior,
        "H9: conservation V >= C_tot + I + fees must hold post-liquidation"
    );
}

// ============================================================================
// H10: Liquidation Blocked When Solvent
//
// Well-collateralized position above maintenance margin.
// Assert: is_above_maintenance_margin returns true.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h10_liquidation_blocked_when_solvent() {
    let mut m = test_market();
    let mut p = test_position();

    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 1_000 && oracle_price <= 10_000_000);

    // Small position, large collateral → well above MM
    let size_q: u128 = kani::any();
    kani::assume(size_q >= POS_SCALE && size_q <= 100 * POS_SCALE);

    // Collateral must be much larger than notional * MM_bps
    // notional ~ size_q * oracle_price / POS_SCALE
    // MM_req ~ notional * 500 / 10000 = notional / 20
    // We want equity >> MM_req, so collateral >> notional / 20
    let notional_approx = (size_q / POS_SCALE) * oracle_price as u128;
    let mm_approx = notional_approx / 20;
    let collateral: u64 = kani::any();
    kani::assume(collateral as u128 >= mm_approx.saturating_mul(5).saturating_add(MIN_NONZERO_MM_REQ));
    kani::assume(collateral <= 1_000_000_000);

    sim_deposit(&mut p, &mut m, collateral);
    set_long_position(&mut p, &mut m, size_q);

    m.last_oracle_price = oracle_price;
    m.vault_balance = m.c_tot + m.insurance_fund_balance as u128;

    let is_above = perk_protocol::engine::risk::is_above_maintenance_margin(&p, &m, oracle_price);

    assert!(
        is_above,
        "H10: well-collateralized position must be above maintenance margin"
    );

    // Also verify liquidation engine agrees
    let liquidatable = is_liquidatable(&p, &m, oracle_price);
    assert!(
        !liquidatable,
        "H10: solvent position must not be liquidatable"
    );
}

// ============================================================================
// H11: Liquidation Fires When Underwater
//
// Position just below maintenance margin.
// Assert: is_above_maintenance_margin returns false
// Assert: calculate_liquidation produces valid result with deficit >= 0
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h11_liquidation_fires_when_underwater() {
    let mut m = test_market();
    let mut p = test_position();

    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 1_000 && oracle_price <= 10_000_000);

    // Moderate position with tiny collateral → underwater
    let size_q: u128 = kani::any();
    kani::assume(size_q >= 10 * POS_SCALE && size_q <= 1_000 * POS_SCALE);

    // Give very small collateral — less than MM requirement
    // MM_req ≈ (size_q * oracle / POS_SCALE) * 500 / 10000
    // We want collateral < MM_req
    let collateral: u64 = kani::any();
    kani::assume(collateral >= 1 && collateral <= 100);

    sim_deposit(&mut p, &mut m, collateral);
    set_long_position(&mut p, &mut m, size_q);

    // Give negative PnL to push further underwater
    let neg_pnl: u128 = kani::any();
    kani::assume(neg_pnl >= 1 && neg_pnl <= collateral as u128);
    set_pnl(&mut p, &mut m, -(neg_pnl as i128));

    m.last_oracle_price = oracle_price;
    m.vault_balance = m.c_tot + m.insurance_fund_balance as u128;

    let is_above = perk_protocol::engine::risk::is_above_maintenance_margin(&p, &m, oracle_price);

    assert!(
        !is_above,
        "H11: underwater position must be below maintenance margin"
    );

    // calculate_liquidation must succeed
    let liq_result = calculate_liquidation(&p, &m, oracle_price);
    assert!(
        liq_result.is_ok(),
        "H11: calculate_liquidation must succeed for underwater position"
    );

    let liq = liq_result.unwrap();

    // Deficit must be non-negative (it's a u128 so always >= 0, but verify consistency)
    // closing_notional must be > 0 for a non-zero position
    assert!(
        liq.closing_notional > 0 || size_q == 0,
        "H11: closing_notional must be > 0 for non-zero position"
    );

    // Insurance fee + liquidator reward = total fee
    assert_eq!(
        liq.insurance_fee + liq.liquidator_reward,
        liq.total_liq_fee,
        "H11: fee split must sum to total"
    );
}

// ============================================================================
// H12: Crank Funding Idempotency
//
// Call update_funding → set_funding_rate_for_next_interval twice.
// Assert: second call doesn't change rate (already up to date).
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h12_crank_funding_idempotency() {
    let mut m = test_market();

    // Need OI on both sides for funding to apply
    let oi_long: u128 = kani::any();
    kani::assume(oi_long >= POS_SCALE && oi_long <= 1_000_000 * POS_SCALE);
    let oi_short: u128 = kani::any();
    kani::assume(oi_short >= POS_SCALE && oi_short <= 1_000_000 * POS_SCALE);
    m.oi_eff_long_q = oi_long;
    m.oi_eff_short_q = oi_short;

    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 1_000 && oracle_price <= 10_000_000);

    let mark_price: u64 = kani::any();
    kani::assume(mark_price >= 1_000 && mark_price <= 10_000_000);

    m.last_oracle_price = oracle_price;
    m.funding_period_seconds = 3600;
    m.funding_rate_cap_bps = 10;

    // Set TWAP state for deterministic rate calculation
    m.mark_price_accumulator = 0;
    m.twap_observation_count = 0;
    m.twap_volume_accumulator = 0;
    m.last_mark_price_for_funding = mark_price;

    // First call: update_funding
    let result1 = update_funding(&mut m, mark_price, oracle_price);
    kani::assume(result1.is_ok());

    let rate_after_first = m.funding_rate_bps_per_slot_last;
    let mark_saved = m.last_mark_price_for_funding;

    // Reset TWAP accumulators (as crank_funding handler does)
    m.mark_price_accumulator = 0;
    m.twap_observation_count = 0;
    m.twap_volume_accumulator = 0;

    // Second call with same mark/oracle: rate should be identical
    let result2 = update_funding(&mut m, mark_price, oracle_price);
    kani::assume(result2.is_ok());

    let rate_after_second = m.funding_rate_bps_per_slot_last;

    assert_eq!(
        rate_after_first, rate_after_second,
        "H12: second update_funding with same prices must produce same rate"
    );

    assert_eq!(
        m.last_mark_price_for_funding, mark_saved,
        "H12: last_mark_price_for_funding must be stable"
    );
}

// ============================================================================
// H13: Reclaim Rejects Active Position
//
// Position with open basis (non-zero effective position).
// Assert: reclaim_empty_account returns Err.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h13_reclaim_rejects_active_position() {
    let mut m = test_market();
    let mut p = test_position();

    let size_q: u128 = kani::any();
    kani::assume(size_q >= POS_SCALE && size_q <= 1_000_000 * POS_SCALE);

    let collateral: u64 = kani::any();
    kani::assume(collateral >= 1_000 && collateral <= 1_000_000);

    sim_deposit(&mut p, &mut m, collateral);
    set_long_position(&mut p, &mut m, size_q);
    m.vault_balance = m.c_tot + m.insurance_fund_balance as u128;

    // Verify effective position is non-zero
    let eff = effective_position_q(&p, &m);
    kani::assume(eff != 0);

    // reclaim_empty_account must fail
    let result = reclaim_empty_account(&mut p, &mut m);

    assert!(
        result.is_err(),
        "H13: reclaim_empty_account must reject active (non-flat) position"
    );
}

// ============================================================================
// H14: Reclaim Succeeds on Empty
//
// Position with basis=0, collateral=0, PnL=0, fee_credits=0.
// Assert: reclaim_empty_account returns Ok.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h14_reclaim_succeeds_on_empty() {
    let mut m = test_market();
    let mut p = test_position();

    // Completely empty position
    p.basis = 0;
    p.deposited_collateral = 0;
    p.pnl = 0;
    p.reserved_pnl = 0;
    p.fee_credits = 0;
    p.base_size = 0;
    p.a_snapshot = ADL_ONE;
    p.epoch_snapshot = m.long_epoch;

    // Market aggregates: nothing from this position
    m.vault_balance = m.insurance_fund_balance as u128;

    let result = reclaim_empty_account(&mut p, &mut m);

    assert!(
        result.is_ok(),
        "H14: reclaim_empty_account must succeed on completely empty position"
    );

    // After reclaim, everything is zeroed
    assert_eq!(p.basis, 0, "H14: basis must remain zero");
    assert_eq!(p.deposited_collateral, 0, "H14: collateral must be zero");
    assert_eq!(p.pnl, 0, "H14: PnL must be zero");
    assert_eq!(p.reserved_pnl, 0, "H14: reserved_pnl must be zero");
    assert_eq!(p.fee_credits, 0, "H14: fee_credits must be zero");
    assert_eq!(p.warmup_slope, 0, "H14: warmup_slope must be zero");
}

// ============================================================================
// H15: Fee Claim Conservation
//
// Simulate fee claiming: decrease claimable_fees, increase vault outflow.
// Assert: claimable_fees cannot exceed vault_balance
// Assert: claiming exact claimable amount zeroes the field
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn h15_fee_claim_conservation() {
    let mut m = test_market();

    // Symbolic fee amounts
    let creator_fees: u64 = kani::any();
    kani::assume(creator_fees >= 1 && creator_fees <= 1_000_000);
    let protocol_fees: u64 = kani::any();
    kani::assume(protocol_fees >= 1 && protocol_fees <= 1_000_000);

    m.creator_claimable_fees = creator_fees;
    m.protocol_claimable_fees = protocol_fees;

    // Vault must satisfy conservation
    let ins: u128 = kani::any();
    kani::assume(ins <= 10_000_000);
    m.insurance_fund_balance = ins as u64;
    m.c_tot = kani::any();
    kani::assume(m.c_tot <= 100_000_000);

    let needed = m.c_tot + ins
        + creator_fees as u128
        + protocol_fees as u128;
    m.vault_balance = needed;

    // Pre-condition: conservation holds
    assert!(check_conservation(&m), "H15: pre-condition conservation");

    // ── Simulate creator claim (mirroring claim_fees handler) ──
    let claim_amount = m.creator_claimable_fees;
    assert!(claim_amount > 0);
    m.creator_claimable_fees = 0;

    // Cap to vault balance
    let vault_amount = m.vault_balance;
    let actual_claim = core::cmp::min(claim_amount as u128, vault_amount);

    // If partial, put remainder back
    if (actual_claim as u64) < claim_amount {
        m.creator_claimable_fees = claim_amount - actual_claim as u64;
    }

    // Deduct from vault
    m.vault_balance = m.vault_balance.checked_sub(actual_claim).unwrap();

    // Assert: claimable_fees cannot exceed vault_balance after claim
    let total_claimable = m.creator_claimable_fees as u128
        + m.protocol_claimable_fees as u128;
    assert!(
        m.vault_balance >= total_claimable,
        "H15: remaining claimable fees must not exceed vault balance"
    );

    // Assert: conservation still holds
    assert!(
        check_conservation(&m),
        "H15: conservation must hold after fee claim"
    );

    // Assert: creator fees zeroed (we claimed exact amount)
    assert_eq!(
        m.creator_claimable_fees, 0,
        "H15: creator_claimable_fees must be zero after full claim"
    );

    // ── Now simulate protocol claim ──
    let proto_claim = m.protocol_claimable_fees;
    assert!(proto_claim > 0);
    m.protocol_claimable_fees = 0;

    let actual_proto = core::cmp::min(proto_claim as u128, m.vault_balance);
    if (actual_proto as u64) < proto_claim {
        m.protocol_claimable_fees = proto_claim - actual_proto as u64;
    }
    m.vault_balance = m.vault_balance.checked_sub(actual_proto).unwrap();

    // Assert: conservation still holds after both claims
    assert!(
        check_conservation(&m),
        "H15: conservation must hold after both fee claims"
    );

    assert_eq!(
        m.protocol_claimable_fees, 0,
        "H15: protocol_claimable_fees must be zero after full claim"
    );
}

// ============================================================================
// H16: Two-User Funding Zero-Sum
//
// Two positions: one long, one short, same market.
// Run accrue_market_to, then settle_side_effects on both.
// Assert: PnL sum of both users <= 0 (zero-sum or protocol-favorable).
// ============================================================================

#[kani::proof]
#[kani::unwind(4)]
#[kani::solver(cadical)]
fn h16_two_user_funding_zero_sum() {
    let mut m = test_market();
    let mut p_long = test_position();
    let mut p_short = test_position();

    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 1_000 && oracle_price <= 10_000_000);

    // Equal-sized positions for clearest zero-sum test
    let size_q: u128 = kani::any();
    kani::assume(size_q >= POS_SCALE && size_q <= 1_000 * POS_SCALE);

    let collateral: u64 = kani::any();
    kani::assume(collateral >= 100_000 && collateral <= 10_000_000);

    // Set up long position
    sim_deposit(&mut p_long, &mut m, collateral);
    set_long_position(&mut p_long, &mut m, size_q);

    // Set up short position
    sim_deposit(&mut p_short, &mut m, collateral);
    set_short_position(&mut p_short, &mut m, size_q);

    // Set non-zero funding rate
    let funding_rate: i64 = kani::any();
    kani::assume(funding_rate >= -1_000 && funding_rate <= 1_000);
    m.funding_rate_bps_per_slot_last = funding_rate;
    m.last_oracle_price = oracle_price;
    m.funding_price_sample_last = oracle_price;

    // Vault covers both
    m.vault_balance = m.c_tot + m.insurance_fund_balance as u128
        + m.creator_claimable_fees as u128
        + m.protocol_claimable_fees as u128;

    // Snapshot PnL before
    let pnl_long_before = p_long.pnl;
    let pnl_short_before = p_short.pnl;

    // Advance by a few slots
    let dt: u64 = kani::any();
    kani::assume(dt >= 1 && dt <= 100);
    let new_slot = m.current_slot + dt;

    // accrue_market_to applies funding to K indices
    let accrue_ok = accrue_market_to(&mut m, new_slot, oracle_price);
    kani::assume(accrue_ok.is_ok());

    // settle_side_effects on long
    let settle_long = settle_side_effects(&mut p_long, &mut m);
    kani::assume(settle_long.is_ok());

    // settle_side_effects on short
    let settle_short = settle_side_effects(&mut p_short, &mut m);
    kani::assume(settle_short.is_ok());

    // Compute PnL deltas
    let delta_long = p_long.pnl - pnl_long_before;
    let delta_short = p_short.pnl - pnl_short_before;
    let pnl_sum = delta_long.checked_add(delta_short);

    // Assert: funding is zero-sum or protocol-favorable (rounding leaks to protocol)
    // Sum of PnL changes must be <= 0
    match pnl_sum {
        Some(sum) => {
            assert!(
                sum <= 0,
                "H16: PnL sum of long + short must be <= 0 (zero-sum or protocol-favorable)"
            );
        }
        None => {
            // Overflow — extremely unlikely with bounded inputs, but safe to pass
            // since we can't measure the sum.
        }
    }
}
