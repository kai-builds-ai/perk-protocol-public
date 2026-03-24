/// BPF-Safe 128-bit Types — Ported from Percolator
///
/// Rust 1.77/1.78 changed i128/u128 alignment from 8 to 16 bytes on x86_64,
/// but BPF/SBF still uses 8-byte alignment. These wrappers ensure consistent
/// 8-byte alignment across all platforms.

use core::cmp::Ordering;

// ============================================================================
// I128 - BPF-safe signed 128-bit integer using [u64; 2]
// ============================================================================
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct I128([u64; 2]); // [lo, hi] little-endian

impl I128 {
    pub const ZERO: Self = Self([0, 0]);
    pub const MIN: Self = Self([0, 0x8000_0000_0000_0000]);
    pub const MAX: Self = Self([u64::MAX, 0x7FFF_FFFF_FFFF_FFFF]);

    #[inline]
    pub const fn new(val: i128) -> Self {
        Self([val as u64, (val >> 64) as u64])
    }

    #[inline]
    pub const fn get(self) -> i128 {
        ((self.0[1] as i128) << 64) | (self.0[0] as u128 as i128)
    }

    #[inline]
    pub fn set(&mut self, val: i128) {
        self.0[0] = val as u64;
        self.0[1] = (val >> 64) as u64;
    }

    #[inline]
    pub fn checked_add(self, rhs: i128) -> Option<Self> {
        self.get().checked_add(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_sub(self, rhs: i128) -> Option<Self> {
        self.get().checked_sub(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_mul(self, rhs: i128) -> Option<Self> {
        self.get().checked_mul(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_div(self, rhs: i128) -> Option<Self> {
        self.get().checked_div(rhs).map(Self::new)
    }

    #[inline]
    pub fn saturating_add(self, rhs: i128) -> Self {
        Self::new(self.get().saturating_add(rhs))
    }

    #[inline]
    pub fn saturating_add_i128(self, rhs: I128) -> Self {
        Self::new(self.get().saturating_add(rhs.get()))
    }

    #[inline]
    pub fn saturating_sub(self, rhs: i128) -> Self {
        Self::new(self.get().saturating_sub(rhs))
    }

    #[inline]
    pub fn saturating_sub_i128(self, rhs: I128) -> Self {
        Self::new(self.get().saturating_sub(rhs.get()))
    }

    #[inline]
    pub fn wrapping_add(self, rhs: i128) -> Self {
        Self::new(self.get().wrapping_add(rhs))
    }

    #[inline]
    pub fn abs(self) -> Self {
        Self::new(self.get().saturating_abs())
    }

    #[inline]
    pub fn unsigned_abs(self) -> u128 {
        self.get().unsigned_abs()
    }

    #[inline]
    pub fn is_zero(self) -> bool {
        self.0[0] == 0 && self.0[1] == 0
    }

    #[inline]
    pub fn is_negative(self) -> bool {
        (self.0[1] as i64) < 0
    }

    #[inline]
    pub fn is_positive(self) -> bool {
        !self.is_zero() && !self.is_negative()
    }
}

impl Default for I128 {
    fn default() -> Self {
        Self::ZERO
    }
}

impl core::fmt::Debug for I128 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "I128({})", self.get())
    }
}

impl core::fmt::Display for I128 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.get())
    }
}

impl From<i128> for I128 {
    fn from(val: i128) -> Self {
        Self::new(val)
    }
}

impl From<i64> for I128 {
    fn from(val: i64) -> Self {
        Self::new(val as i128)
    }
}

impl From<I128> for i128 {
    fn from(val: I128) -> Self {
        val.get()
    }
}

impl PartialOrd for I128 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for I128 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.get().cmp(&other.get())
    }
}

impl core::ops::Add<i128> for I128 {
    type Output = Self;
    fn add(self, rhs: i128) -> Self {
        Self::new(self.get().saturating_add(rhs))
    }
}

impl core::ops::Add<I128> for I128 {
    type Output = Self;
    fn add(self, rhs: I128) -> Self {
        Self::new(self.get().saturating_add(rhs.get()))
    }
}

impl core::ops::Sub<i128> for I128 {
    type Output = Self;
    fn sub(self, rhs: i128) -> Self {
        Self::new(self.get().saturating_sub(rhs))
    }
}

impl core::ops::Sub<I128> for I128 {
    type Output = Self;
    fn sub(self, rhs: I128) -> Self {
        Self::new(self.get().saturating_sub(rhs.get()))
    }
}

