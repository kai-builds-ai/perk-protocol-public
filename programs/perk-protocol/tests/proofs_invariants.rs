// =============================================================================
// Kani Formal Proofs — Category 3: Invariants (state machine properties)
// Properties P3.1 through P3.10
// =============================================================================

mod common;
use common::*;

// =============================================================================
// P3.1: set_pnl maintains pnl_pos_tot aggregate
// After set_pnl(new_pnl), delta(pnl_pos_tot) == max(new_pnl,0) - max(old_pnl,0)
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_1_set_pnl_maintains_pnl_pos_tot() {
    let old_pnl: i128 = kani::any::<i8>() as i128;
    let new_pnl: i128 = kani::any::<i8>() as i128;
    kani::assume(new_pnl != i128::MIN);

    let old_pos = if old_pnl > 0 { old_pnl as u128 } else { 0u128 };
    let new_pos = if new_pnl > 0 { new_pnl as u128 } else { 0u128 };
    // Ensure new_pos fits MAX_ACCOUNT_POSITIVE_PNL
    kani::assume(new_pos <= MAX_ACCOUNT_POSITIVE_PNL);

    let mut market = test_market();
    let mut pos = test_position();

    // MEDIUM 7 fix: Use reserved_pnl < old_pos so matured portion is non-zero.
    // This avoids the degenerate reserved == old_pos case where pnl_matured_pos_tot
    // never changes.
    let reserved_frac: u128 = kani::any::<u8>() as u128;
    let old_reserved = if old_pos > 0 {
        // Ensure reserved < old_pos when old_pos > 0 for non-degenerate matured portion
        let r = reserved_frac % old_pos; // r in [0, old_pos)
        r
    } else {
        0u128
    };
    let old_matured = old_pos - old_reserved; // guaranteed >= 0, and > 0 when old_pos > 0

    market.pnl_pos_tot = old_pos;
    market.pnl_matured_pos_tot = old_matured;
    pos.pnl = old_pnl;
    pos.reserved_pnl = old_reserved;

    let ppt_before = market.pnl_pos_tot;
    let matured_before = market.pnl_matured_pos_tot;

    set_pnl(&mut pos, &mut market, new_pnl);

    let ppt_after = market.pnl_pos_tot;
    let matured_after = market.pnl_matured_pos_tot;

    // Delta must equal new_pos - old_pos (signed)
    if new_pos >= old_pos {
        assert!(ppt_after == ppt_before + (new_pos - old_pos),
            "pnl_pos_tot increase mismatch");
    } else {
        assert!(ppt_after == ppt_before - (old_pos - new_pos),
            "pnl_pos_tot decrease mismatch");
    }

    // MEDIUM 1 fix: Verify pnl_matured_pos_tot delta is consistent.
    // matured = pos - reserved. set_pnl updates reserved via spec §4.4 steps 7-8.
    let new_reserved = pos.reserved_pnl;
    let new_rel = new_pos - new_reserved;
    let old_rel = old_pos - old_reserved;
    if new_rel >= old_rel {
        assert!(matured_after == matured_before + (new_rel - old_rel),
            "pnl_matured_pos_tot increase mismatch");
    } else {
        assert!(matured_after == matured_before - (old_rel - new_rel),
            "pnl_matured_pos_tot decrease mismatch");
    }

    // Aggregate invariant: matured <= pos_tot
    assert!(matured_after <= ppt_after,
        "pnl_matured_pos_tot must be <= pnl_pos_tot");

    // Post-condition: position.pnl updated
    assert!(pos.pnl == new_pnl);
}

// =============================================================================
// P3.2: set_capital maintains c_tot aggregate
// After set_capital(new_cap), delta(c_tot) == new_cap - old_cap
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_2_set_capital_maintains_c_tot() {
    let old_cap: u64 = kani::any::<u8>() as u64 * 1000; // scale up to realistic
    let new_cap_raw: u8 = kani::any();
    let new_cap: u128 = new_cap_raw as u128 * 1000;

    let mut market = test_market();
    let mut pos = test_position();

    // Initialize
    pos.deposited_collateral = old_cap;
    market.c_tot = old_cap as u128;

    let c_tot_before = market.c_tot;

    let result = set_capital(&mut pos, &mut market, new_cap);
    assert!(result.is_ok(), "set_capital should succeed for u64-range values");

    let c_tot_after = market.c_tot;

    // Conservation: c_tot changes by exactly (new_cap - old_cap)
    if new_cap >= old_cap as u128 {
        assert!(c_tot_after == c_tot_before + (new_cap - old_cap as u128),
            "c_tot increase mismatch");
    } else {
        assert!(c_tot_after == c_tot_before - (old_cap as u128 - new_cap),
            "c_tot decrease mismatch");
    }

    assert!(pos.deposited_collateral as u128 == new_cap);
}

