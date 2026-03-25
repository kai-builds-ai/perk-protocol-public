# Invariant & Formal Analysis — Round 2 (Fix Verification)

**Date:** 2025-03-25  
**Analyst:** Formal Verification Subagent  
**Scope:** Mathematical correctness of security fixes applied to Perk Protocol

---

## 1. Circuit Breaker Math

### Location: `update_perk_oracle.rs`, lines 93–107

```rust
let deviation = |price - old_ema|;
let deviation_bps = deviation.checked_mul(BPS_DENOMINATOR)? / old_ema;
require!(deviation_bps <= cb_bps as u64, ...);
```

### 1.1 Overflow Analysis: `deviation * BPS_DENOMINATOR`

**Bounds:**
- `price ∈ [1, MAX_ORACLE_PRICE]` where `MAX_ORACLE_PRICE = 1_000_000_000_000` (1×10¹²)
- `old_ema ∈ [1, MAX_ORACLE_PRICE]` (guarded by `old_ema > 0` check; capped to `MAX_ORACLE_PRICE` by EMA update)
- `BPS_DENOMINATOR = 10_000`

**Worst case:** `price = MAX_ORACLE_PRICE`, `old_ema = 1`
```
deviation = 1_000_000_000_000 - 1 = 999_999_999_999
deviation * BPS_DENOMINATOR = 999_999_999_999 × 10_000 = 9_999_999_999_990_000 ≈ 1.0×10¹⁶
u64::MAX = 18_446_744_073_709_551_615 ≈ 1.84×10¹⁹
```

**Result: 1.0×10¹⁶ < 1.84×10¹⁹. Safe. Factor of ~1,844× headroom.** ✅

The `checked_mul` returns `Err` on overflow rather than panicking, which is correct defensive programming even though overflow is unreachable.

### 1.2 Division by `old_ema` Safety

The guard `cb_bps > 0 && old_ema > 0` ensures division by zero is impossible. ✅

### 1.3 Circuit Breaker Skip When `old_ema = 0`

**First update path:** `oracle.ema_price == 0` → EMA set to `params.price` directly. The circuit breaker reads `old_ema` which was captured *before* the EMA update, so `old_ema = 0`. The condition `cb_bps > 0 && old_ema > 0` evaluates to `false`. Circuit breaker is correctly skipped. ✅

**Post-unfreeze path:** `freeze_perk_oracle` sets `oracle.ema_price = 0`. First post-unfreeze update follows the same path as first update — circuit breaker skipped. ✅

### 1.4 Edge Case: `old_ema = 1`

```
deviation_bps = (1_000_000_000_000 - 1) × 10_000 / 1 = 9_999_999_999_990_000 ≈ 1×10¹⁶
```

Any `cb_bps` value (u16, max = 65,535) would be far less than 1×10¹⁶, so the update would be **rejected**.

**Is this a problem?** No, for the following reasons:

1. `old_ema = 1` can only occur if the first-ever price submitted was `1` (1×10⁻⁶ in 6-decimal terms — essentially zero).
2. This represents a garbage initial state. The circuit breaker correctly prevents wild jumps from garbage.
3. **Recovery path exists:** Admin can freeze → set `circuit_breaker_deviation_bps = 0` → unfreeze → submit correct price → re-enable circuit breaker. The `update_oracle_config` instruction requires frozen state (M-02 fix), making this a safe administrative operation.

**Verdict: Correct by design.** ✅

---

## 2. Sliding Window Math

### Location: `update_perk_oracle.rs`, lines 110–148

### 2.1 Overflow Analysis: `window_diff * BPS_DENOMINATOR`

Identical bounds to §1.1. `window_ref_price` is set from `params.price` which is validated `<= MAX_ORACLE_PRICE`.

```
max product = (MAX_ORACLE_PRICE - 1) × 10_000 ≈ 1.0×10¹⁶ < u64::MAX ≈ 1.84×10¹⁹
```

**Safe.** `checked_mul` provides defense-in-depth. ✅

### 2.2 `window_max_bps` Overflow

```rust
let window_max_bps = (max_change_bps_val as u64).saturating_mul(WINDOW_BAND_MULTIPLIER);
```

