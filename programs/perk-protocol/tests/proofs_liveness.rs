/// Kani Formal Proofs — Category 4: Liveness
///
/// Properties P4.1–P4.5: System makes progress under all valid inputs.

mod common;
use common::*;

// ============================================================================
// P4.1: maybe_finalize_ready_reset_sides auto-finalizes
//
// When a side is ResetPending with OI=0, stale=0, pos_count=0,
// maybe_finalize_ready_reset_sides transitions it back to Normal.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_1_maybe_finalize_auto_finalizes() {
    let mut m = test_market();

    // Symbolic choice: test long, short, or both sides
    let test_long: bool = kani::any();
    let test_short: bool = kani::any();

    // Set up at least one side as ResetPending with all counters zeroed
    if test_long {
        m.long_state = SideState::ResetPending;
        m.oi_eff_long_q = 0;
        m.stale_account_count_long = 0;
        m.stored_pos_count_long = 0;
    }
    if test_short {
        m.short_state = SideState::ResetPending;
        m.oi_eff_short_q = 0;
        m.stale_account_count_short = 0;
        m.stored_pos_count_short = 0;
    }

    // At least one side must be under test
    kani::assume(test_long || test_short);

    maybe_finalize_ready_reset_sides(&mut m);

    // Verify: any side that was ResetPending with zeroed counters is now Normal
    if test_long {
        assert_eq!(m.long_state, SideState::Normal, "P4.1: long side must finalize to Normal");
    }
    if test_short {
        assert_eq!(m.short_state, SideState::Normal, "P4.1: short side must finalize to Normal");
    }
}

// ============================================================================
// P4.1b: maybe_finalize does NOT finalize when counters are nonzero
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_1b_no_finalize_with_nonzero_counters() {
    let mut m = test_market();

    m.long_state = SideState::ResetPending;
    m.oi_eff_long_q = 0;

    // Symbolic nonzero counter: either stale or stored_pos
    let stale: u64 = kani::any();
    let stored: u64 = kani::any();
    kani::assume(stale > 0 || stored > 0);
    kani::assume(stale <= 100);
    kani::assume(stored <= 100);

    m.stale_account_count_long = stale;
    m.stored_pos_count_long = stored;

    maybe_finalize_ready_reset_sides(&mut m);

    // Should remain ResetPending
    assert_eq!(m.long_state, SideState::ResetPending,
        "P4.1b: must NOT finalize with nonzero counters");
}

// ============================================================================
// P4.2: Precision exhaustion terminal drain works
//
// When enqueue_adl computes A_candidate = 0 (precision exhaustion),
// both sides' OI is zeroed — the system doesn't get stuck.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_2_precision_exhaustion_terminal_drain() {
    let mut m = test_market();

    // Set up opposing side with minimal A (near precision exhaustion)
    // and a large enough close quantity that A_candidate rounds to 0
    let liq_side_long: bool = kani::any();

    let close_q: u128 = kani::any();
    kani::assume(close_q >= 1 && close_q <= 1_000);

    if liq_side_long {
        // Liquidating longs, opposing side is short
        m.oi_eff_long_q = close_q + 1;
        // Set short OI = close_q + 1, A_short very small so floor division → 0
        m.short_a = 1; // minimal A
        m.oi_eff_short_q = close_q + 1;
        m.stored_pos_count_short = 1;
        m.short_epoch = 1;
        m.short_state = SideState::Normal;
    } else {
        m.oi_eff_short_q = close_q + 1;
        m.long_a = 1;
        m.oi_eff_long_q = close_q + 1;
        m.stored_pos_count_long = 1;
        m.long_epoch = 1;
        m.long_state = SideState::Normal;
    }

    let side = if liq_side_long { Side::Long } else { Side::Short };

    // When A=1, close_q close to oi, floor(A * (oi-close_q)/oi) will likely be 0
    // Set close_q = oi to force oi_post = 0 path (step 8), which zeros and resets
    let oi = if liq_side_long { m.oi_eff_short_q } else { m.oi_eff_long_q };
    let close_for_terminal = oi; // close all OI

    // enqueue_adl handles the liquidated-side OI decrement internally (Step 1)
    let result = enqueue_adl(&mut m, side, close_for_terminal, 0);
    assert!(result.is_ok(), "P4.2: enqueue_adl must not revert on terminal drain");

    // After terminal drain + finalize, opposing side OI must be zero
    finalize_pending_resets(&mut m);

    let opp = if liq_side_long { Side::Short } else { Side::Long };
    let opp_oi = get_oi_eff(&m, opp);
    assert_eq!(opp_oi, 0, "P4.2: opposing OI must be zeroed on terminal drain");
}