// =============================================================================
// P3.3: set_position_basis_q maintains OI/count tracking
// Sign transitions correctly increment/decrement stored_pos_count_{long,short}
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_3_set_position_basis_q_count_tracking() {
    let old_basis: i128 = kani::any::<i8>() as i128;
    let new_basis: i128 = kani::any::<i8>() as i128;

    let mut market = test_market();
    let mut pos = test_position();

    // Initialize counts to safe starting values
    market.stored_pos_count_long = 10;
    market.stored_pos_count_short = 10;
    pos.basis = old_basis;

    let long_before = market.stored_pos_count_long;
    let short_before = market.stored_pos_count_short;

    set_position_basis_q(&mut pos, &mut market, new_basis);

    let long_after = market.stored_pos_count_long;
    let short_after = market.stored_pos_count_short;

    // Compute expected deltas
    let old_long_dec: u64 = if old_basis > 0 { 1 } else { 0 };
    let old_short_dec: u64 = if old_basis < 0 { 1 } else { 0 };
    let new_long_inc: u64 = if new_basis > 0 { 1 } else { 0 };
    let new_short_inc: u64 = if new_basis < 0 { 1 } else { 0 };

    assert!(long_after == long_before - old_long_dec + new_long_inc,
        "long count tracking error");
    assert!(short_after == short_before - old_short_dec + new_short_inc,
        "short count tracking error");

    assert!(pos.basis == new_basis, "basis not updated");
}

// =============================================================================
// P3.4: check_conservation holds after deposit
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_4_conservation_after_deposit() {
    let initial_balance: u128 = kani::any::<u8>() as u128 * POS_SCALE;
    let deposit_amount: u64 = kani::any::<u8>() as u64 + 1; // at least 1

    let mut market = test_market();
    let mut pos = test_position();

    // Start with conservation holding
    market.vault_balance = initial_balance;
    market.c_tot = initial_balance;
    market.insurance_fund_balance = 0;
    market.creator_claimable_fees = 0;
    market.protocol_claimable_fees = 0;
    market.pnl_pos_tot = 0;
    market.pnl_matured_pos_tot = 0;

    assert!(check_conservation(&market), "conservation must hold initially");

    // Perform deposit: increase vault_balance and capital atomically
    sim_deposit(&mut pos, &mut market, deposit_amount);

    assert!(check_conservation(&market),
        "conservation must hold after deposit");

    // Vault increased by exactly deposit_amount
    assert!(market.vault_balance == initial_balance + deposit_amount as u128);
}

// =============================================================================
// P3.5: check_conservation holds after loss settlement
// settle_losses moves capital to cover negative PnL without breaking V >= C+I
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_5_conservation_after_loss_settlement() {
    let collateral: u8 = kani::any();
    kani::assume(collateral > 0);
    let loss_mag: u8 = kani::any();
    kani::assume(loss_mag > 0);

    let collateral_u128 = collateral as u128 * 1000;
    let loss = -(loss_mag as i128 * 1000);

    let mut market = test_market();
    let mut pos = test_position();

    // Setup: position has collateral and negative PnL
    pos.deposited_collateral = collateral_u128 as u64;
    pos.pnl = loss;
    pos.reserved_pnl = 0;

    market.c_tot = collateral_u128;
    market.vault_balance = collateral_u128;
    market.insurance_fund_balance = 0;
    market.creator_claimable_fees = 0;
    market.protocol_claimable_fees = 0;
    market.pnl_pos_tot = 0;
    market.pnl_matured_pos_tot = 0;

    assert!(check_conservation(&market), "conservation pre-settlement");

    // Settle losses: capital pays for negative PnL
    settle_losses(&mut pos, &mut market);

    // Conservation still holds (capital decreased, but vault unchanged)
    assert!(check_conservation(&market),
        "conservation must hold after loss settlement");

    // PnL moved toward zero (or stayed same if capital insufficient)
    assert!(pos.pnl >= loss, "PnL must not get worse");
    // Capital decreased or stayed same
    assert!(pos.deposited_collateral as u128 <= collateral_u128, "capital must not increase");
}