- `max_change_bps_val` max = `MAX_PRICE_CHANGE_BPS = 9999` (u16)
- `WINDOW_BAND_MULTIPLIER = 3`
- Product = `9999 × 3 = 29_997`
- `u64::MAX = 18_446_744_073_709_551_615`

**29,997 trivially fits u64. No overflow possible.** Even with `saturating_mul`, the result is exact. ✅

### 2.3 Window Reference Initialization (First Update)

When `window_ref_price = 0` (read from `_reserved[11..19]` which is zero-initialized):

```rust
} else {
    // First update — initialize window reference
    oracle._reserved[RESERVED_OFFSET_WINDOW_REF_PRICE..+8].copy_from_slice(&params.price.to_le_bytes());
    oracle._reserved[RESERVED_OFFSET_WINDOW_REF_SLOT..+8].copy_from_slice(&clock.slot.to_le_bytes());
}
```

Correctly initializes reference to current price/slot without applying any band check. ✅

### 2.4 Freeze/Unfreeze Cycle — Window Reference Integrity

**Freeze handler** (`freeze_perk_oracle.rs`): Writes to `_reserved` offsets:
- `[0]`: unfreeze_pending flag
- `[3..11]`: pre_freeze_price

**Does NOT touch** `[11..19]` (window_ref_price) or `[19..27]` (window_ref_slot). ✅

**Post-unfreeze behavior:** Window reference retains its pre-freeze value. On the first post-unfreeze update:

1. `oracle.price` was zeroed by unfreeze → the price banding check uses `pre_freeze_price` as reference
2. Window sliding check: `slots_since = current_slot - window_ref_slot`. Since oracle was frozen for some time, `slots_since` will almost certainly exceed `CIRCUIT_BREAKER_WINDOW_SLOTS (50)`, causing window reset.
3. **Edge case:** If freeze+unfreeze+update all happen within 50 slots (~20 seconds), the window check would fire against the old reference. But the price banding check (which runs first) already constrains the new price to within `max_change_bps` of `pre_freeze_price`, so the window check provides additional (redundant) protection.

**Verdict: Window reference is not corrupted by freeze/unfreeze.** ✅

### 2.5 `_reserved` Range Verification (see §3 for full analysis)

No overlap with window fields. ✅

---

## 3. `_reserved` Layout Verification

### 3.1 Defined Layout (from `constants.rs`)

| Offset | Size | Field | Constant |
|--------|------|-------|----------|
| `[0]` | 1 byte | `unfreeze_pending` (u8) | `RESERVED_OFFSET_UNFREEZE_PENDING = 0` |
| `[1..3]` | 2 bytes | `max_price_change_bps` (u16 LE) | `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS = 1` |
| `[3..11]` | 8 bytes | `pre_freeze_price` (u64 LE) | `RESERVED_OFFSET_PRE_FREEZE_PRICE = 3` |
| `[11..19]` | 8 bytes | `window_ref_price` (u64 LE) | `RESERVED_OFFSET_WINDOW_REF_PRICE = 11` |
| `[19..27]` | 8 bytes | `window_ref_slot` (u64 LE) | `RESERVED_OFFSET_WINDOW_REF_SLOT = 19` |
| `[27..29]` | 2 bytes | `circuit_breaker_deviation_bps` (u16 LE) | `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS = 27` |
| `[29..64]` | 35 bytes | unused | — |

### 3.2 Overlap Check

```
Field 1: [0, 1)     — ends at byte 1
Field 2: [1, 3)     — starts at 1, ends at 3. No overlap with [0,1). ✓
Field 3: [3, 11)    — starts at 3, ends at 11. No overlap with [1,3). ✓
Field 4: [11, 19)   — starts at 11, ends at 19. No overlap with [3,11). ✓
Field 5: [19, 27)   — starts at 19, ends at 27. No overlap with [11,19). ✓
Field 6: [27, 29)   — starts at 27, ends at 29. No overlap with [19,27). ✓
Unused:  [29, 64)   — no overlap with [27,29). ✓
```

**All ranges are contiguous and non-overlapping. Total used: 29 bytes of 64.** ✅

### 3.3 Per-File Constant Usage Audit