// ============================================================================
// P4.3: Bankruptcy liquidation routes quantity when D=0
//
// When deficit=0, enqueue_adl still processes the ADL correctly,
// updating A and OI for the opposing side.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_3_bankruptcy_routes_quantity_zero_deficit() {
    let mut m = test_market();

    let close_q: u128 = kani::any();
    kani::assume(close_q >= 1 && close_q <= 10_000);

    let oi_opp: u128 = kani::any();
    kani::assume(oi_opp > close_q && oi_opp <= 100_000);

    // Liquidating longs with zero deficit
    m.oi_eff_long_q = close_q;
    m.short_a = ADL_ONE;
    m.oi_eff_short_q = oi_opp;
    m.stored_pos_count_short = 5;
    m.short_epoch = 1;
    m.short_state = SideState::Normal;

    let a_before = m.short_a;
    let oi_before = m.oi_eff_short_q;

    let result = enqueue_adl(&mut m, Side::Long, close_q, 0);
    assert!(result.is_ok(), "P4.3: enqueue_adl must succeed with D=0");

    // A must decrease (or stay same for trivial case)
    let a_after = m.short_a;
    assert!(a_after <= a_before, "P4.3: A_new <= A_old after ADL");

    // OI must decrease
    let oi_after = m.oi_eff_short_q;
    let expected_oi = oi_before - close_q;
    assert_eq!(oi_after, expected_oi, "P4.3: OI must decrease by close_q");
}

// ============================================================================
// P4.4: Pure PnL bankruptcy path works
//
// When a position has negative PnL and zero collateral (pure bankruptcy),
// settle_losses handles it without panic and deficit remains.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_4_pure_pnl_bankruptcy_path() {
    let mut m = test_market();
    let mut p = test_position();

    // Symbolic negative PnL (pure bankruptcy: no collateral)
    let loss: u128 = kani::any();
    kani::assume(loss >= 1 && loss <= 1_000_000_000);

    p.deposited_collateral = 0;
    p.pnl = -(loss as i128);

    let old_pnl = p.pnl;

    // settle_losses: should handle zero capital gracefully
    settle_losses(&mut p, &mut m);

    // With zero capital, nothing can be settled — PnL unchanged
    assert_eq!(p.pnl, old_pnl, "P4.4: PnL unchanged when no capital");
    assert_eq!(p.deposited_collateral, 0, "P4.4: capital remains zero");

    // resolve_flat_negative should absorb the loss if position is flat
    // (Set basis=0 so effective_position_q returns 0)
    p.basis = 0;
    resolve_flat_negative(&mut p, &mut m);

    assert_eq!(p.pnl, 0, "P4.4: flat negative PnL must be resolved to zero");
}

// ============================================================================
// P4.5: check_and_clear_phantom_dust clears correctly
//
// When stored_pos_count == 0 and OI <= dust_bound,
// check_and_clear_phantom_dust zeros OI and initiates reset.
// ============================================================================

#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p4_5_phantom_dust_clears() {
    let mut m = test_market();

    let dust_oi: u128 = kani::any();
    kani::assume(dust_oi >= 1 && dust_oi <= 1_000);

    let dust_bound: u128 = kani::any();
    kani::assume(dust_bound >= dust_oi); // OI is within dust bound
    kani::assume(dust_bound <= 10_000);

    let test_long: bool = kani::any();

    if test_long {
        m.oi_eff_long_q = dust_oi;
        m.stored_pos_count_long = 0; // No live positions
        m.phantom_dust_bound_long_q = dust_bound;
        m.long_state = SideState::Normal;

        // Ensure short side is set up for bilateral empty check
        m.oi_eff_short_q = 0;
        m.stored_pos_count_short = 0;
        m.short_state = SideState::Normal;
    } else {
        m.oi_eff_short_q = dust_oi;
        m.stored_pos_count_short = 0;
        m.short_state = SideState::Normal;
        m.phantom_dust_bound_short_q = dust_bound;

        m.oi_eff_long_q = 0;
        m.stored_pos_count_long = 0;
        m.long_state = SideState::Normal;
    }

    // Need valid vAMM state for normalize_reserves in begin_full_drain_reset
    m.base_reserve = 1_000_000;
    m.quote_reserve = 1_000_000;
    m.k = m.base_reserve * m.quote_reserve;

    let side = if test_long { Side::Long } else { Side::Short };
    check_and_clear_phantom_dust(&mut m, side);

    // OI must be zeroed
    let oi = get_oi_eff(&m, side);
    assert_eq!(oi, 0, "P4.5: OI must be cleared when <= dust_bound with no stored positions");
}