// =============================================================================
// P3.6: Effective position returns 0 for flat (basis == 0)
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_6_effective_position_zero_for_flat() {
    let price: u64 = kani::any::<u16>() as u64 + 1;
    let a_val: u128 = kani::any::<u8>() as u128 + 1;

    let mut market = test_market();
    market.long_a = a_val * ADL_ONE;
    market.short_a = a_val * ADL_ONE;

    let mut pos = test_position();
    pos.basis = 0; // flat

    let eff = effective_position_q(&pos, &market);
    assert!(eff == 0, "flat position must have zero effective position");
}

// =============================================================================
// P3.7: Effective position returns 0 for epoch mismatch
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_7_effective_position_zero_for_epoch_mismatch() {
    let size: u128 = kani::any::<u8>() as u128 + 1;
    let is_long: bool = kani::any();

    let mut market = test_market();
    market.long_epoch = 5;
    market.short_epoch = 5;

    let mut pos = test_position();
    if is_long {
        pos.basis = size as i128;
        pos.a_snapshot = market.long_a;
    } else {
        pos.basis = -(size as i128);
        pos.a_snapshot = market.short_a;
    }
    // Epoch mismatch: position at epoch 3, market at epoch 5
    pos.epoch_snapshot = 3;

    let eff = effective_position_q(&pos, &market);
    assert!(eff == 0, "epoch mismatch must yield zero effective position");
}

// =============================================================================
// P3.8: attach_effective_position updates side counts correctly
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_8_attach_updates_side_counts() {
    let new_eff: i128 = kani::any::<i8>() as i128;

    let mut market = test_market();
    let mut pos = test_position();

    // Start flat
    pos.basis = 0;
    market.stored_pos_count_long = 5;
    market.stored_pos_count_short = 5;

    let long_before = market.stored_pos_count_long;
    let short_before = market.stored_pos_count_short;

    attach_effective_position(&mut pos, &mut market, new_eff);

    if new_eff > 0 {
        // Went from flat to long
        assert!(market.stored_pos_count_long == long_before + 1,
            "long count must increment");
        assert!(market.stored_pos_count_short == short_before,
            "short count must not change");
        // Snapshots match long side
        assert!(pos.a_snapshot == market.long_a);
        assert!(pos.k_snapshot == market.long_k_index);
        assert!(pos.epoch_snapshot == market.long_epoch);
    } else if new_eff < 0 {
        // Went from flat to short
        assert!(market.stored_pos_count_short == short_before + 1,
            "short count must increment");
        assert!(market.stored_pos_count_long == long_before,
            "long count must not change");
        assert!(pos.a_snapshot == market.short_a);
        assert!(pos.k_snapshot == market.short_k_index);
        assert!(pos.epoch_snapshot == market.short_epoch);
    } else {
        // Stayed flat
        assert!(market.stored_pos_count_long == long_before);
        assert!(market.stored_pos_count_short == short_before);
    }

    assert!(pos.basis == new_eff, "basis must equal new effective position");
}

// =============================================================================
// P3.8b: attach_effective_position updates side counts correctly (close path)
// Starts with a non-zero basis and transitions to flat.
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_8b_attach_updates_side_counts_close() {
    let old_basis: i128 = kani::any::<i8>() as i128;
    kani::assume(old_basis != 0); // start with a position

    let mut market = test_market();
    let mut pos = test_position();

    // Set up with existing position
    market.stored_pos_count_long = 5;
    market.stored_pos_count_short = 5;
    pos.basis = old_basis;
    if old_basis > 0 {
        pos.a_snapshot = market.long_a;
        pos.k_snapshot = market.long_k_index;
        pos.epoch_snapshot = market.long_epoch;
    } else {
        pos.a_snapshot = market.short_a;
        pos.k_snapshot = market.short_k_index;
        pos.epoch_snapshot = market.short_epoch;
    }

    let long_before = market.stored_pos_count_long;
    let short_before = market.stored_pos_count_short;

    // Transition to flat (new_eff = 0)
    attach_effective_position(&mut pos, &mut market, 0);

    if old_basis > 0 {
        // Was long → long count decremented
        assert!(market.stored_pos_count_long == long_before - 1,
            "P3.8b: long count must decrement when closing long");
        assert!(market.stored_pos_count_short == short_before,
            "P3.8b: short count must not change when closing long");
    } else {
        // Was short → short count decremented
        assert!(market.stored_pos_count_short == short_before - 1,
            "P3.8b: short count must decrement when closing short");
        assert!(market.stored_pos_count_long == long_before,
            "P3.8b: long count must not change when closing short");
    }

    assert!(pos.basis == 0, "P3.8b: basis must be zero after closing");
}

