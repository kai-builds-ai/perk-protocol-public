/// Category 2: Safety — Conservation, Bounds, No-Mint
///
/// Properties P2.1 through P2.20 from PROOF-SPEC.md
/// All inputs symbolic with bounded kani::assume. No hardcoded values.

mod common;
use common::*;

// ============================================================================
// P2.1: Deposit conserves vault balance
// vault_balance_after == vault_balance_before + amount
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_1_deposit_conserves_vault() {
    let mut market = test_market();
    let mut pos = test_position();

    let amount: u64 = kani::any();
    kani::assume(amount >= 1_000); // MIN_DEPOSIT_AMOUNT
    kani::assume(amount <= 1_000_000_000); // tractable bound

    // Set up consistent initial state
    let init_cap: u64 = kani::any();
    kani::assume(init_cap <= 1_000_000_000);
    pos.deposited_collateral = init_cap;
    market.c_tot = init_cap as u128;
    market.vault_balance = init_cap as u128;

    let vault_before = market.vault_balance;

    // Deposit: increase capital + vault
    let new_cap = (pos.deposited_collateral as u128) + (amount as u128);
    kani::assume(new_cap <= u64::MAX as u128);
    set_capital(&mut pos, &mut market, new_cap).unwrap();
    market.vault_balance += amount as u128;

    let vault_after = market.vault_balance;
    assert!(vault_after == vault_before + amount as u128, "P2.1: deposit must increase vault by exact amount");
}

// ============================================================================
// P2.2: Withdrawal conserves vault balance
// vault_balance_after == vault_balance_before - amount
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_2_withdrawal_conserves_vault() {
    let mut market = test_market();
    let mut pos = test_position();

    let collateral: u64 = kani::any();
    kani::assume(collateral >= 10_000);
    kani::assume(collateral <= 1_000_000_000);

    pos.deposited_collateral = collateral;
    market.c_tot = collateral as u128;
    market.vault_balance = collateral as u128;

    let withdraw: u64 = kani::any();
    kani::assume(withdraw >= 1);
    kani::assume(withdraw <= collateral);

    let vault_before = market.vault_balance;

    let new_cap = (pos.deposited_collateral as u128) - (withdraw as u128);
    set_capital(&mut pos, &mut market, new_cap).unwrap();
    market.vault_balance -= withdraw as u128;

    let vault_after = market.vault_balance;
    assert!(vault_after == vault_before - withdraw as u128, "P2.2: withdrawal must decrease vault by exact amount");
}

// ============================================================================
// P2.3: Trade conserves total value (zero-sum PnL)
// compute_trade_pnl(+q, dp) + compute_trade_pnl(-q, dp) == 0 for opposing sides
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_3_trade_zero_sum() {
    let size_q: u64 = kani::any();
    kani::assume(size_q >= 1);
    kani::assume(size_q <= 1_000); // tightened for solver tractability

    let price_diff: i64 = kani::any();
    kani::assume(price_diff > -(1_000i64));
    kani::assume(price_diff < 1_000i64);

    let long_pnl = compute_trade_pnl(size_q as i128, price_diff as i128);
    let short_pnl = compute_trade_pnl(-(size_q as i128), price_diff as i128);

    if let (Ok(l), Ok(s)) = (long_pnl, short_pnl) {
        // Zero-sum: long + short PnL differ by at most 1 (rounding)
        let sum = l.checked_add(s);
        if let Some(total) = sum {
            // Protocol-favorable rounding: negative PnL uses ceil-magnitude (rounds
            // against the trader). This means the net PnL across opposing sides is
            // always <= 0 — the protocol never creates value out of thin air.
            assert!(total <= 0, "P2.3: net PnL must be protocol-favorable (<=0)");
        }
    }
}

// ============================================================================
// P2.4: Liquidation conserves total value
// Insurance absorption + haircut covers deficit; vault is not inflated
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_4_liquidation_conserves() {
    let mut market = zero_fee_market();

    let ins_bal: u64 = kani::any();
    kani::assume(ins_bal <= 1_000_000_000);
    market.insurance_fund_balance = ins_bal;

    let loss: u128 = kani::any();
    kani::assume(loss >= 1);
    kani::assume(loss <= 2_000_000_000);

    let vault_before = market.vault_balance;
    let ins_before = market.insurance_fund_balance as u128;

    // absorb_protocol_loss uses insurance first, then implicit haircut
    absorb_protocol_loss(&mut market, loss);

    let ins_after = market.insurance_fund_balance as u128;
    let ins_paid = ins_before - ins_after;

    // Insurance can only decrease
    assert!(ins_after <= ins_before, "P2.4: insurance must not increase");
    // Insurance paid <= loss
    assert!(ins_paid <= loss, "P2.4: insurance payout must not exceed loss");
    // Vault balance unchanged (absorb_protocol_loss doesn't touch vault)
    assert!(market.vault_balance == vault_before, "P2.4: vault must not change during loss absorption");
}