| File | Offsets Used | Uses Constants? | Hardcoded Indices? |
|------|-------------|----------------|-------------------|
| `initialize_perk_oracle.rs` | `[1..3]`, `[27..29]` | ✅ `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS`, `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS` | None |
| `freeze_perk_oracle.rs` | `[3..11]`, `[0]` | ✅ `RESERVED_OFFSET_PRE_FREEZE_PRICE`, `RESERVED_OFFSET_UNFREEZE_PENDING` | None |
| `update_perk_oracle.rs` | `[0]`, `[1..3]`, `[3..11]`, `[11..19]`, `[19..27]`, `[27..29]` | ✅ All via `RESERVED_OFFSET_*` constants | None |
| `update_oracle_config.rs` | `[1..3]`, `[27..29]` | ✅ `RESERVED_OFFSET_MAX_PRICE_CHANGE_BPS`, `RESERVED_OFFSET_CIRCUIT_BREAKER_BPS` | None |

**All accesses use named constants. No hardcoded byte indices found.** ✅

---

## 4. Insurance Buffer Math

### Location: `engine/risk.rs`, `use_insurance_buffer`

```rust
let dynamic_floor = max(insurance_floor, ins_bal / 5);        // 20% dynamic floor
let available = ins_bal.saturating_sub(dynamic_floor);
let epoch_cap = (ins_bal * INSURANCE_EPOCH_CAP_BPS as u128) / 10_000;  // 30%
let epoch_remaining = epoch_cap.saturating_sub(insurance_epoch_payout as u128);
let capped_available = min(available, epoch_remaining);
let pay = min(loss, capped_available);
```

### 4.1 Zero Balance Case

```
ins_bal = 0
dynamic_floor = max(insurance_floor, 0/5) = max(insurance_floor, 0)
  If insurance_floor = 0: dynamic_floor = 0
available = 0.saturating_sub(0) = 0
epoch_cap = (0 * 3000) / 10000 = 0
epoch_remaining = 0.saturating_sub(payout) = 0
capped_available = min(0, 0) = 0
pay = min(loss, 0) = 0
```

**Correct: zero balance → zero payout.** ✅

### 4.2 Normal Case (ins_bal = 100, insurance_floor = 10)

```
dynamic_floor = max(10, 100/5) = max(10, 20) = 20
available = 100 - 20 = 80
epoch_cap = (100 * 3000) / 10000 = 30
epoch_remaining = 30 - payout
capped_available = min(80, 30 - payout)
pay = min(loss, min(80, 30 - payout))
```

The epoch cap (30%) is the binding constraint since 30 < 80. **Correct.** ✅

### 4.3 Overflow Analysis: `ins_bal * INSURANCE_EPOCH_CAP_BPS`

```
ins_bal: u128 (cast from u64, so max = u64::MAX ≈ 1.844×10¹⁹)
INSURANCE_EPOCH_CAP_BPS: u16 = 3000
Product max: 1.844×10¹⁹ × 3000 = 5.532×10²²
u128::MAX ≈ 3.403×10³⁸
```

**5.53×10²² < 3.40×10³⁸. Factor of ~6.15×10¹⁵ headroom. Safe.** ✅

### 4.4 Convergence Proof: Insurance Fund Never Reaches Zero

**Theorem:** Under the current parameter set, the insurance fund balance `B(n)` after `n` epochs satisfies `B(n) > 0` for all finite `n`, given `B(0) > 0`.

**Proof:**

Let `B(n)` = balance at epoch `n`. In the worst case (maximum drainage every epoch):

The effective cap per epoch is `min(available, epoch_cap)`:
- `available = B(n) - max(floor, B(n)/5)` = `B(n) - B(n)/5` = `4·B(n)/5` (assuming dynamic floor dominates)
- `epoch_cap = 3·B(n)/10`
- Binding constraint: `min(4·B(n)/5, 3·B(n)/10)` = `3·B(n)/10` (since 0.3 < 0.8)

So max drain per epoch = `3·B(n)/10`, giving:

```
B(n+1) ≥ B(n) - 3·B(n)/10 = 7·B(n)/10
```

**Recurrence:** `B(n) ≥ B(0) × (7/10)ⁿ`

This is a geometric decay with ratio 0.7. In continuous math, `lim_{n→∞} B(n) = 0` but never reaches 0.

**In integer arithmetic:** Eventually `3 × B(n) / 10 = 0` when `B(n) < 4` (integer division). At that point, `epoch_cap = 0` and no further drainage is possible. Combined with the dynamic floor (`B(n)/5`), the minimum non-drainable balance is:

