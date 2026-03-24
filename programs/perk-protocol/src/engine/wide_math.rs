/// Wide 256-bit Arithmetic for Risk Engine — Ported from Percolator
///
/// Provides U256 and I256 types plus spec section 4.6 helpers (floor division,
/// ceiling division, mul-div with 512-bit intermediate) for the percolator
/// risk engine.
///
/// BPF build: `#[repr(C)] [u64; 4]` for consistent 8-byte alignment.
/// No external crates. No unsafe code. Pure `core::` only.

use core::cmp::Ordering;

// ============================================================================
// U256
// ============================================================================
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct U256([u64; 4]); // [limb0 (LSB), limb1, limb2, limb3 (MSB)]

impl U256 {
    pub const ZERO: Self = Self([0, 0, 0, 0]);
    pub const ONE: Self = Self([1, 0, 0, 0]);
    pub const MAX: Self = Self([u64::MAX, u64::MAX, u64::MAX, u64::MAX]);

    #[inline]
    pub const fn new(lo: u128, hi: u128) -> Self {
        Self([
            lo as u64,
            (lo >> 64) as u64,
            hi as u64,
            (hi >> 64) as u64,
        ])
    }

    #[inline]
    pub const fn from_u128(v: u128) -> Self {
        Self::new(v, 0)
    }

    #[inline]
    pub const fn from_u64(v: u64) -> Self {
        Self([v, 0, 0, 0])
    }

    #[inline]
    pub const fn lo(&self) -> u128 {
        (self.0[0] as u128) | ((self.0[1] as u128) << 64)
    }

    #[inline]
    pub const fn hi(&self) -> u128 {
        (self.0[2] as u128) | ((self.0[3] as u128) << 64)
    }

    #[inline]
    pub const fn is_zero(&self) -> bool {
        self.0[0] == 0 && self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0
    }

    #[inline]
    pub fn try_into_u128(&self) -> Option<u128> {
        if self.0[2] == 0 && self.0[3] == 0 {
            Some(self.lo())
        } else {
            None
        }
    }

    pub fn checked_add(self, rhs: U256) -> Option<U256> {
        let (lo, carry) = add_u128_carry(self.lo(), rhs.lo(), false);
        let (hi, overflow) = add_u128_carry(self.hi(), rhs.hi(), carry);
        if overflow { None } else { Some(U256::new(lo, hi)) }
    }

    pub fn checked_sub(self, rhs: U256) -> Option<U256> {
        let (lo, borrow) = sub_u128_borrow(self.lo(), rhs.lo(), false);
        let (hi, underflow) = sub_u128_borrow(self.hi(), rhs.hi(), borrow);
        if underflow { None } else { Some(U256::new(lo, hi)) }
    }

    pub fn checked_mul(self, rhs: U256) -> Option<U256> {
        if self.hi() != 0 && rhs.hi() != 0 {
            return None;
        }
        let (prod_lo, prod_hi) = widening_mul_u128(self.lo(), rhs.lo());
        let cross1 = if rhs.hi() != 0 {
            let (c, overflow) = widening_mul_u128(self.lo(), rhs.hi());
            if overflow != 0 { return None; }
            c
        } else {
            0u128
        };
        let cross2 = if self.hi() != 0 {
            let (c, overflow) = widening_mul_u128(self.hi(), rhs.lo());
            if overflow != 0 { return None; }
            c
        } else {
            0u128
        };
        let hi = prod_hi.checked_add(cross1)?;
        let hi = hi.checked_add(cross2)?;
        Some(U256::new(prod_lo, hi))
    }

    pub fn checked_div(self, rhs: U256) -> Option<U256> {
        if rhs.is_zero() { return None; }
        Some(div_rem_u256(self, rhs).0)
    }

    pub fn checked_rem(self, rhs: U256) -> Option<U256> {
        if rhs.is_zero() { return None; }
        Some(div_rem_u256(self, rhs).1)
    }