impl core::ops::Mul<i128> for I128 {
    type Output = Self;
    fn mul(self, rhs: i128) -> Self {
        Self::new(self.get().saturating_mul(rhs))
    }
}

impl core::ops::Neg for I128 {
    type Output = Self;
    fn neg(self) -> Self {
        Self::new(-self.get())
    }
}

impl core::ops::AddAssign<i128> for I128 {
    fn add_assign(&mut self, rhs: i128) {
        *self = *self + rhs;
    }
}

impl core::ops::SubAssign<i128> for I128 {
    fn sub_assign(&mut self, rhs: i128) {
        *self = *self - rhs;
    }
}

// ============================================================================
// U128 - BPF-safe unsigned 128-bit integer using [u64; 2]
// ============================================================================
#[repr(C)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct U128([u64; 2]); // [lo, hi] little-endian

impl U128 {
    pub const ZERO: Self = Self([0, 0]);
    pub const MAX: Self = Self([u64::MAX, u64::MAX]);

    #[inline]
    pub const fn new(val: u128) -> Self {
        Self([val as u64, (val >> 64) as u64])
    }

    #[inline]
    pub const fn get(self) -> u128 {
        ((self.0[1] as u128) << 64) | (self.0[0] as u128)
    }

    #[inline]
    pub fn set(&mut self, val: u128) {
        self.0[0] = val as u64;
        self.0[1] = (val >> 64) as u64;
    }

    #[inline]
    pub fn checked_add(self, rhs: u128) -> Option<Self> {
        self.get().checked_add(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_sub(self, rhs: u128) -> Option<Self> {
        self.get().checked_sub(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_mul(self, rhs: u128) -> Option<Self> {
        self.get().checked_mul(rhs).map(Self::new)
    }

    #[inline]
    pub fn checked_div(self, rhs: u128) -> Option<Self> {
        self.get().checked_div(rhs).map(Self::new)
    }

    #[inline]
    pub fn saturating_add(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_add(rhs))
    }

    #[inline]
    pub fn saturating_sub(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_sub(rhs))
    }

    #[inline]
    pub fn saturating_mul(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_mul(rhs))
    }

    #[inline]
    pub fn is_zero(self) -> bool {
        self.0[0] == 0 && self.0[1] == 0
    }
}

impl Default for U128 {
    fn default() -> Self {
        Self::ZERO
    }
}

impl core::fmt::Debug for U128 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "U128({})", self.get())
    }
}

impl core::fmt::Display for U128 {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "{}", self.get())
    }
}

impl From<u128> for U128 {
    fn from(val: u128) -> Self {
        Self::new(val)
    }
}

impl From<u64> for U128 {
    fn from(val: u64) -> Self {
        Self::new(val as u128)
    }
}

impl From<U128> for u128 {
    fn from(val: U128) -> Self {
        val.get()
    }
}

impl PartialOrd for U128 {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for U128 {
    fn cmp(&self, other: &Self) -> Ordering {
        self.get().cmp(&other.get())
    }
}

impl core::ops::Add<u128> for U128 {
    type Output = Self;
    fn add(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_add(rhs))
    }
}

impl core::ops::Add<U128> for U128 {
    type Output = Self;
    fn add(self, rhs: U128) -> Self {
        Self::new(self.get().saturating_add(rhs.get()))
    }
}

impl core::ops::Sub<u128> for U128 {
    type Output = Self;
    fn sub(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_sub(rhs))
    }
}

impl core::ops::Sub<U128> for U128 {
    type Output = Self;
    fn sub(self, rhs: U128) -> Self {
        Self::new(self.get().saturating_sub(rhs.get()))
    }
}

impl core::ops::Mul<u128> for U128 {
    type Output = Self;
    fn mul(self, rhs: u128) -> Self {
        Self::new(self.get().saturating_mul(rhs))
    }
}

impl core::ops::Div<u128> for U128 {
    type Output = Self;
    fn div(self, rhs: u128) -> Self {
        Self::new(self.get() / rhs)
    }
}

impl core::ops::AddAssign<u128> for U128 {
    fn add_assign(&mut self, rhs: u128) {
        *self = *self + rhs;
    }
}

impl core::ops::SubAssign<u128> for U128 {
    fn sub_assign(&mut self, rhs: u128) {
        *self = *self - rhs;
    }
}