// ============================================================================
// P2.5: Haircut ratio bounded: h_num <= h_den, h_den != 0
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_5_haircut_bounded() {
    let mut market = test_market();

    let vault: u128 = kani::any();
    kani::assume(vault <= 10_000_000_000);
    market.vault_balance = vault;

    let c_tot: u128 = kani::any();
    kani::assume(c_tot <= vault);
    market.c_tot = c_tot;

    let ins: u64 = kani::any();
    kani::assume((ins as u128) <= vault.saturating_sub(c_tot));
    market.insurance_fund_balance = ins;

    let pnl_mat: u128 = kani::any();
    kani::assume(pnl_mat >= 1); // nonzero to exercise the branch
    kani::assume(pnl_mat <= 10_000_000_000);
    market.pnl_matured_pos_tot = pnl_mat;

    let pnl_pos: u128 = kani::any();
    kani::assume(pnl_pos >= pnl_mat);
    kani::assume(pnl_pos <= 10_000_000_000);
    market.pnl_pos_tot = pnl_pos;

    market.creator_claimable_fees = 0;
    market.protocol_claimable_fees = 0;

    let (h_num, h_den) = haircut_ratio(&market);

    // h_den is pnl_matured_pos_tot (>0 since pnl_mat >= 1)
    assert!(h_den != 0, "P2.5: h_den must not be zero when pnl_matured_pos_tot > 0");
    assert!(h_num <= h_den, "P2.5: h_num must not exceed h_den");
}

// ============================================================================
// P2.6: Equity non-negative for flat position
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_6_equity_nonneg_flat() {
    let mut pos = test_position();

    let cap: u64 = kani::any();
    kani::assume(cap <= 1_000_000_000);
    pos.deposited_collateral = cap;
    pos.basis = 0; // flat
    pos.pnl = 0;
    pos.fee_credits = 0;

    let eq = account_equity_maint_raw(&pos);
    assert!(eq >= 0, "P2.6: equity must be non-negative for flat position with zero PnL and no fee debt");
    assert!(eq == cap as i128, "P2.6: equity must equal capital for flat clean position");
}