    pub fn overflowing_add(self, rhs: U256) -> (U256, bool) {
        let (lo, carry) = add_u128_carry(self.lo(), rhs.lo(), false);
        let (hi, overflow) = add_u128_carry(self.hi(), rhs.hi(), carry);
        (U256::new(lo, hi), overflow)
    }

    pub fn overflowing_sub(self, rhs: U256) -> (U256, bool) {
        let (lo, borrow) = sub_u128_borrow(self.lo(), rhs.lo(), false);
        let (hi, underflow) = sub_u128_borrow(self.hi(), rhs.hi(), borrow);
        (U256::new(lo, hi), underflow)
    }

    pub fn saturating_add(self, rhs: U256) -> U256 {
        self.checked_add(rhs).unwrap_or(U256::MAX)
    }

    pub fn saturating_sub(self, rhs: U256) -> U256 {
        self.checked_sub(rhs).unwrap_or(U256::ZERO)
    }

    pub fn shl(self, bits: u32) -> U256 {
        if bits >= 256 { return U256::ZERO; }
        if bits == 0 { return self; }
        let lo = self.lo();
        let hi = self.hi();
        if bits >= 128 {
            let s = bits - 128;
            U256::new(0, lo << s)
        } else {
            let new_lo = lo << bits;
            let new_hi = (hi << bits) | (lo >> (128 - bits));
            U256::new(new_lo, new_hi)
        }
    }

    pub fn shr(self, bits: u32) -> U256 {
        if bits >= 256 { return U256::ZERO; }
        if bits == 0 { return self; }
        let lo = self.lo();
        let hi = self.hi();
        if bits >= 128 {
            let s = bits - 128;
            U256::new(hi >> s, 0)
        } else {
            let new_hi = hi >> bits;
            let new_lo = (lo >> bits) | (hi << (128 - bits));
            U256::new(new_lo, new_hi)
        }
    }

    pub fn bitand(self, rhs: U256) -> U256 {
        U256::new(self.lo() & rhs.lo(), self.hi() & rhs.hi())
    }

    pub fn bitor(self, rhs: U256) -> U256 {
        U256::new(self.lo() | rhs.lo(), self.hi() | rhs.hi())
    }
}

impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U256 {
    fn cmp(&self, other: &Self) -> Ordering {
        match self.hi().cmp(&other.hi()) {
            Ordering::Equal => self.lo().cmp(&other.lo()),
            ord => ord,
        }
    }
}

impl core::ops::Add for U256 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        self.checked_add(rhs).expect("U256 add overflow")
    }
}

impl core::ops::Sub for U256 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        self.checked_sub(rhs).expect("U256 sub underflow")
    }
}

impl core::ops::Mul for U256 {
    type Output = Self;
    #[inline]
    fn mul(self, rhs: Self) -> Self {
        self.checked_mul(rhs).expect("U256 mul overflow")
    }
}

impl core::ops::Div for U256 {
    type Output = Self;
    #[inline]
    fn div(self, rhs: Self) -> Self {
        self.checked_div(rhs).expect("U256 div by zero")
    }
}

impl core::ops::Rem for U256 {
    type Output = Self;
    #[inline]
    fn rem(self, rhs: Self) -> Self {
        self.checked_rem(rhs).expect("U256 rem by zero")
    }
}

impl core::ops::Shl<u32> for U256 {
    type Output = Self;
    #[inline]
    fn shl(self, bits: u32) -> Self { self.shl(bits) }
}

impl core::ops::Shr<u32> for U256 {
    type Output = Self;
    #[inline]
    fn shr(self, bits: u32) -> Self { self.shr(bits) }
}

impl core::ops::BitAnd for U256 {
    type Output = Self;
    #[inline]
    fn bitand(self, rhs: Self) -> Self { self.bitand(rhs) }
}

impl core::ops::BitOr for U256 {
    type Output = Self;
    #[inline]
    fn bitor(self, rhs: Self) -> Self { self.bitor(rhs) }
}

impl core::ops::AddAssign for U256 {
    #[inline]
    fn add_assign(&mut self, rhs: Self) { *self = *self + rhs; }
}

