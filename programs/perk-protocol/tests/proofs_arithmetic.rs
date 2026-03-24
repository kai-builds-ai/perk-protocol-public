// =============================================================================
// Kani Formal Proofs — Category 1: Arithmetic (wide_math, i128_types)
// Properties P1.1 through P1.15
// =============================================================================

mod common;
use common::*;

// =============================================================================
// P1.1: floor_div_signed_conservative — correct floor division
// For positive results: floor. For negative results: round away from zero.
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_1_floor_div_signed_conservative() {
    let abs_basis: u128 = kani::any::<u8>() as u128 + 1; // 1..256
    let k_delta: i16 = kani::any();
    kani::assume(k_delta != 0);
    let k_now: i128 = k_delta as i128;
    let k_then: i128 = 0;
    let den: u128 = kani::any::<u8>() as u128 + 1; // 1..256

    let result = wide_signed_mul_div_floor_from_k_pair(abs_basis, k_now, k_then, den);

    // Reference: abs_basis * k_delta / den with signed floor rounding
    let product = abs_basis as i128 * k_delta as i128;

    if product >= 0 {
        // Positive: floor division (truncation toward zero)
        let expected = product / den as i128;
        assert!(result == expected, "positive floor mismatch");
    } else {
        // Negative: round away from zero (toward more negative)
        // floor(-|p|/d) = -(|p| + d - 1) / d = -(ceil(|p|/d))
        let abs_p = product.unsigned_abs();
        let ceil_mag = (abs_p + den - 1) / den;
        let expected = -(ceil_mag as i128);
        assert!(result == expected, "negative floor mismatch");
    }
}

// =============================================================================
// P1.2: mul_div_floor algebraic identity: q*d + r == a*b, r < d
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_2_mul_div_floor_algebraic_identity() {
    let a_raw: u8 = kani::any();
    let b_raw: u8 = kani::any();
    let d_raw: u8 = kani::any();
    kani::assume(d_raw > 0);

    let a = U256::from_u128(a_raw as u128);
    let b = U256::from_u128(b_raw as u128);
    let d = U256::from_u128(d_raw as u128);

    let (q, r) = mul_div_floor_u256_with_rem(a, b, d);

    // Identity: q * d + r == a * b
    let lhs = q.checked_mul(d).unwrap().checked_add(r).unwrap();
    let rhs = a.checked_mul(b).unwrap();
    assert!(lhs == rhs, "algebraic identity violated");

    // Remainder bound: r < d
    assert!(r < d, "remainder not less than divisor");
}

// =============================================================================
// P1.3: mul_div_ceil == floor + (r != 0 ? 1 : 0)
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_3_ceil_equals_floor_plus_remainder() {
    let a_raw: u8 = kani::any();
    let b_raw: u8 = kani::any();
    let d_raw: u8 = kani::any();
    kani::assume(d_raw > 0);

    let a = U256::from_u128(a_raw as u128);
    let b = U256::from_u128(b_raw as u128);
    let d = U256::from_u128(d_raw as u128);

    let floor = mul_div_floor_u256(a, b, d);
    let (_, r) = mul_div_floor_u256_with_rem(a, b, d);
    let ceil = mul_div_ceil_u256(a, b, d);

    let expected_ceil = if r.is_zero() {
        floor
    } else {
        floor.checked_add(U256::ONE).unwrap()
    };
    assert!(ceil == expected_ceil, "ceil != floor + roundup");
}

// =============================================================================
// P1.4: mul_div_floor/ceil match native reference for u8 range
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_4_mul_div_matches_native_u8() {
    let a: u8 = kani::any();
    let b: u8 = kani::any();
    let d: u8 = kani::any();
    kani::assume(d > 0);

    let a128 = a as u128;
    let b128 = b as u128;
    let d128 = d as u128;
    let product = a128 * b128; // fits u128 for u8 inputs

    // Native reference
    let ref_floor = product / d128;
    let ref_ceil = if product % d128 != 0 { ref_floor + 1 } else { ref_floor };

    // Wide implementation
    let wide_floor = mul_div_floor_u256(
        U256::from_u128(a128), U256::from_u128(b128), U256::from_u128(d128),
    );
    let wide_ceil = mul_div_ceil_u256(
        U256::from_u128(a128), U256::from_u128(b128), U256::from_u128(d128),
    );

    assert!(wide_floor.try_into_u128().unwrap() == ref_floor, "floor mismatch");
    assert!(wide_ceil.try_into_u128().unwrap() == ref_ceil, "ceil mismatch");
}

// =============================================================================
// P1.5: fee_debt_u128_checked: negative fc → abs, positive → 0
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_5_fee_debt_checked() {
    let fc: i128 = kani::any::<i16>() as i128; // tractable range

    let debt = fee_debt_u128_checked(fc);

    if fc < 0 {
        // Negative: debt = |fc|
        assert!(debt == fc.unsigned_abs(), "negative fc should yield abs");
        assert!(debt > 0, "negative fc must produce nonzero debt");
    } else {
        // Non-negative: debt = 0
        assert!(debt == 0, "non-negative fc should yield zero debt");
    }
}