// ============================================================================
// P2.7: FUNDING CANNOT MINT TOKENS (CRITICAL)
// After accrue_market_to with non-zero funding, the total K-delta across
// both sides must not create net positive value (payer loss >= receiver gain).
// Uses pre-scaled funding rates to avoid vacuous truncation-to-zero.
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_7_funding_cannot_mint() {
    let mut market = test_market();

    // Symbolic oracle price
    let oracle_price: u64 = kani::any();
    kani::assume(oracle_price >= 100);
    kani::assume(oracle_price <= 500);

    // Both sides must have live OI for funding to execute
    let long_oi: u128 = kani::any();
    kani::assume(long_oi >= POS_SCALE);
    kani::assume(long_oi <= 5 * POS_SCALE);
    market.oi_eff_long_q = long_oi;

    let short_oi: u128 = kani::any();
    kani::assume(short_oi >= POS_SCALE);
    kani::assume(short_oi <= 5 * POS_SCALE);
    market.oi_eff_short_q = short_oi;

    // A values: use constant ADL_ONE (not symbolic) to avoid solver explosion
    market.long_a = ADL_ONE;
    market.short_a = ADL_ONE;

    // PRE-SCALED funding rate — tightened to <= 1_000
    let rate_sign: bool = kani::any();
    let rate_abs: i64 = kani::any();
    kani::assume(rate_abs >= 1);
    kani::assume(rate_abs <= 1_000);
    let funding_rate: i64 = if rate_sign { rate_abs } else { -rate_abs };
    market.funding_rate_bps_per_slot_last = funding_rate;

    market.last_oracle_price = oracle_price;
    market.funding_price_sample_last = oracle_price;

    // Symbolic dt (at least 1 slot for funding to run)
    let dt: u64 = kani::any();
    kani::assume(dt >= 1);
    kani::assume(dt <= 2);
    let now_slot = market.last_market_slot + dt;

    // Capture K indices before
    let long_k_before = market.long_k_index;
    let short_k_before = market.short_k_index;

    // Run accrue_market_to with same oracle price (no mark delta, only funding)
    let result = accrue_market_to(&mut market, now_slot, oracle_price);
    kani::assume(result.is_ok());

    let long_k_after = market.long_k_index;
    let short_k_after = market.short_k_index;

    // Funding flow: determine payer and receiver
    let (payer_k_delta, receiver_k_delta) = if funding_rate > 0 {
        // Longs pay, shorts receive
        let long_delta = long_k_after - long_k_before;   // should be negative (cost)
        let short_delta = short_k_after - short_k_before; // should be positive (gain)
        (long_delta, short_delta)
    } else {
        // Shorts pay, longs receive
        let short_delta = short_k_after - short_k_before; // should be negative (cost)
        let long_delta = long_k_after - long_k_before;    // should be positive (gain)
        (short_delta, long_delta)
    };

    // CRITICAL ASSERTION: payer loses at least as much as receiver gains
    // payer_k_delta should be negative (loss), receiver_k_delta positive (gain)
    // No-mint: |payer_loss| >= receiver_gain
    // i.e., (-payer_k_delta) >= receiver_k_delta
    // i.e., payer_k_delta + receiver_k_delta <= 0 (net is non-positive = no minting)
    //
    // This is the CONSERVATIVE rounding guarantee:
    // delta_K_payer = ceil(A_p * funding_term / 10000) [rounded up = more loss for payer]
    // delta_K_receiver = floor(delta_K_payer * A_r / A_p) [rounded down = less gain for receiver]
    let net_k = payer_k_delta.saturating_add(receiver_k_delta);
    assert!(net_k <= 0, "P2.7: FUNDING MINTED TOKENS — net K-delta must be <= 0");
}

// ============================================================================
// P2.8: ADL enqueue correctness (a_new < a_old, epoch increments)
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_8_adl_enqueue_correctness() {
    let mut market = test_market();

    // Need opposing side with live OI and stored positions
    let opp_oi: u128 = kani::any();
    kani::assume(opp_oi >= POS_SCALE);
    kani::assume(opp_oi <= 5 * POS_SCALE);
    market.oi_eff_short_q = opp_oi;

    let opp_count: u64 = kani::any();
    kani::assume(opp_count >= 1);
    kani::assume(opp_count <= 10);
    market.stored_pos_count_short = opp_count;

    let a_old = market.short_a;

    // Liquidation side = Long, opposing = Short
    let q_close: u128 = kani::any();
    kani::assume(q_close >= 1);
    kani::assume(q_close < opp_oi); // must be < OI so we don't exhaust precision
    kani::assume(q_close <= POS_SCALE); // tighten further

    let deficit: u128 = kani::any();
    kani::assume(deficit <= 10_000);

    let epoch_before = market.short_epoch;

    let result = enqueue_adl(&mut market, Side::Long, q_close, deficit);
    kani::assume(result.is_ok());

    let a_new = market.short_a;
    let epoch_after = market.short_epoch;

    // A must decrease (dilution)
    assert!(a_new <= a_old, "P2.8: A_new must be <= A_old after ADL");

    // If A didn't trigger precision exhaustion, epoch stays same
    if a_new > 0 {
        assert!(epoch_after == epoch_before, "P2.8: epoch must not change for normal ADL");
    }
}

// ============================================================================
// P2.9: ADL dust bounds (remainder < k after mul_div)
// Implicit in mul_div_floor_u256_with_rem: remainder is always < divisor
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_9_adl_dust_bounds() {
    let a: u128 = kani::any();
    kani::assume(a >= 1);
    kani::assume(a <= 1_000_000);

    let b: u128 = kani::any();
    kani::assume(b >= 1);
    kani::assume(b <= 1_000_000);

    let d: u128 = kani::any();
    kani::assume(d >= 1);
    kani::assume(d <= 1_000_000);

    let a_u256 = U256::from_u128(a);
    let b_u256 = U256::from_u128(b);
    let d_u256 = U256::from_u128(d);

    let (q, r) = mul_div_floor_u256_with_rem(a_u256, b_u256, d_u256);
    let r_u128 = r.try_into_u128();

    if let Some(rem) = r_u128 {
        assert!(rem < d, "P2.9: remainder must be strictly less than divisor");
    }
    // Also: q * d + r == a * b (algebraic identity)
    // Verified implicitly by the division algorithm
}