```
When B(n) ≤ 3: epoch_cap = 0 → no payout possible
When B(n) = 4: epoch_cap = 1, available = 3, pay ≤ 1. B(n+1) ≥ 3. Next epoch: epoch_cap = 0.
```

**The fund converges to a non-zero minimum ≥ 3 lamports (in base units).** ✅

**Drain time estimate:** Starting from balance `B₀`:
- After `n` epochs at max drain: `B(n) ≈ B₀ × 0.7ⁿ`
- To reach `B(n) < 4`: `n > log(B₀/4) / log(10/7) ≈ 2.8 × log₁₀(B₀/4)`
- For `B₀ = 1 SOL = 10⁹ lamports`: `n > 2.8 × log₁₀(2.5×10⁸) ≈ 2.8 × 8.4 ≈ 24 epochs = 24 days`

This means a sustained 100%-loss attack against the insurance fund would take ~24 days of maximum payouts to exhaust a 1 SOL fund — and the fund would still never truly reach zero. ✅

---

## 5. TWAP Cap Math

### Assessment

The TWAP cap logic (`max_twap_weight = market.k / 10`, `accumulator += mark_price * capped_weight`) **is not present in any of the provided source files**. This feature may exist in a file not included in the review scope (e.g., `crank_funding.rs`, `update_amm.rs`, or a TWAP module).

**Cannot verify — out of scope.** ⚠️

For completeness, the theoretical analysis:
- `mark_price` max = `MAX_ORACLE_PRICE = 10¹²`
- `k` = `base_reserve × quote_reserve` (u128). With `MIN_INITIAL_K = 10¹⁸`, `max_twap_weight = k/10`.
- If `k` reaches practical maximum (say `10³⁶`), then `max_twap_weight = 10³⁵`.
- `mark_price × capped_weight = 10¹² × 10³⁵ = 10⁴⁷`
- `u128::MAX ≈ 3.4×10³⁸`

**This WOULD overflow u128 if k is large.** The accumulator must use u128 or wider arithmetic, and k bounds must be enforced. This requires verification in the actual source.

---

## 6. Liquidation Freshness

### Location: `liquidate.rs`, lines 74–77

```rust
const MAX_LIQUIDATION_ORACLE_AGE: i64 = 5;
let oracle_age = clock.unix_timestamp.saturating_sub(oracle_result.timestamp);
require!(oracle_age <= MAX_LIQUIDATION_ORACLE_AGE, PerkError::OracleStale);
```

### 6.1 Future Timestamp Analysis

If `oracle_result.timestamp > clock.unix_timestamp`:
- `saturating_sub` returns `0`
- `0 <= 5` passes

**Is this safe?** Yes, because:

1. **Pyth oracle reader** (`read_pyth_price`): checks `age >= 0` where `age = current_time - msg.publish_time`. If future, `age < 0` which fails `age >= 0`. Rejected. ✅
2. **PerkOracle reader** (`read_perk_oracle_price`): checks `age >= 0` where `age = current_time.saturating_sub(oracle.timestamp)`. Wait — `saturating_sub` returns 0 for future timestamps, so `age = 0 >= 0` passes.

**However**, the PerkOracle reader also has:
```rust
require!(age <= oracle.max_staleness_seconds as i64, PerkError::OracleStale);
```
A future timestamp gives `age = 0` which passes staleness. But the PerkOracle update handler validates `clock.slot > oracle.last_slot` and uses `clock.unix_timestamp` directly, so the oracle timestamp is always ≤ the cluster time at write. A future timestamp would require a cluster time regression, which is not possible under Solana's consensus.

**Verdict: Safe due to upstream rejection (Pyth) and cluster monotonicity (PerkOracle).** ✅

### 6.2 Freshness Applies to Both Primary and Fallback

```rust
let oracle_result = oracle::read_oracle_price_with_fallback(
    &market.oracle_source, &ctx.accounts.oracle.to_account_info(),
    &market.fallback_oracle_source, &ctx.accounts.fallback_oracle.to_account_info(),
    &market.fallback_oracle_address, clock.unix_timestamp,
)?;
// ... later ...
let oracle_age = clock.unix_timestamp.saturating_sub(oracle_result.timestamp);
require!(oracle_age <= MAX_LIQUIDATION_ORACLE_AGE, PerkError::OracleStale);
```