// =============================================================================
// P1.6: saturating_mul_u128_u64 saturates at u128::MAX
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_6_saturating_mul_saturates() {
    let a: u128 = kani::any::<u16>() as u128;
    let b: u64 = kani::any::<u16>() as u64;

    let result = saturating_mul_u128_u64(a, b);

    if a == 0 || b == 0 {
        assert!(result == 0, "zero input must give zero");
    } else {
        // Result must be >= min(a, b) (since both > 0)
        assert!(result >= a.min(b as u128), "result below minimum");
        // Result must be <= u128::MAX (saturation)
        assert!(result <= u128::MAX);
        // For small inputs that fit, should equal a * b
        if let Some(exact) = a.checked_mul(b as u128) {
            assert!(result == exact, "non-saturating case mismatch");
        } else {
            assert!(result == u128::MAX, "overflow must saturate");
        }
    }
}

// =============================================================================
// P1.7: ceil_div_positive_checked matches reference
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_7_ceil_div_positive() {
    let n_raw: u8 = kani::any();
    let d_raw: u8 = kani::any();
    kani::assume(d_raw > 0);

    let n = U256::from_u128(n_raw as u128);
    let d = U256::from_u128(d_raw as u128);

    let result = ceil_div_positive_checked(n, d);
    let result_u128 = result.try_into_u128().unwrap();

    // Reference: (n + d - 1) / d
    let n128 = n_raw as u128;
    let d128 = d_raw as u128;
    let expected = (n128 + d128 - 1) / d128;
    assert!(result_u128 == expected, "ceil_div mismatch");

    // Verify ceil property: result * d >= n
    let rd = result.checked_mul(d).unwrap();
    assert!(rd >= n, "ceil result too small");

    // And (result - 1) * d < n (when result > 0)
    if !result.is_zero() {
        let prev = result.checked_sub(U256::ONE).unwrap();
        let pd = prev.checked_mul(d).unwrap();
        assert!(pd < n, "not tight ceil");
    }
}

// =============================================================================
// P1.8: wide_signed_mul_div_floor correct sign and rounding
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_8_wide_signed_mul_div_floor_sign() {
    let abs_basis: u128 = kani::any::<u8>() as u128 + 1;
    let k_now: i128 = kani::any::<i8>() as i128;
    let k_then: i128 = 0;
    let den: u128 = kani::any::<u8>() as u128 + 1;

    let result = wide_signed_mul_div_floor_from_k_pair(abs_basis, k_now, k_then, den);

    let diff = k_now; // k_then = 0
    if diff > 0 {
        // Positive K-diff → positive result (floor)
        assert!(result >= 0, "positive diff must give non-negative result");
        // Floor: result <= exact
        let exact_num = abs_basis * (diff as u128);
        let expected = (exact_num / den) as i128;
        assert!(result == expected, "positive floor mismatch");
    } else if diff < 0 {
        // Negative K-diff → negative result (round away from zero)
        assert!(result <= 0, "negative diff must give non-positive result");
        // Magnitude: ceil(abs_basis * |diff| / den)
        let abs_diff = diff.unsigned_abs();
        let exact_num = abs_basis * abs_diff;
        let ceil_mag = (exact_num + den - 1) / den;
        assert!(result == -(ceil_mag as i128), "negative ceil-magnitude mismatch");
    } else {
        assert!(result == 0, "zero diff must give zero");
    }
}

// =============================================================================
// P1.9: wide_signed_mul_div_floor_from_k_pair correct with arbitrary K-difference
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_9_k_pair_difference_correct() {
    let abs_basis: u128 = kani::any::<u8>() as u128 + 1;
    let k_now: i128 = kani::any::<i8>() as i128;
    let k_then: i128 = kani::any::<i8>() as i128;
    let den: u128 = kani::any::<u8>() as u128 + 1;

    let result = wide_signed_mul_div_floor_from_k_pair(abs_basis, k_now, k_then, den);

    // Equivalent to computing with (k_now - k_then) directly
    let result_direct = wide_signed_mul_div_floor_from_k_pair(
        abs_basis, k_now - k_then, 0, den,
    );

    assert!(result == result_direct, "k_pair must be equivalent to explicit difference");
}

// =============================================================================
// P1.10: K-pair with equal k_now/k_then returns 0
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_10_k_pair_equal_returns_zero() {
    let abs_basis: u128 = kani::any::<u16>() as u128;
    let k: i128 = kani::any::<i16>() as i128;
    let den: u128 = kani::any::<u8>() as u128 + 1;

    let result = wide_signed_mul_div_floor_from_k_pair(abs_basis, k, k, den);
    assert!(result == 0, "equal k_now and k_then must produce zero");
}