impl core::ops::SubAssign for U256 {
    #[inline]
    fn sub_assign(&mut self, rhs: Self) { *self = *self - rhs; }
}

// ============================================================================
// I256
// ============================================================================
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct I256([u64; 4]); // two's complement, little-endian limbs

impl I256 {
    pub const ZERO: Self = Self([0, 0, 0, 0]);
    pub const ONE: Self = Self([1, 0, 0, 0]);
    pub const MINUS_ONE: Self = Self([u64::MAX, u64::MAX, u64::MAX, u64::MAX]);
    pub const MAX: Self = Self([u64::MAX, u64::MAX, u64::MAX, u64::MAX >> 1]);
    pub const MIN: Self = Self([0, 0, 0, 1u64 << 63]);

    pub fn from_i128(v: i128) -> Self {
        let lo = v as u128;
        let hi: u128 = if v < 0 { u128::MAX } else { 0 };
        Self::from_lo_hi(lo, hi)
    }

    pub fn from_u128(v: u128) -> Self {
        Self::from_lo_hi(v, 0)
    }

    pub fn try_into_i128(&self) -> Option<i128> {
        let lo = self.lo_u128();
        let hi = self.hi_u128();
        let lo_sign_ext = if (lo as i128) < 0 { u128::MAX } else { 0 };
        if hi == lo_sign_ext { Some(lo as i128) } else { None }
    }

    pub fn is_zero(&self) -> bool {
        self.0[0] == 0 && self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0
    }

    pub fn is_negative(&self) -> bool {
        (self.0[3] >> 63) != 0
    }

    pub fn is_positive(&self) -> bool {
        !self.is_zero() && !self.is_negative()
    }

    pub fn signum(&self) -> i8 {
        if self.is_zero() { 0 }
        else if self.is_negative() { -1 }
        else { 1 }
    }

    pub fn abs_u256(self) -> U256 {
        if self.is_negative() {
            assert!(self != Self::MIN, "abs_u256 called on I256::MIN");
            let lo = self.lo_u128();
            let hi = self.hi_u128();
            let inv_lo = !lo;
            let inv_hi = !hi;
            let (neg_lo, carry) = inv_lo.overflowing_add(1);
            let neg_hi = inv_hi.wrapping_add(if carry { 1 } else { 0 });
            U256::new(neg_lo, neg_hi)
        } else {
            U256::new(self.lo_u128(), self.hi_u128())
        }
    }

    pub fn checked_add(self, rhs: I256) -> Option<I256> {
        let s_lo = self.lo_u128();
        let s_hi = self.hi_u128();
        let r_lo = rhs.lo_u128();
        let r_hi = rhs.hi_u128();
        let (lo, carry) = s_lo.overflowing_add(r_lo);
        let (hi, _overflow1) = s_hi.overflowing_add(r_hi);
        let (hi, _overflow2) = hi.overflowing_add(if carry { 1 } else { 0 });
        let result = I256::from_lo_hi(lo, hi);
        let self_neg = self.is_negative();
        let rhs_neg = rhs.is_negative();
        let res_neg = result.is_negative();
        if self_neg == rhs_neg && res_neg != self_neg { None } else { Some(result) }
    }

    pub fn checked_sub(self, rhs: I256) -> Option<I256> {
        let neg_rhs = match rhs.checked_neg() {
            Some(n) => n,
            None => {
                let s_lo = self.lo_u128();
                let s_hi = self.hi_u128();
                let r_lo = rhs.lo_u128();
                let r_hi = rhs.hi_u128();
                let (lo, borrow) = s_lo.overflowing_sub(r_lo);
                let (hi, _) = s_hi.overflowing_sub(r_hi);
                let (hi, _) = hi.overflowing_sub(if borrow { 1 } else { 0 });
                let result = I256::from_lo_hi(lo, hi);
                let self_neg = self.is_negative();
                let res_neg = result.is_negative();
                if self_neg != true && res_neg != self_neg { return None; }
                return Some(result);
            }
        };
        self.checked_add(neg_rhs)
    }