`read_oracle_price_with_fallback` returns an `OraclePrice` from whichever source succeeded. The `oracle_result.timestamp` reflects the actual price source used. The 5-second freshness check applies to this timestamp regardless of whether it came from primary or fallback.

**Both oracles also have their own staleness check** (`max_staleness_seconds` for PerkOracle, `MAX_STALENESS = 15s` for Pyth), but the liquidation handler enforces the stricter 5-second bound on top.

**Verified: Freshness check applies uniformly.** ✅

---

## 7. `update_oracle_config` Option Fields

### Location: `update_oracle_config.rs`

### 7.1 Borsh Serialization Correctness

```rust
pub struct UpdateOracleConfigParams {
    pub max_price_change_bps: Option<u16>,      // 1 + 2 bytes
    pub min_sources: Option<u8>,                 // 1 + 1 bytes
    pub max_staleness_seconds: Option<u32>,      // 1 + 4 bytes
    pub circuit_breaker_deviation_bps: Option<u16>,  // 1 + 2 bytes
}
```

Borsh `Option<T>` encoding: `0x00` for `None`, `0x01 || T_bytes` for `Some(T)`. Each field is independently encoded in sequence. Standard Borsh — no ambiguity. ✅

### 7.2 Independent Updatability

Each field uses an independent `if let Some(val) = params.field_name { ... }` block:

```rust
if let Some(max_price_change_bps) = params.max_price_change_bps { /* only writes _reserved[1..3] */ }
if let Some(min_sources) = params.min_sources { /* only writes oracle.min_sources */ }
if let Some(max_staleness_seconds) = params.max_staleness_seconds { /* only writes oracle.max_staleness_seconds */ }
if let Some(circuit_breaker_deviation_bps) = params.circuit_breaker_deviation_bps { /* only writes _reserved[27..29] */ }
```

No shared state between blocks. Setting one field does not read or write any other field. ✅

### 7.3 Validation Parity with `initialize_perk_oracle`

| Field | Init Validation | Config Validation | Match? |
|-------|----------------|-------------------|--------|
| `max_price_change_bps` | `== 0 \|\| >= MIN_PRICE_CHANGE_BPS (100)`, `<= MAX_PRICE_CHANGE_BPS (9999)` | Same | ✅ |
| `min_sources` | `>= 1`, `<= MAX_MIN_SOURCES (10)` | Same | ✅ |
| `max_staleness_seconds` | `>= MIN_ORACLE_STALENESS_SECONDS (5)`, `<= MAX_ORACLE_STALENESS_SECONDS (300)` | Same | ✅ |
| `circuit_breaker_deviation_bps` | **None** (stored directly) | **None** (stored directly) | ✅ (consistent) |

**Note:** Neither `initialize_perk_oracle` nor `update_oracle_config` validates `circuit_breaker_deviation_bps`. Since it's a u16 (max 65,535 = 655.35%), all values are semantically valid:
- `0` = disabled
- Any positive value = maximum allowed deviation from EMA in bps
- Very large values (e.g., 65535) effectively disable the check by allowing 655% deviation

This is consistent and acceptable — admin has full control, and the oracle must be frozen to change config. ✅

---

## Findings

### [INV-01] TWAP Accumulator Potential u128 Overflow

**Type:** Unverified — Out of Scope  
**Severity:** Medium (potential)

The TWAP cap math (`max_twap_weight = market.k / 10`, `accumulator += mark_price * capped_weight`) was not found in any of the 8 reviewed source files. Theoretical analysis suggests that if `k` grows large (e.g., 10³⁶), the product `mark_price × capped_weight` could reach 10⁴⁷, overflowing u128. **The actual implementation must be reviewed in the file containing TWAP logic** (likely `crank_funding.rs` or `update_amm.rs`).

**Recommendation:** Locate and review the TWAP accumulator code. Ensure it uses checked/wide arithmetic or that `k` is bounded such that `MAX_ORACLE_PRICE × (k / 10) ≤ u128::MAX`.

### [INV-02] PerkOracle Future Timestamp Passes `saturating_sub` Check

**Type:** Informational  
**Severity:** Low (theoretical only)