// =============================================================================
// P3.9: Warmup release bounded by reserved_pnl
// advance_warmup never releases more than the current reserved_pnl
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_9_warmup_release_bounded_by_reserved() {
    let reserved: u128 = kani::any::<u8>() as u128 * POS_SCALE;
    let slope: u128 = kani::any::<u8>() as u128 * 100;
    let elapsed: u64 = kani::any::<u8>() as u64;
    let warmup_period: u64 = kani::any::<u8>() as u64 + 1;

    // Need pnl >= reserved for set_reserved_pnl invariant
    let pnl_value = reserved as i128 + 1; // strictly positive, > reserved
    kani::assume(pnl_value > 0);
    kani::assume(reserved as u128 <= MAX_ACCOUNT_POSITIVE_PNL);
    kani::assume((pnl_value as u128) <= MAX_ACCOUNT_POSITIVE_PNL);

    let mut market = test_market();
    let mut pos = test_position();

    // Setup: position has positive PnL with reserved portion
    market.warmup_period_slots = warmup_period;
    market.current_slot = 1000 + elapsed as u64;
    market.pnl_pos_tot = pnl_value as u128;
    // pnl_matured_pos_tot = pnl_pos - reserved
    market.pnl_matured_pos_tot = (pnl_value as u128).saturating_sub(reserved);

    pos.pnl = pnl_value;
    pos.reserved_pnl = reserved;
    pos.warmup_slope = slope;
    pos.warmup_started_at_slot = 1000;

    let reserved_before = pos.reserved_pnl;

    advance_warmup(&mut pos, &mut market, warmup_period, market.current_slot);

    // Release must not exceed what was reserved
    assert!(pos.reserved_pnl <= reserved_before,
        "reserved must not increase from warmup");

    let released = reserved_before - pos.reserved_pnl;
    assert!(released <= reserved_before,
        "cannot release more than was reserved");
}

// =============================================================================
// P3.10: Warmup release bounded by slope * elapsed
// The released amount is min(reserved, slope * elapsed)
// =============================================================================
#[kani::proof]
#[kani::unwind(2)]
#[kani::solver(cadical)]
fn p3_10_warmup_release_bounded_by_slope_elapsed() {
    let reserved: u128 = kani::any::<u8>() as u128 * POS_SCALE + POS_SCALE; // at least POS_SCALE
    let slope: u128 = kani::any::<u8>() as u128 + 1; // nonzero slope
    let elapsed: u64 = kani::any::<u8>() as u64;
    let warmup_period: u64 = 100; // fixed nonzero

    let pnl_value = reserved as i128 + 1;
    kani::assume((pnl_value as u128) <= MAX_ACCOUNT_POSITIVE_PNL);

    let mut market = test_market();
    let mut pos = test_position();

    market.warmup_period_slots = warmup_period;
    market.current_slot = 1000 + elapsed as u64;
    market.pnl_pos_tot = pnl_value as u128;
    market.pnl_matured_pos_tot = (pnl_value as u128).saturating_sub(reserved);

    pos.pnl = pnl_value;
    pos.reserved_pnl = reserved;
    pos.warmup_slope = slope;
    pos.warmup_started_at_slot = 1000;

    let cap = saturating_mul_u128_u64(slope, elapsed);
    let expected_release = core::cmp::min(reserved, cap);

    advance_warmup(&mut pos, &mut market, warmup_period, market.current_slot);

    let actual_release = reserved - pos.reserved_pnl;

    assert!(actual_release == expected_release,
        "release must equal min(reserved, slope * elapsed)");
}