    pub fn checked_neg(self) -> Option<I256> {
        if self == Self::MIN { return None; }
        let lo = self.lo_u128();
        let hi = self.hi_u128();
        let inv_lo = !lo;
        let inv_hi = !hi;
        let (neg_lo, carry) = inv_lo.overflowing_add(1);
        let neg_hi = inv_hi.wrapping_add(if carry { 1 } else { 0 });
        Some(I256::from_lo_hi(neg_lo, neg_hi))
    }

    pub fn saturating_add(self, rhs: I256) -> I256 {
        match self.checked_add(rhs) {
            Some(v) => v,
            None => if rhs.is_negative() { I256::MIN } else { I256::MAX },
        }
    }

    fn lo_u128(&self) -> u128 {
        (self.0[0] as u128) | ((self.0[1] as u128) << 64)
    }

    fn hi_u128(&self) -> u128 {
        (self.0[2] as u128) | ((self.0[3] as u128) << 64)
    }

    fn from_lo_hi(lo: u128, hi: u128) -> Self {
        Self([lo as u64, (lo >> 64) as u64, hi as u64, (hi >> 64) as u64])
    }

    fn as_raw_u256(self) -> U256 {
        U256::new(self.lo_u128(), self.hi_u128())
    }

    pub fn from_raw_u256(v: U256) -> Self {
        Self::from_lo_hi(v.lo(), v.hi())
    }
}

impl PartialOrd for I256 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for I256 {
    fn cmp(&self, other: &Self) -> Ordering {
        let self_neg = self.is_negative();
        let other_neg = other.is_negative();
        match (self_neg, other_neg) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => self.as_raw_u256().cmp(&other.as_raw_u256()),
        }
    }
}

impl core::ops::Add for I256 {
    type Output = Self;
    #[inline]
    fn add(self, rhs: Self) -> Self {
        self.checked_add(rhs).expect("I256 add overflow")
    }
}

impl core::ops::Sub for I256 {
    type Output = Self;
    #[inline]
    fn sub(self, rhs: Self) -> Self {
        self.checked_sub(rhs).expect("I256 sub overflow")
    }
}

impl core::ops::Neg for I256 {
    type Output = Self;
    #[inline]
    fn neg(self) -> Self {
        self.checked_neg().expect("I256 neg overflow (MIN)")
    }
}

// ============================================================================
// Shared helpers
// ============================================================================

/// Widening multiply: u128 * u128 -> (lo: u128, hi: u128)
fn widening_mul_u128(a: u128, b: u128) -> (u128, u128) {
    let a_lo = a as u64 as u128;
    let a_hi = (a >> 64) as u64 as u128;
    let b_lo = b as u64 as u128;
    let b_hi = (b >> 64) as u64 as u128;

    let ll = a_lo * b_lo;
    let lh = a_lo * b_hi;
    let hl = a_hi * b_lo;
    let hh = a_hi * b_hi;

    let (mid, mid_carry) = lh.overflowing_add(hl);
    let (lo, lo_carry) = ll.overflowing_add(mid << 64);
    let hi = hh + (mid >> 64) + ((mid_carry as u128) << 64) + (lo_carry as u128);
    (lo, hi)
}

fn add_u128_carry(a: u128, b: u128, carry_in: bool) -> (u128, bool) {
    let (s1, c1) = a.overflowing_add(b);
    let (s2, c2) = s1.overflowing_add(carry_in as u128);
    (s2, c1 || c2)
}

fn sub_u128_borrow(a: u128, b: u128, borrow_in: bool) -> (u128, bool) {
    let (d1, b1) = a.overflowing_sub(b);
    let (d2, b2) = d1.overflowing_sub(borrow_in as u128);
    (d2, b1 || b2)
}

fn leading_zeros_u256(v: U256) -> u32 {
    if v.hi() != 0 { v.hi().leading_zeros() } else { 128 + v.lo().leading_zeros() }
}