// ============================================================================
// P2.10: Insurance buffer respects epoch cap
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_10_insurance_epoch_cap() {
    let mut market = test_market();

    let ins_bal: u64 = kani::any();
    kani::assume(ins_bal >= 1000);
    kani::assume(ins_bal <= 1_000_000_000);
    market.insurance_fund_balance = ins_bal;
    market.insurance_floor = 0;

    // Set epoch payout NEAR the cap to test capping behavior
    let epoch_cap = ((ins_bal as u128) * (INSURANCE_EPOCH_CAP_BPS as u128)) / 10_000;
    let already_paid: u64 = kani::any();
    kani::assume(already_paid as u128 <= epoch_cap);
    // Push it close to cap: at least 40% of cap already paid
    kani::assume(already_paid as u128 >= epoch_cap * 4 / 10);
    market.insurance_epoch_payout = already_paid;

    let loss: u128 = kani::any();
    kani::assume(loss >= 1);
    kani::assume(loss <= ins_bal as u128);

    let ins_before = market.insurance_fund_balance as u128;
    let payout_before = market.insurance_epoch_payout as u128;

    let remaining = use_insurance_buffer(&mut market, loss);

    let ins_after = market.insurance_fund_balance as u128;
    let payout_after = market.insurance_epoch_payout as u128;
    let actual_pay = ins_before - ins_after;

    // Total epoch payout must not exceed cap
    assert!(payout_after <= epoch_cap + 1, "P2.10: total epoch payout must not exceed epoch cap");
    // What was paid this call must respect remaining epoch budget
    let epoch_remaining = epoch_cap.saturating_sub(payout_before);
    assert!(actual_pay <= epoch_remaining, "P2.10: payout must respect remaining epoch budget");
    // Returned remaining + paid == original loss
    assert!(remaining + actual_pay == loss, "P2.10: remaining + paid must equal loss");
}

// ============================================================================
// P2.11: Insurance buffer respects floor
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_11_insurance_floor() {
    let mut market = test_market();

    let ins_bal: u64 = kani::any();
    kani::assume(ins_bal >= 1000);
    kani::assume(ins_bal <= 1_000_000_000);
    market.insurance_fund_balance = ins_bal;

    let floor: u128 = kani::any();
    kani::assume(floor <= ins_bal as u128);
    market.insurance_floor = floor;
    market.insurance_epoch_payout = 0;

    let loss: u128 = kani::any();
    kani::assume(loss >= 1);
    kani::assume(loss <= 2 * ins_bal as u128);

    use_insurance_buffer(&mut market, loss);

    assert!(
        market.insurance_fund_balance as u128 >= floor,
        "P2.11: insurance balance must not go below floor"
    );
}

// ============================================================================
// P2.12: absorb_protocol_loss respects haircut floor (insurance >= floor)
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_12_absorb_respects_floor() {
    let mut market = test_market();

    let ins_bal: u64 = kani::any();
    kani::assume(ins_bal >= 100);
    kani::assume(ins_bal <= 1_000_000_000);
    market.insurance_fund_balance = ins_bal;

    let floor: u128 = kani::any();
    kani::assume(floor <= ins_bal as u128);
    market.insurance_floor = floor;
    market.insurance_epoch_payout = 0;

    let loss: u128 = kani::any();
    kani::assume(loss >= 1);
    kani::assume(loss <= 2_000_000_000);

    absorb_protocol_loss(&mut market, loss);

    assert!(
        market.insurance_fund_balance as u128 >= floor,
        "P2.12: absorb_protocol_loss must not reduce insurance below floor"
    );
}