// =============================================================================
// P1.11: Zero inputs produce zero results
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_11_zero_inputs_zero_results() {
    let b: u128 = kani::any::<u8>() as u128;
    let k_now: i128 = kani::any::<i8>() as i128;
    let k_then: i128 = kani::any::<i8>() as i128;
    let den: u128 = kani::any::<u8>() as u128 + 1;

    // Zero abs_basis
    let r1 = wide_signed_mul_div_floor_from_k_pair(0, k_now, k_then, den);
    assert!(r1 == 0, "zero basis must produce zero");

    // fee_debt of zero/positive
    assert!(fee_debt_u128_checked(0) == 0, "fee_debt(0) must be 0");
    assert!(fee_debt_u128_checked(1) == 0, "fee_debt(positive) must be 0");

    // saturating_mul with zero
    assert!(saturating_mul_u128_u64(0, 42) == 0);
    assert!(saturating_mul_u128_u64(42, 0) == 0);

    // mul_div with zero numerator
    let zero = U256::from_u128(0);
    let d = U256::from_u128(den);
    let bv = U256::from_u128(b);
    let r = mul_div_floor_u256(zero, bv, d);
    assert!(r == U256::ZERO, "zero a must give zero");
    let r2 = mul_div_floor_u256(bv, zero, d);
    assert!(r2 == U256::ZERO, "zero b must give zero");
}

// =============================================================================
// P1.12: Notional is zero for flat position
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_12_notional_zero_for_flat() {
    let price: u64 = kani::any::<u16>() as u64 + 1;

    let market = test_market();
    let pos = test_position(); // basis = 0 → flat

    let n = notional(&pos, &market, price);
    assert!(n == 0, "flat position must have zero notional");
}

// =============================================================================
// P1.13: Notional is monotone in price
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_13_notional_monotone_in_price() {
    let size_q: u8 = kani::any();
    kani::assume(size_q > 0);
    let p1: u16 = kani::any();
    let p2: u16 = kani::any();
    kani::assume(p1 <= p2);
    kani::assume(p1 > 0);

    let mut market = test_market();
    let mut pos = test_position();
    set_long_position(&mut pos, &mut market, size_q as u128);

    let n1 = notional(&pos, &market, p1 as u64);
    let n2 = notional(&pos, &market, p2 as u64);

    // floor division is monotone: p1 <= p2 → notional(p1) <= notional(p2)
    assert!(n1 <= n2, "notional must be monotone in price");
}

// =============================================================================
// P1.14: fused_delta_k — checked_u128_mul_i128 no double rounding
// The delta_k computation uses a single wide multiply, not mul then div.
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_14_fused_delta_k_no_double_rounding() {
    let a_val: u128 = kani::any::<u8>() as u128 + 1;
    let delta_p: i128 = kani::any::<i8>() as i128;

    match checked_u128_mul_i128(a_val, delta_p) {
        Ok(result) => {
            // Result must have correct sign
            if delta_p > 0 {
                assert!(result > 0 || a_val == 0);
            } else if delta_p < 0 {
                assert!(result < 0 || a_val == 0);
            } else {
                assert!(result == 0);
            }
            // Result must equal exact product (no rounding for pure multiply)
            let expected = (a_val as i128) * delta_p;
            assert!(result == expected, "fused must match exact product");
        }
        Err(()) => {
            // Overflow: |a * delta_p| > i128::MAX, acceptable
        }
    }
}

// =============================================================================
// P1.15: haircut_mul_div conservative — floor, never overshoots
// wide_mul_div_floor_u128 returns ≤ exact value (floor rounding is conservative)
// =============================================================================
#[kani::proof]
#[kani::unwind(10)]
#[kani::solver(cadical)]
fn p1_15_haircut_mul_div_conservative() {
    let released: u128 = kani::any::<u8>() as u128;
    let h_num: u128 = kani::any::<u8>() as u128;
    let h_den: u128 = kani::any::<u8>() as u128 + 1;
    kani::assume(h_num <= h_den); // haircut ratio bounded

    let result = wide_mul_div_floor_u128(released, h_num, h_den);

    // Conservative: result <= released (since h_num/h_den <= 1)
    assert!(result <= released, "haircut must not overshoot released amount");

    // Floor: result * h_den <= released * h_num (no overcount)
    // Equivalent: result <= floor(released * h_num / h_den)
    let exact_num = released as u128 * h_num as u128;
    let expected_floor = exact_num / h_den;
    assert!(result == expected_floor, "must be exact floor");

    // Tightness: (result + 1) * h_den > released * h_num
    // i.e., result is the largest integer ≤ exact
    if result < released {
        let next = result + 1;
        assert!(next * h_den > exact_num || exact_num % h_den == 0,
            "floor must be tight");
    }
}