fn div_rem_u256(num: U256, den: U256) -> (U256, U256) {
    if den.is_zero() { panic!("U256 division by zero"); }
    if num.is_zero() { return (U256::ZERO, U256::ZERO); }
    if den > num { return (U256::ZERO, num); }
    if num.hi() == 0 && den.hi() == 0 {
        let q = num.lo() / den.lo();
        let r = num.lo() % den.lo();
        return (U256::from_u128(q), U256::from_u128(r));
    }

    let shift = leading_zeros_u256(den) - leading_zeros_u256(num);
    let mut remainder = num;
    let mut quotient = U256::ZERO;
    let mut divisor = den.shl(shift);

    let mut i = shift as i32;
    while i >= 0 {
        if remainder >= divisor {
            remainder = remainder.saturating_sub(divisor);
            quotient = quotient.bitor(U256::ONE.shl(i as u32));
        }
        divisor = divisor.shr(1);
        i -= 1;
    }
    (quotient, remainder)
}

// ============================================================================
// U512 - private intermediate for mul_div operations
// ============================================================================
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct U512([u128; 4]);

impl U512 {
    const ZERO: Self = Self([0, 0, 0, 0]);

    fn is_zero(&self) -> bool {
        self.0[0] == 0 && self.0[1] == 0 && self.0[2] == 0 && self.0[3] == 0
    }

    fn from_u256(v: U256) -> Self {
        Self([v.lo(), v.hi(), 0, 0])
    }

    fn mul_u256(a: U256, b: U256) -> Self {
        let a0 = a.lo();
        let a1 = a.hi();
        let b0 = b.lo();
        let b1 = b.hi();

        let (r0, c0) = widening_mul_u128(a0, b0);
        let (x1, x2) = widening_mul_u128(a0, b1);
        let (y1, y2) = widening_mul_u128(a1, b0);
        let (z2, z3) = widening_mul_u128(a1, b1);

        let (r1, carry1a) = c0.overflowing_add(x1);
        let (r1, carry1b) = r1.overflowing_add(y1);
        let carry1 = (carry1a as u128) + (carry1b as u128);

        let (r2, carry2a) = x2.overflowing_add(y2);
        let (r2, carry2b) = r2.overflowing_add(z2);
        let (r2, carry2c) = r2.overflowing_add(carry1);
        let carry2 = (carry2a as u128) + (carry2b as u128) + (carry2c as u128);

        let r3 = z3 + carry2;
        Self([r0, r1, r2, r3])
    }