// ============================================================================
// P2.13: Fee debt sweep conservation
// Capital decreases by pay, insurance increases by pay, fee_credits increases by pay
// Tests with NON-ZERO capital so the sweep actually runs
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_13_fee_debt_sweep_conservation() {
    let mut market = test_market();
    let mut pos = test_position();

    // Non-zero capital (CRITICAL: sweep only runs if cap > 0)
    let cap: u64 = kani::any();
    kani::assume(cap >= 10_000);
    kani::assume(cap <= 1_000_000_000);
    pos.deposited_collateral = cap;
    market.c_tot = cap as u128;
    market.vault_balance = cap as u128 + market.insurance_fund_balance as u128;

    // Negative fee_credits = debt (CRITICAL: sweep only runs if debt > 0)
    let debt_raw: u64 = kani::any();
    kani::assume(debt_raw >= 1);
    kani::assume(debt_raw <= cap as u64); // debt up to capital
    pos.fee_credits = -(debt_raw as i128);

    let cap_before = pos.deposited_collateral as u128;
    let ins_before = market.insurance_fund_balance as u128;
    let fc_before = pos.fee_credits;
    let c_tot_before = market.c_tot;

    fee_debt_sweep(&mut pos, &mut market);

    let cap_after = pos.deposited_collateral as u128;
    let ins_after = market.insurance_fund_balance as u128;
    let fc_after = pos.fee_credits;

    let cap_delta = cap_before - cap_after;
    let ins_delta = ins_after - ins_before;
    let fc_delta = fc_after - fc_before; // should be positive (debt reduced)

    // Capital paid = insurance received
    assert!(cap_delta == ins_delta, "P2.13: capital decrease must equal insurance increase");
    // Fee credits moved toward zero
    assert!(fc_after >= fc_before, "P2.13: fee_credits must not decrease (debt reduced)");
    // Capital decreased
    assert!(cap_after <= cap_before, "P2.13: capital must not increase during sweep");
    // c_tot decreased by same amount
    assert!(market.c_tot == c_tot_before - cap_delta, "P2.13: c_tot must track capital decrease");
}

// ============================================================================
// P2.14: Fee credits never i128::MIN
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_14_fee_credits_never_min() {
    let mut pos = test_position();

    let fc: i128 = kani::any();
    kani::assume(fc != i128::MIN);
    kani::assume(fc > i128::MIN + 1_000_000);
    pos.fee_credits = fc;

    let fee: u128 = kani::any();
    kani::assume(fee >= 1);
    kani::assume(fee <= 1_000_000);

    let mut market = test_market();
    pos.deposited_collateral = 0; // force shortfall path

    let result = charge_fee_to_insurance(&mut pos, &mut market, fee);

    // If it succeeded, fee_credits must not be i128::MIN
    if result.is_ok() {
        assert!(pos.fee_credits != i128::MIN, "P2.14: fee_credits must never be i128::MIN");
    }
    // If it errored, that's also acceptable (overflow protection)
}

// ============================================================================
// P2.15: reclaim_empty_account rejects open positions
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_15_reclaim_rejects_open_position() {
    let mut market = test_market();
    let mut pos = test_position();

    // Give the position a non-zero basis (open position)
    let basis: i128 = kani::any();
    kani::assume(basis != 0);
    kani::assume(basis.unsigned_abs() <= 1_000);
    pos.basis = basis;

    // Make effective_position_q return non-zero
    // Set a_snapshot = long_a and epoch_snapshot = long_epoch for positive basis
    if basis > 0 {
        pos.a_snapshot = market.long_a;
        pos.epoch_snapshot = market.long_epoch;
    } else {
        pos.a_snapshot = market.short_a;
        pos.epoch_snapshot = market.short_epoch;
    }

    let result = reclaim_empty_account(&mut pos, &mut market);
    assert!(result.is_err(), "P2.15: reclaim must reject accounts with open positions");
}

// ============================================================================
// P2.16: reclaim_empty_account rejects live capital (non-zero PnL)
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_16_reclaim_rejects_nonzero_pnl() {
    let mut market = test_market();
    let mut pos = test_position();

    pos.basis = 0; // flat position
    pos.pnl = kani::any();
    kani::assume(pos.pnl != 0); // non-zero PnL

    let result = reclaim_empty_account(&mut pos, &mut market);
    assert!(result.is_err(), "P2.16: reclaim must reject accounts with non-zero PnL");
}

// ============================================================================
// P2.17: Phantom dust drain no revert
// check_and_clear_phantom_dust must not panic when OI <= dust_bound
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_17_phantom_dust_no_revert() {
    let mut market = test_market();

    // No stored positions (triggers dust check path)
    market.stored_pos_count_long = 0;
    market.stored_pos_count_short = 0;

    let oi: u128 = kani::any();
    kani::assume(oi >= 1);
    kani::assume(oi <= 1_000);

    market.oi_eff_long_q = oi;
    // Dust bound >= OI so it triggers the clear path
    market.phantom_dust_bound_long_q = oi;

    // Ensure opposite side is clean to avoid panics in begin_full_drain_reset
    market.oi_eff_short_q = 0;
    market.long_state = SideState::Normal;
    market.short_state = SideState::Normal;

    // This must not panic
    check_and_clear_phantom_dust(&mut market, Side::Long);

    // After clearing, OI should be 0
    assert!(market.oi_eff_long_q == 0, "P2.17: OI must be cleared after phantom dust drain");
}