In `read_perk_oracle_price`, `age = current_time.saturating_sub(oracle.timestamp)` returns 0 for future timestamps, which passes the `age >= 0` check. Unlike the Pyth reader (which uses signed subtraction), the PerkOracle reader cannot reject future timestamps via its staleness check alone.

**Mitigating factors:**
1. PerkOracle timestamps are set from `Clock::get()?.unix_timestamp` in the update handler, which is monotonically non-decreasing per Solana consensus.
2. A future timestamp would require a cluster time regression — a consensus-level failure.
3. The update handler's `clock.slot > oracle.last_slot` provides an independent monotonicity guarantee.

**Risk: Negligible.** No action required, but adding an explicit `oracle.timestamp <= current_time` check would provide defense-in-depth.

### [INV-03] No Validation Bounds on `circuit_breaker_deviation_bps`

**Type:** Informational  
**Severity:** Low

Neither `initialize_perk_oracle` nor `update_oracle_config` validates the `circuit_breaker_deviation_bps` field beyond its u16 type constraint. While all u16 values produce semantically valid behavior (0 = disabled, any positive = enabled), there is no `MIN_CIRCUIT_BREAKER_BPS` or `MAX_CIRCUIT_BREAKER_BPS` bound.

Setting `cb_bps = 1` (0.01%) would reject nearly all legitimate updates. Recovery requires admin freeze → config update → unfreeze, which is a valid recovery path.

**Risk: Low — admin-only, requires frozen oracle, recovery path exists.** Consider adding bounds (e.g., 50–10000 bps) for consistency with other validated fields.

### [INV-04] All Core Math Verified Safe

**Type:** Positive Finding  
**Severity:** N/A

All arithmetic operations in the reviewed fixes have been formally verified:

| Operation | Max Value | Type Max | Headroom Factor |
|-----------|-----------|----------|----------------|
| `deviation × BPS_DENOM` | 1.0×10¹⁶ | u64: 1.84×10¹⁹ | 1,844× |
| `window_diff × BPS_DENOM` | 1.0×10¹⁶ | u64: 1.84×10¹⁹ | 1,844× |
| `max_change_bps × WINDOW_BAND_MULTIPLIER` | 29,997 | u64: 1.84×10¹⁹ | 6.1×10¹⁴× |
| `ins_bal × EPOCH_CAP_BPS` | 5.53×10²² | u128: 3.40×10³⁸ | 6.15×10¹⁵× |

All `checked_mul` / `saturating_mul` calls provide correct defense-in-depth even though overflow is unreachable under the validated input bounds.

### [INV-05] Insurance Fund Geometric Convergence Verified

**Type:** Positive Finding  
**Severity:** N/A

The insurance fund satisfies the convergence property: `B(n) ≥ B(0) × 0.7ⁿ` under maximum sustained drain. In integer arithmetic, the fund converges to a non-zero minimum of ≥ 3 base units. A 1 SOL fund under sustained maximum attack would take ~24 daily epochs to approach this minimum. The combination of 20% dynamic floor + 30% epoch cap provides robust survivability.

### [INV-06] `_reserved` Layout Integrity Verified

**Type:** Positive Finding  
**Severity:** N/A

All 4 instruction files that access `_reserved` use the centralized `RESERVED_OFFSET_*` constants from `constants.rs`. No hardcoded byte indices were found. All byte ranges are contiguous, non-overlapping, and fit within the 64-byte allocation with 35 bytes of unused space remaining for future extensions.

---

## Summary

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| INV-01 | TWAP Accumulator Potential Overflow | Medium (unverified) | Needs review in TWAP source file |
| INV-02 | PerkOracle Future Timestamp Edge Case | Low (theoretical) | Mitigated by consensus monotonicity |
| INV-03 | No Bounds on `circuit_breaker_deviation_bps` | Low | Consider adding min/max bounds |
| INV-04 | Core Math Verified Safe | ✅ Positive | All operations proven within bounds |
| INV-05 | Insurance Convergence Verified | ✅ Positive | Fund cannot reach zero |
| INV-06 | `_reserved` Layout Verified | ✅ Positive | No overlaps, all use constants |

**Overall Assessment:** The security fixes are mathematically sound. All arithmetic operations are proven safe within the protocol's normative bounds. The `_reserved` field layout is clean and consistently accessed. The insurance buffer provides provable convergence guarantees. One out-of-scope item (TWAP accumulator) requires separate review.