    fn cmp_u512(&self, other: &Self) -> Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                Ordering::Equal => continue,
                ord => return ord,
            }
        }
        Ordering::Equal
    }

    fn shl_u512(self, bits: u32) -> Self {
        if bits >= 512 { return Self::ZERO; }
        if bits == 0 { return self; }
        let word_shift = (bits / 128) as usize;
        let bit_shift = bits % 128;
        let mut result = [0u128; 4];
        for i in word_shift..4 {
            result[i] = self.0[i - word_shift] << bit_shift;
            if bit_shift > 0 && i > word_shift {
                result[i] |= self.0[i - word_shift - 1] >> (128 - bit_shift);
            }
        }
        Self(result)
    }

    fn shr_u512(self, bits: u32) -> Self {
        if bits >= 512 { return Self::ZERO; }
        if bits == 0 { return self; }
        let word_shift = (bits / 128) as usize;
        let bit_shift = bits % 128;
        let mut result = [0u128; 4];
        for i in 0..(4 - word_shift) {
            result[i] = self.0[i + word_shift] >> bit_shift;
            if bit_shift > 0 && (i + word_shift + 1) < 4 {
                result[i] |= self.0[i + word_shift + 1] << (128 - bit_shift);
            }
        }
        Self(result)
    }

    fn sub_u512(self, rhs: Self) -> Self {
        let mut result = [0u128; 4];
        let mut borrow = false;
        for i in 0..4 {
            let (d1, b1) = self.0[i].overflowing_sub(rhs.0[i]);
            let (d2, b2) = d1.overflowing_sub(borrow as u128);
            result[i] = d2;
            borrow = b1 || b2;
        }
        Self(result)
    }

    fn set_bit(self, bit: u32) -> Self {
        if bit >= 512 { return self; }
        let word = (bit / 128) as usize;
        let b = bit % 128;
        let mut result = self.0;
        result[word] |= 1u128 << b;
        Self(result)
    }

    fn leading_zeros(&self) -> u32 {
        for i in (0..4).rev() {
            if self.0[i] != 0 {
                return (3 - i as u32) * 128 + self.0[i].leading_zeros();
            }
        }
        512
    }

    fn try_into_u256(self) -> Option<U256> {
        if self.0[2] != 0 || self.0[3] != 0 { None }
        else { Some(U256::new(self.0[0], self.0[1])) }
    }

    fn div_rem_by_u256(self, den: U256) -> (U256, U256) {
        match self.checked_div_rem_by_u256(den) {
            Some(result) => result,
            None => panic!("mul_div quotient must fit U256"),
        }
    }

    fn checked_div_rem_by_u256(self, den: U256) -> Option<(U256, U256)> {
        assert!(!den.is_zero(), "U512 division by zero");
        if self.is_zero() {
            return Some((U256::ZERO, U256::ZERO));
        }
        let den_512 = U512::from_u256(den);
        if self.cmp_u512(&den_512) == Ordering::Less {
            let r = self.try_into_u256().expect("remainder must fit U256");
            return Some((U256::ZERO, r));
        }
        let num_lz = self.leading_zeros();
        let den_lz = den_512.leading_zeros();
        if den_lz < num_lz {
            let r = self.try_into_u256().expect("remainder must fit U256");
            return Some((U256::ZERO, r));
        }

        let shift = den_lz - num_lz;
        let mut remainder = self;
        let mut quotient = U512::ZERO;
        let mut divisor = den_512.shl_u512(shift);

        let mut i = shift as i32;
        while i >= 0 {
            if remainder.cmp_u512(&divisor) != Ordering::Less {
                remainder = remainder.sub_u512(divisor);
                quotient = quotient.set_bit(i as u32);
            }
            divisor = divisor.shr_u512(1);
            i -= 1;
        }
        let q = quotient.try_into_u256()?;
        let r = remainder.try_into_u256().expect("remainder must fit U256");
        Some((q, r))
    }
}

// ============================================================================
// Spec section 4.6 helpers — PUBLIC API
// ============================================================================

/// floor(a * b / d) using U512 intermediate
pub fn mul_div_floor_u256(a: U256, b: U256, d: U256) -> U256 {
    assert!(!d.is_zero(), "mul_div_floor_u256: zero denominator");
    let product = U512::mul_u256(a, b);
    let (q, _r) = product.div_rem_by_u256(d);
    q
}

/// floor(a * b / d) with remainder
pub fn mul_div_floor_u256_with_rem(a: U256, b: U256, d: U256) -> (U256, U256) {
    assert!(!d.is_zero());
    let product = U512::mul_u256(a, b);
    product.div_rem_by_u256(d)
}

/// ceil(a * b / d) using U512 intermediate
pub fn mul_div_ceil_u256(a: U256, b: U256, d: U256) -> U256 {
    assert!(!d.is_zero());
    let product = U512::mul_u256(a, b);
    let (q, r) = product.div_rem_by_u256(d);
    if r.is_zero() { q } else { q.checked_add(U256::ONE).expect("mul_div_ceil overflow") }
}

/// ceil(n / d) for positive values
pub fn ceil_div_positive_checked(n: U256, d: U256) -> U256 {
    assert!(!d.is_zero());
    let (q, r) = div_rem_u256(n, d);
    if r.is_zero() { q } else { q.checked_add(U256::ONE).expect("ceil_div overflow") }
}

/// Native mul-div floor (product must fit u128)
pub fn mul_div_floor_u128(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0);
    let p = a.checked_mul(b).expect("mul_div_floor_u128: a*b overflow");
    p / d
}