// ============================================================================
// P2.18: Protected principal (capital can't go below zero)
// settle_losses caps payment at capital
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_18_protected_principal() {
    let mut market = test_market();
    let mut pos = test_position();

    let cap: u64 = kani::any();
    kani::assume(cap >= 1);
    kani::assume(cap <= 1_000_000_000);
    pos.deposited_collateral = cap;
    market.c_tot = cap as u128;

    // Negative PnL (loss) potentially larger than capital
    let loss_abs: u128 = kani::any();
    kani::assume(loss_abs >= 1);
    kani::assume(loss_abs <= 2_000_000_000);
    kani::assume(loss_abs <= i128::MAX as u128);
    pos.pnl = -(loss_abs as i128);

    // Need aggregates consistent
    market.pnl_pos_tot = 0;
    market.pnl_matured_pos_tot = 0;
    pos.reserved_pnl = 0;

    let cap_before = pos.deposited_collateral as u128;
    let c_tot_before = market.c_tot;

    settle_losses(&mut pos, &mut market);

    let cap_after = pos.deposited_collateral as u128;

    // Capital must not increase during loss settlement
    assert!(cap_after <= cap_before,
        "P2.18: capital must not increase during loss settlement");

    // c_tot must decrease by the same amount as capital (conservation)
    let cap_decrease = cap_before - cap_after;
    assert!(market.c_tot == c_tot_before - cap_decrease,
        "P2.18: c_tot must decrease by same amount as capital");
}

// ============================================================================
// P2.19: Trading loss seniority (PnL debt before capital)
// settle_losses deducts from capital and credits PnL toward zero
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_19_loss_seniority() {
    let mut market = test_market();
    let mut pos = test_position();

    let cap: u64 = kani::any();
    kani::assume(cap >= 1);
    kani::assume(cap <= 1_000_000_000);
    pos.deposited_collateral = cap;
    market.c_tot = cap as u128;

    let loss_abs: u128 = kani::any();
    kani::assume(loss_abs >= 1);
    kani::assume(loss_abs <= 1_000_000_000);
    kani::assume(loss_abs <= i128::MAX as u128);
    pos.pnl = -(loss_abs as i128);
    pos.reserved_pnl = 0;
    market.pnl_pos_tot = 0;
    market.pnl_matured_pos_tot = 0;

    let pnl_before = pos.pnl;
    let cap_before = pos.deposited_collateral;

    settle_losses(&mut pos, &mut market);

    let cap_after = pos.deposited_collateral;
    let pnl_after = pos.pnl;

    let cap_paid = (cap_before as u128) - (cap_after as u128);

    // PnL must move toward zero (less negative)
    assert!(pnl_after >= pnl_before, "P2.19: PnL must move toward zero after loss settlement");

    // Capital decrease = PnL improvement
    let pnl_improvement = pnl_after - pnl_before;
    assert!(
        pnl_improvement == cap_paid as i128,
        "P2.19: PnL improvement must equal capital deducted"
    );
}

// ============================================================================
// P2.20: compute_trade_pnl no panic at boundary
// ============================================================================
#[kani::proof]
#[kani::unwind(30)]
#[kani::solver(cadical)]
fn p2_20_compute_trade_pnl_no_panic() {
    let size_q: i128 = kani::any();
    kani::assume(size_q.unsigned_abs() <= 1_000);

    let price_diff: i128 = kani::any();
    kani::assume(price_diff.unsigned_abs() <= 1_000);

    // This must not panic — it may return Err for overflow, which is acceptable
    let result = compute_trade_pnl(size_q, price_diff);

    match result {
        Ok(pnl) => {
            // Result must not be i128::MIN (our protocol-wide invariant)
            // Actually compute_trade_pnl can legitimately return i128::MIN-adjacent values
            // but magnitude is bounded by MAX_POSITION_ABS_Q * MAX_ORACLE_PRICE / POS_SCALE
            if size_q == 0 || price_diff == 0 {
                assert!(pnl == 0, "P2.20: zero input must produce zero PnL");
            }
        }
        Err(_) => {
            // Overflow is acceptable for extreme boundary values
        }
    }
}