/// Native mul-div ceil (product must fit u128)
pub fn mul_div_ceil_u128(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0);
    let p = a.checked_mul(b).expect("mul_div_ceil_u128: a*b overflow");
    let q = p / d;
    if p % d != 0 { q + 1 } else { q }
}

/// Wide mul-div floor using U256 intermediate (a*b may exceed u128)
pub fn wide_mul_div_floor_u128(a: u128, b: u128, d: u128) -> u128 {
    assert!(d > 0);
    let result = mul_div_floor_u256(U256::from_u128(a), U256::from_u128(b), U256::from_u128(d));
    result.try_into_u128().expect("wide_mul_div_floor_u128: result exceeds u128")
}

/// K-difference settlement with wide intermediate
pub fn wide_signed_mul_div_floor_from_k_pair(abs_basis: u128, k_now: i128, k_then: i128, den: u128) -> i128 {
    assert!(den > 0);
    let k_now_wide = I256::from_i128(k_now);
    let k_then_wide = I256::from_i128(k_then);
    let d = k_now_wide.checked_sub(k_then_wide).expect("K-diff overflow in wide");
    if d.is_zero() || abs_basis == 0 { return 0i128; }
    let abs_d = d.abs_u256();
    let abs_basis_u256 = U256::from_u128(abs_basis);
    let den_u256 = U256::from_u128(den);
    let p = abs_basis_u256.checked_mul(abs_d).expect("wide product overflow");
    let (q, rem) = div_rem_u256(p, den_u256);
    if d.is_negative() {
        let mag = if !rem.is_zero() {
            q.checked_add(U256::ONE).expect("mag overflow")
        } else { q };
        let mag_u128 = mag.try_into_u128().expect("mag exceeds u128");
        assert!(mag_u128 <= i128::MAX as u128);
        -(mag_u128 as i128)
    } else {
        let q_u128 = q.try_into_u128().expect("quotient exceeds u128");
        assert!(q_u128 <= i128::MAX as u128);
        q_u128 as i128
    }
}

/// ADL delta_K representability check error
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverI128Magnitude;

/// ADL delta_K representability check
pub fn wide_mul_div_ceil_u128_or_over_i128max(a: u128, b: u128, d: u128) -> core::result::Result<u128, OverI128Magnitude> {
    assert!(d > 0);
    let result = mul_div_ceil_u256(U256::from_u128(a), U256::from_u128(b), U256::from_u128(d));
    match result.try_into_u128() {
        Some(v) if v <= i128::MAX as u128 => Ok(v),
        _ => Err(OverI128Magnitude),
    }
}

/// Saturating multiply for warmup cap computation
pub fn saturating_mul_u128_u64(a: u128, b: u64) -> u128 {
    if a == 0 || b == 0 { return 0; }
    a.checked_mul(b as u128).unwrap_or(u128::MAX)
}

/// Fee debt: if fee_credits < 0, return unsigned debt; else 0
pub fn fee_debt_u128_checked(fee_credits: i128) -> u128 {
    if fee_credits < 0 { fee_credits.unsigned_abs() } else { 0 }
}

/// Checked u128 * i128 -> i128 (for mark-to-market delta_K)
/// C1 fix: Uses U256 wide multiply to avoid spurious rejection when a*|b| > u128::MAX
pub fn checked_u128_mul_i128(a: u128, b: i128) -> core::result::Result<i128, ()> {
    if a == 0 || b == 0 { return Ok(0); }
    if b == i128::MIN { return Err(()); } // explicit reject like reference
    let abs_b = b.unsigned_abs();
    let wide_a = U256::from_u128(a);
    let wide_b = U256::from_u128(abs_b);
    let product = wide_a.checked_mul(wide_b).ok_or(())?;
    match product.try_into_u128() {
        Some(v) if v <= i128::MAX as u128 => {
            if b < 0 { Ok(-(v as i128)) } else { Ok(v as i128) }
        }
        _ => Err(()),
    }
}
