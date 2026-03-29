# PerkOracle Invariant & Formal Analysis (Round 1)

**Date:** 2026-03-25
**Analyst:** Kai (Formal Verification Subagent)
**Scope:** PerkOraclePrice state machine, mathematical correctness, overflow analysis, reserved field layout, and risk engine integration.

---

## 1. State Invariants

### INV-01: Post-Initialization Invariants

After `initialize_perk_oracle`, ALL of the following hold:

| Invariant | Proof (from initialize_perk_oracle.rs) |
|-----------|----------------------------------------|
| `price == 0` | Line: `oracle.price = 0;` |
| `ema_price == 0` | Line: `oracle.ema_price = 0;` |
| `timestamp == 0` | Line: `oracle.timestamp = 0;` |
| `is_frozen == false` | Line: `oracle.is_frozen = false;` |
| `total_updates == 0` | Line: `oracle.total_updates = 0;` |
| `num_sources == 0` | Line: `oracle.num_sources = 0;` |
| `last_slot == 0` | Line: `oracle.last_slot = 0;` |
| `min_sources ∈ [1, MAX_MIN_SOURCES=10]` | Validated by require! checks |
| `max_staleness ∈ [5, 300]` | Validated by require! checks |
| `_reserved[0] == 0` (unfreeze_pending = false) | Line: `oracle._reserved = [0u8; 64];` |
| `_reserved[1..3] == max_price_change_bps (LE)` | Written after zeroing |
| `_reserved[3..64] == 0` | From zero-init, only [1..3] overwritten |
| `max_price_change_bps == 0 ∨ max_price_change_bps ∈ [100, 9999]` | Validated by require! checks |

**Proof of maintenance:** These are set exactly once during initialization. No other instruction modifies `min_sources`, `max_staleness_seconds`, `created_at`, `token_mint`, or `bump` after init.

### INV-02: Post-Update Invariants

After every successful `update_perk_oracle`:

| Invariant | Proof |
|-----------|-------|
| `0 < price ≤ MAX_ORACLE_PRICE (1e12)` | `require!(params.price > 0)` and `require!(params.price <= MAX_ORACLE_PRICE)` |
| `num_sources ≥ min_sources` | `require!(params.num_sources >= oracle.min_sources)` |
| `timestamp == Clock::unix_timestamp` | Assignment at end of handler |
| `last_slot == Clock::slot` | Assignment at end of handler |
| `ema_price ≤ MAX_ORACLE_PRICE` | M-01 fix: `raw_ema.min(MAX_ORACLE_PRICE)` |
| `total_updates ≤ u64::MAX` | `saturating_add(1)` — saturates, never overflows |
| `_reserved[0] == 0` | Cleared unconditionally if was 1; no-op if already 0 |
| `is_frozen == false` | Precondition: `require!(!oracle.is_frozen)` |
| `Clock::slot > old_last_slot` | Rate limit check ensures monotonic slot progression |

### INV-03: Post-Freeze Invariants

After `freeze_perk_oracle(frozen=true)`:

| Invariant | Proof |
|-----------|-------|
| `is_frozen == true` | `oracle.is_frozen = frozen;` where `frozen=true` |
| All other fields unchanged | Handler only sets `is_frozen` when `frozen=true` |

### INV-04: Post-Unfreeze Invariants

After `freeze_perk_oracle(frozen=false)`:

| Invariant | Proof |
|-----------|-------|
| `is_frozen == false` | `oracle.is_frozen = frozen;` where `frozen=false` |
| `price == 0` | `oracle.price = 0;` |
| `ema_price == 0` | `oracle.ema_price = 0;` |
| `_reserved[0] == 1` (unfreeze_pending) | `oracle._reserved[0] = 1;` |
| `_reserved[3..11] == old_price (LE)` | C-01 fix: stored before zeroing |
| `read_perk_oracle_price will reject` | price=0 fails `require!(oracle.price > 0)` |

### INV-05: Authority Transfer Invariants

After `transfer_oracle_authority`:

| Invariant | Proof |
|-----------|-------|
| `authority == new_authority` | Only field modified |
| All price/state fields unchanged | Handler only touches `authority` |

### INV-06: Cross-Instruction Invariant: Oracle Unusable While Frozen

**Claim:** No instruction can read a frozen oracle's price.

**Proof:** `read_perk_oracle_price` checks `require!(!oracle.is_frozen, PerkError::OracleFrozen)` BEFORE any price access. All consumer paths (open_position, close_position, liquidate) call `read_oracle_price_with_fallback` which calls `read_oracle_price` → `read_perk_oracle_price`. The error propagates via `?`. ∎

### INV-07: Cross-Instruction Invariant: Oracle Unusable After Unfreeze Until Update

**Claim:** After unfreeze, the oracle is unusable until a cranker posts a fresh update.

**Proof:** Unfreeze sets `price = 0`. `read_perk_oracle_price` checks `require!(oracle.price > 0)`. Therefore reads fail. The first `update_perk_oracle` call sets `price > 0` (precondition), re-enabling reads. ∎

---

## 2. Mathematical Correctness

### 2.1 EMA Computation

**Formula:** `ema = (price + 9 × old_ema) / 10`

**Code:**
```rust
let raw_ema = params.price
    .saturating_add(oracle.ema_price.saturating_mul(9))
    / 10;
oracle.ema_price = raw_ema.min(MAX_ORACLE_PRICE);
```

**Overflow analysis:**
- `price_max = MAX_ORACLE_PRICE = 1_000_000_000_000 (1e12)`
- `old_ema_max = MAX_ORACLE_PRICE = 1e12` (invariant INV-02, M-01 cap)
- `9 × old_ema_max = 9 × 1e12 = 9e12`
- `price_max + 9 × old_ema_max = 1e12 + 9e12 = 1e13`
- `u64::MAX = 18,446,744,073,709,551,615 ≈ 1.84e19`
- `1e13 ≪ 1.84e19` → **saturating_mul and saturating_add will NEVER saturate**

**Proof:** For all valid inputs (`0 < price ≤ 1e12`, `0 ≤ ema ≤ 1e12`):
- `9 × ema ≤ 9e12 < u64::MAX` ✓
- `price + 9 × ema ≤ 1e13 < u64::MAX` ✓
- `raw_ema = 1e13 / 10 = 1e12 = MAX_ORACLE_PRICE` ✓
- `.min(MAX_ORACLE_PRICE)` is a no-op in the worst case ✓

**First update case:** When `ema_price == 0`, EMA is set directly to `params.price`. Valid since `0 < price ≤ MAX_ORACLE_PRICE`. ✓

**Verdict:** ✅ Mathematically correct. No overflow possible within valid bounds.

### 2.2 Price Banding

**Formula:** `change_bps = diff × BPS_DENOMINATOR / reference_price`

**Code:**
```rust
let change_bps = diff
    .checked_mul(BPS_DENOMINATOR)
    .ok_or(PerkError::MathOverflow)?
    / reference_price;
require!(change_bps <= max_change_bps as u64, PerkError::OraclePriceInvalid);
```

**Overflow analysis:**
- `diff_max = MAX_ORACLE_PRICE = 1e12` (both prices bounded by MAX_ORACLE_PRICE)
- `BPS_DENOMINATOR = 10_000`
- `diff × BPS_DENOMINATOR max = 1e12 × 10_000 = 1e16`
- `u64::MAX ≈ 1.84e19`
- `1e16 < 1.84e19` → **checked_mul will never overflow** for valid inputs ✓

**Truncation analysis:**
Integer division truncates toward zero. The maximum accepted price change is:

```
actual_max_change = (max_change_bps + 1) × reference_price / BPS_DENOMINATOR - 1
```

For reference_price = 1,000,000 (=$1.00) and max_change_bps = 500 (5%):
- Exact 5% = 50,000
- Truncation allows up to: diff = 50,099 → `50,099 × 10,000 / 1,000,000 = 500` → passes
- diff = 50,100 → `50,100 × 10,000 / 1,000,000 = 501` → rejected

**Maximum error:** < 1 bps of the reference price. For `ref=1e12, max_bps=500`: error < $0.01. Negligible. ✓

**Edge case — very small reference price:**
- `reference_price = 1` (= $0.000001): `diff = 1 → change_bps = 10,000` → always rejected unless max_bps ≥ 10,000 (impossible, max is 9999)
- This means for the smallest representable price, ANY change is rejected when banding is enabled
- **See finding INV-08 below**

**Verdict:** ✅ Correct for normal price ranges. Edge case documented in INV-08.

### 2.3 Confidence Validation (2% Check)

**Formula:** `max_conf = price × ORACLE_CONFIDENCE_BPS / BPS_DENOMINATOR`

Where `ORACLE_CONFIDENCE_BPS = 200`, `BPS_DENOMINATOR = 10_000`.

**Effective check:** `confidence ≤ price × 200 / 10_000 = price / 50`

**Overflow analysis:**
- `price_max × 200 = 1e12 × 200 = 2e14`
- `u64::MAX ≈ 1.84e19`
- `2e14 < 1.84e19` → checked_mul won't overflow ✓
- `/ BPS_DENOMINATOR (10_000)` → always safe ✓

**Truncation analysis:**
For `price = 49`: `max_conf = 49 × 200 / 10_000 = 9,800 / 10_000 = 0`
→ Any confidence > 0 is rejected. Tokens priced below $0.00005 effectively require confidence = 0.

For `price = 50`: `max_conf = 50 × 200 / 10_000 = 1`
→ Confidence must be ≤ 1 (i.e., ≤ $0.000001).

**Verdict:** ✅ Mathematically sound. The 2% band is correctly computed. Truncation at very low prices is conservative (rejects rather than accepts), which is the correct safety direction.

### 2.4 Pyth Price Scaling

**Formula:** `scaled = raw_price × 10^(expo + 6)` (for positive shift) or `raw_price / 10^(-(expo + 6))` (for negative shift)

**Code uses `checked_pow`, `checked_mul`, `checked_div` throughout.**

**Analysis by exponent range:**

| Exponent | Shift | Operation | Example | Risk |
|----------|-------|-----------|---------|------|
| `-8` (SOL, BTC) | `-2` | `÷ 100` | `15032000000 / 100 = 150_320_000` | None |
| `-6` (some tokens) | `0` | identity | `1500000 → 1500000` | None |
| `-4` (rare) | `+2` | `× 100` | `1 × 100 = 100` | None |
| `0` (theoretical) | `+6` | `× 1e6` | `67000 × 1e6 = 6.7e10` | ✓ fits u64 |
| `-12` | `-6` | `÷ 1e6` | Precision loss → 0 | Caught by `require!(price_scaled > 0)` |
| `> 13` | `> 19` | `× 10^19+` | `10^19 > u64::MAX` | Caught by `checked_pow`/`checked_mul` returning None |
| `< -18` | `< -12` | `÷ 10^12+` | Most prices → 0 | Caught by `require!(price_scaled > 0)` |

**Edge cases handled:**
- `expo + PRICE_DECIMALS` overflows i32: caught by `checked_add` ✓
- `10^shift` overflows u64: caught by `checked_pow` ✓
- `price × factor` overflows u64: caught by `checked_mul` ✓
- Result rounds to 0: caught by `require!(price_scaled > 0)` ✓

**Verdict:** ✅ Handles all exponent ranges correctly with proper checked arithmetic.

---

## 3. _reserved Field Map

### Layout

```
Byte Index | Usage                     | Type  | Endianness | Written By           | Read By
-----------+---------------------------+-------+------------+----------------------+------------------
[0]        | unfreeze_pending flag      | u8    | N/A        | freeze(unfreeze)     | update_perk_oracle
[1..3]     | max_price_change_bps       | u16   | LE         | initialize           | update_perk_oracle
[3..11]    | pre-freeze reference price | u64   | LE         | freeze(unfreeze)     | update_perk_oracle
[11..64]   | UNUSED (53 bytes)          | -     | -          | Never (zeroed@init)  | Never
```

### Overlap Verification

- `[0]` = 1 byte at index 0
- `[1..3]` = 2 bytes at indices 1, 2
- `[3..11]` = 8 bytes at indices 3, 4, 5, 6, 7, 8, 9, 10

**No overlaps.** Each range occupies distinct byte positions. ✓

### Endianness Consistency

All multi-byte fields use **little-endian** encoding:
- `max_price_change_bps`: Written with `to_le_bytes()`, read with `u16::from_le_bytes()` ✓
- `pre-freeze price`: Written with `to_le_bytes()`, read with `u64::from_le_bytes()` ✓

### Read/Write Path Agreement

**`_reserved[0]` (unfreeze_pending):**
- **Write:** `freeze_perk_oracle` sets to `1` on unfreeze path
- **Read:** `update_perk_oracle` reads `oracle._reserved[0] == 1`
- **Clear:** `update_perk_oracle` sets to `0` after use
- **Init:** Zeroed by `[0u8; 64]` initialization
- Agreement: ✓

**`_reserved[1..3]` (max_price_change_bps):**
- **Write:** `initialize_perk_oracle`: `oracle._reserved[1] = bps_bytes[0]; oracle._reserved[2] = bps_bytes[1];`
- **Read:** `update_perk_oracle`: `u16::from_le_bytes([oracle._reserved[1], oracle._reserved[2]])`
- **Never modified after init** (no `update_oracle_config` instruction exists)
- Agreement: ✓

**`_reserved[3..11]` (pre-freeze reference price):**
- **Write:** `freeze_perk_oracle` (unfreeze): `oracle._reserved[3..11].copy_from_slice(&pre_freeze_bytes)`
- **Read:** `update_perk_oracle`: `oracle._reserved[3..11].try_into().unwrap_or([0u8; 8])`
- Agreement: ✓

### Unused Bytes Verification

Bytes `[11..64]` (53 bytes):
- Zeroed at initialization: `oracle._reserved = [0u8; 64]` ✓
- Never written by any instruction after init ✓
- Never read by any instruction ✓

**Verdict:** ✅ Clean layout, no overlaps, consistent endianness, all paths agree.

---

## 4. State Machine

### State Diagram

```
                    initialize_perk_oracle
  [Uninitialized] ───────────────────────────→ [Initialized]
                                                  │  price=0
                                                  │  is_frozen=false
                                                  │  timestamp=0
                                                  │
                                        update_perk_oracle (first)
                                                  │
                                                  ▼
                                              [Active]
                                              price>0  ◄────────┐
                                              is_frozen=false    │
                                                  │              │
                                    freeze(true)  │              │ update_perk_oracle
                                                  │              │ (subsequent)
                                                  ▼              │
                                              [Frozen]           │
                                              is_frozen=true     │
                                                  │              │
                                   freeze(false)  │              │
                                                  │              │
                                                  ▼              │
                                              [Unfrozen]         │
                                              price=0            │
                                              is_frozen=false    │
                                              _reserved[0]=1     │
                                                  │              │
                                        update_perk_oracle       │
                                        (with bypass)            │
                                                  └──────────────┘
```

### Transition Verification

| From | To | Trigger | Valid? | Proof |
|------|----|---------|--------|-------|
| Uninitialized | Initialized | `initialize_perk_oracle` | ✅ | Account created with `init` |
| Initialized | Active | `update_perk_oracle` | ✅ | timestamp=0 bypasses gap check; price set > 0 |
| Initialized | Frozen | `freeze_perk_oracle(true)` | ✅ | Sets is_frozen=true, pointless but harmless |
| Active | Active | `update_perk_oracle` | ✅ | Normal operation |
| Active | Frozen | `freeze_perk_oracle(true)` | ✅ | Emergency freeze |
| Frozen | Frozen | `freeze_perk_oracle(true)` | ✅ | Idempotent |
| Frozen | Unfrozen | `freeze_perk_oracle(false)` | ✅ | H-01 fix path |
| Unfrozen | Active | `update_perk_oracle` | ✅ | Bypass flag consumed, price set > 0 |
| Active → Frozen → Unfrozen → Frozen | | Double freeze without update | ✅ | Second unfreeze stores price=0 as pre-freeze ref; first update is unbanded. Correct: no meaningful price to band against. |

### Impossible State Analysis

| State | Possible? | Reason |
|-------|-----------|--------|
| `is_frozen=true ∧ price=0 ∧ _reserved[0]=1` | Yes, but harmless | Freeze after unfreeze without update. Flag is inert while frozen. |
| `is_frozen=false ∧ price>0 ∧ _reserved[0]=1` | No | Update clears flag before setting price. |
| `is_frozen=false ∧ price=0 ∧ _reserved[0]=0 ∧ timestamp>0` | No | Only reachable if update clears flag without setting price, but update always sets price>0. |
| `price > MAX_ORACLE_PRICE` | No | Enforced by update_perk_oracle require! |

### Frozen State Blocking Verification

**Claim:** When `is_frozen=true`, no instruction can use the oracle's price.

**Read path:** `read_perk_oracle_price` → `require!(!oracle.is_frozen)` → error before any price access ✓

**Update path:** `update_perk_oracle` → `require!(!oracle.is_frozen)` → error, no state change ✓

**Consumer instructions** (open_position, close_position, liquidate): All use `read_oracle_price_with_fallback` → calls `read_oracle_price` → calls `read_perk_oracle_price` → blocked. If this oracle is the fallback, the fallback call also goes through `read_oracle_price` → blocked. ✓

**Verdict:** ✅ Frozen state is a complete block on all reads and updates.

---

## 5. Interaction with Risk Engine

### Price Flow Trace

```
oracle::read_oracle_price_with_fallback()
    │
    ├── read_oracle_price(primary_source, ...)
    │       └── read_perk_oracle_price()
    │              ├── CHECK: !is_frozen
    │              ├── CHECK: price > 0
    │              ├── CHECK: staleness ≤ max_staleness
    │              ├── CHECK: age ≥ 0
    │              ├── CHECK: num_sources ≥ min_sources
    │              ├── CHECK: price ≤ MAX_ORACLE_PRICE
    │              └── CHECK: confidence ≤ price × 200 / 10_000
    │
    └── On primary failure → read_oracle_price(fallback_source, fallback_account, ...)
            └── CHECK: fallback_account.key == market.fallback_oracle_address
                (prevents injection of fake oracle)
    │
    ▼ Returns OraclePrice { price: u64, confidence: u64, timestamp: i64 }
    │
    ▼ oracle_price = result.price
    │
    ├── risk::accrue_market_to(market, clock.slot, oracle_price)
    │       └── CHECK: oracle_price > 0 && oracle_price ≤ MAX_ORACLE_PRICE (belt-and-suspenders)
    │       └── Applies mark-to-market via K-coefficients
    │       └── Applies funding via K-coefficients
    │
    ├── risk::settle_side_effects(position, market)
    │       └── Settles per-account PnL via K-difference
    │
    ├── risk::is_above_initial_margin(position, market, oracle_price)
    │       └── Uses notional = |eff_pos| × oracle_price / POS_SCALE
    │
    ├── risk::is_above_maintenance_margin(position, market, oracle_price)
    │       └── Same notional computation
    │
    └── risk::enqueue_adl(market, side, q_close, deficit)
            └── ADL deficit socialization, no direct oracle use (uses accumulated K)
```

### Bypass Analysis

**Question:** Can any code path bypass oracle validation?

**Answer: No.**

1. All three consumer instructions (`open_position`, `close_position`, `liquidate`) call `read_oracle_price_with_fallback` as their first oracle access. The `?` propagates any error.
2. `accrue_market_to` performs its own bounds check on `oracle_price` (redundant but safe).
3. No instruction constructs an `OraclePrice` from raw data — it always goes through the reader.
4. The `oracle_account` constraint `oracle.key() == market.oracle_address` prevents substituting a different oracle account.
5. The fallback account is validated against `market.fallback_oracle_address`.

### Oracle Owner Check

`read_perk_oracle_price` verifies:
```rust
require!(oracle_account.owner == &crate::ID, PerkError::InvalidOracleSource);
```

This prevents passing any account not owned by the Perk program. Combined with PDA derivation (`[b"perk_oracle", token_mint.as_ref()]`), this guarantees authenticity. ✓

**Verdict:** ✅ No bypass path exists. Oracle validation is comprehensive and mandatory.

---

## 6. Overflow Analysis

### 6.1 update_perk_oracle Arithmetic

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `ema_price.saturating_mul(9)` | `1e12 × 9` | `9e12` | `u64 (1.84e19)` | ✅ |
| `price.saturating_add(9*ema)` | `1e12 + 9e12` | `1e13` | `u64 (1.84e19)` | ✅ |
| `raw_ema / 10` | `1e13 / 10` | `1e12` | `u64` | ✅ |
| `diff.checked_mul(BPS_DENOMINATOR)` | `1e12 × 10_000` | `1e16` | `u64 (1.84e19)` | ✅ checked |
| `change_bps / reference_price` | `1e16 / 1` | `1e16` | `u64` | ✅ |
| `total_updates.saturating_add(1)` | `u64::MAX + 1` | `u64::MAX` | `u64` | ✅ saturates |
| `clock.unix_timestamp - oracle.timestamp` | `i64::MAX - i64::MIN` | `i128 range` | `i64` | ⚠️ see below |

**`gap` computation detail:**
```rust
let gap = clock.unix_timestamp.saturating_sub(oracle.timestamp);
```
Uses `saturating_sub` on `i64`. If `oracle.timestamp > clock.unix_timestamp` (shouldn't happen normally), saturates to `i64::MIN`. The subsequent `require!(gap <= max_gap)` would fail since `max_gap` is positive. This is safe. ✓

### 6.2 read_perk_oracle_price Arithmetic

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `current_time - oracle.timestamp` | Realistic: ~1e10 | ~1e10 | `i64` | ✅ `saturating_sub` |
| `price × ORACLE_CONFIDENCE_BPS` | `1e12 × 200` | `2e14` | `u64 (1.84e19)` | ✅ checked |
| `÷ BPS_DENOMINATOR` | `2e14 / 10_000` | `2e10` | `u64` | ✅ |

### 6.3 scale_pyth_price Arithmetic

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `expo + PRICE_DECIMALS` | `i32 range` | `i32 range` | `i32` | ✅ checked |
| `10u64.checked_pow(shift)` | `shift ≤ 19` → `1e19` | `1e19 ≈ u64::MAX` | `u64` | ✅ checked |
| `price × factor` | `u64::MAX × 1` or `1 × 1e19` | `u64 range` | `u64` | ✅ checked |

### 6.4 accrue_market_to K-coefficient Arithmetic

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `checked_u128_mul_i128(A, delta_p)` | `A=1e6, delta_p=1e12` | `1e18` | Uses U256 internally | ✅ |
| `fund_px × abs_rate × dt` | `1e12 × 1e10 × 65535` | `≈6.55e26` | `u128 (3.4e38)` | ✅ checked |
| `÷ FUNDING_RATE_PRECISION` | `6.55e26 / 1e6` | `6.55e20` | `u128` | ✅ |
| `mul_div_ceil_u128(A, funding_term, 10_000)` | `1e6 × 6.55e20` | `6.55e26` (intermediate) | `u128` | ✅ checked (a×b fits) |
| `K_index ± delta_K` | `i128 range` | `i128 range` | `i128` | ✅ checked |

**Note on `A` bounds:** `A` starts at `ADL_ONE (1e6)` and is only decreased by `enqueue_adl` (via `A_new = A_old × OI_post / OI`). It's restored to `ADL_ONE` by `begin_full_drain_reset`. Therefore `A_max = ADL_ONE = 1e6`. ✓

### 6.5 settle_side_effects K-difference

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `a_basis × POS_SCALE` | `1e6 × 1e6` | `1e12` | `u128` | ✅ checked |
| `wide_signed_mul_div_floor_from_k_pair` | abs_basis ≤ 1e14, K range ≤ i128::MAX | Uses I256/U256 | `i128` result | ✅ wide math |

### 6.6 Margin and Notional

| Operation | Max Inputs | Max Result | Type Capacity | Safe? |
|-----------|-----------|------------|---------------|-------|
| `eff_pos.unsigned_abs() × oracle_price / POS_SCALE` | `1e14 × 1e12 / 1e6` | `1e20` | `u128` | ✅ via `mul_div_floor_u128` |
| `notional × margin_bps / 10_000` | `1e20 × 10_000 / 10_000` | `1e20` | `u128` | ✅ |

**Verdict:** ✅ All arithmetic operations are safe within the normative bounds. Checked/saturating math is used correctly throughout.

---

## Findings

### [INV-01] Spec–Implementation Type Mismatch: price field i64 vs u64
**Type:** Spec Inconsistency
**Severity:** Informational
**Description:** The PERK-ORACLE-SPEC.md declares `price: i64` and `ema_price: i64`, but the implementation uses `u64` for both fields.
**Impact:** None — `u64` is strictly better for prices (always positive). The implementation is correct; the spec should be updated.
**Recommendation:** Update PERK-ORACLE-SPEC.md to match implementation (`u64`).

### [INV-02] Missing update_oracle_config Instruction
**Type:** Feature Gap
**Severity:** Medium (Operational)
**Description:** The spec states "Admin can change banding on live oracles via `update_oracle_config`" but this instruction does not exist in the codebase. Once `max_price_change_bps`, `min_sources`, and `max_staleness_seconds` are set during initialization, they are **immutable**.
**Impact:**
- Cannot adjust price banding for live oracles (e.g., temporarily disable banding during extreme market events like LUNA collapse)
- Cannot update staleness threshold if network conditions change
- Cannot adjust min_sources if a price source goes permanently offline
**Proof:** Grep of all instruction files shows no `update_oracle_config` handler. The `_reserved[1..3]` bytes (max_price_change_bps) are written only in `initialize_perk_oracle`.
**Recommendation:** Implement `update_oracle_config` instruction (admin-only) that can modify `max_price_change_bps` (via `_reserved[1..3]`), `min_sources`, and `max_staleness_seconds`. Alternatively, document this as intentional and remove the spec reference.

### [INV-03] Confidence Floor Rejects Very Low-Priced Tokens
**Type:** Edge Case Limitation
**Severity:** Low
**Description:** The confidence validation `max_conf = price × 200 / 10_000` truncates to 0 for `price < 50` (i.e., tokens priced below $0.00005 in PRICE_SCALE). Any non-zero confidence is rejected, effectively requiring exact-price updates with `confidence = 0`.
**Proof:**
- `price = 49`: `max_conf = 49 × 200 / 10_000 = 9800 / 10_000 = 0` → confidence must be 0
- `price = 50`: `max_conf = 50 × 200 / 10_000 = 1` → confidence ≤ 1
- `price = 500` ($0.0005): `max_conf = 10` → reasonable
**Impact:** Memecoins with very low per-token prices may be difficult to service via PerkOracle if any price source disagreement exists. The cranker must post `confidence = 0` for such tokens.
**Recommendation:** Consider using a wider-intermediate computation (`u128`) and/or a minimum confidence allowance of 1 unit for very low prices. Alternatively, document this limitation for market creators.

### [INV-04] Price Banding Granularity Loss at Minimum Representable Prices
**Type:** Edge Case
**Severity:** Informational
**Description:** For `reference_price = 1` (the smallest valid price), price banding becomes binary: `diff = 0` passes (no change), `diff ≥ 1` produces `change_bps = 10,000` which exceeds any configured band (max 9,999 bps). This means the smallest possible price change (1 unit) is always rejected.
**Proof:** `change_bps = 1 × 10,000 / 1 = 10,000 > max_price_change_bps (≤ 9,999)`
**Impact:** Negligible in practice — tokens priced at $0.000001 with banding enabled would be stuck at their reference price. Such tokens would typically have banding disabled (`max_price_change_bps = 0`).
**Recommendation:** No action needed. Document as known behavior.

### [INV-05] EMA Reset on Unfreeze Loses Historical Smoothing
**Type:** Design Decision
**Severity:** Informational
**Description:** On unfreeze, `ema_price` is reset to 0 alongside `price`. The first post-unfreeze update sets `ema_price = params.price` (first-update path). This means all historical EMA smoothing is lost.
**Proof:** In `freeze_perk_oracle`: `oracle.ema_price = 0;`. In `update_perk_oracle`: `if oracle.ema_price == 0 { oracle.ema_price = params.price; }`
**Impact:** After unfreeze, the EMA immediately matches the spot price with no smoothing. If EMA were consumed by any downstream logic, this could cause a discontinuity. Currently, **no instruction reads `ema_price`** — it is informational only.
**Recommendation:** No action needed while EMA is unused. If EMA is ever consumed for trading logic, consider preserving it across freeze/unfreeze cycles (store in `_reserved`).

### [INV-06] total_updates Counter Saturates at u64::MAX
**Type:** Informational
**Severity:** Informational
**Description:** `total_updates` uses `saturating_add(1)`, so at `u64::MAX` it stops incrementing rather than wrapping. At 2 updates/second, saturation would take ~292 billion years.
**Impact:** None.
**Recommendation:** No action needed.

### [INV-07] Gap Check Comparison Uses Signed Arithmetic on Positive Values
**Type:** Informational
**Severity:** Informational
**Description:** The gap computation uses `i64` throughout:
```rust
let gap = clock.unix_timestamp.saturating_sub(oracle.timestamp); // i64
let max_gap = (oracle.max_staleness_seconds as i64).saturating_mul(2); // i64
require!(gap <= max_gap, PerkError::OracleGapTooLarge);
```
If `oracle.timestamp > clock.unix_timestamp` (clock skew), `saturating_sub` produces `i64::MIN`, which always fails `gap <= max_gap` (since `max_gap` is positive). This is safe behavior but worth noting.
**Impact:** None — the safety direction is correct (reject rather than accept).

### [INV-08] No Fallback Mint Validation at Market Creation
**Type:** Potential Integration Issue
**Severity:** Low
**Description:** `validate_perk_oracle_mint` exists to verify a PerkOracle's `token_mint` matches the market's expected mint, but I did not find evidence it is called during market creation when setting a PerkOracle as fallback. If a market is configured with a fallback PerkOracle for a different token, the prices would be for the wrong asset.
**Proof:** The function `validate_perk_oracle_mint` is defined in `oracle.rs` but its call site during market creation/configuration was not included in the reviewed files.
**Impact:** If market creation doesn't validate the fallback oracle's mint, an admin could accidentally (or maliciously) assign a wrong-token oracle as fallback.
**Recommendation:** Verify that market creation/update instructions call `validate_perk_oracle_mint` for both primary and fallback PerkOracle sources. If they don't, add the validation.

---

## Summary

| Category | Status |
|----------|--------|
| State Invariants | ✅ All 7 invariants verified and maintained across all transitions |
| EMA Computation | ✅ No overflow possible. Saturating math unnecessary but harmless. |
| Price Banding | ✅ Correct. Truncation error < 1 bps. |
| Confidence Validation | ✅ Sound. Conservative truncation at low prices (see INV-03). |
| Pyth Scaling | ✅ Handles all exponent ranges with checked arithmetic. |
| _reserved Layout | ✅ No overlaps. Consistent endianness. All paths agree. |
| State Machine | ✅ All transitions valid. No impossible states reachable. Frozen blocks all reads. |
| Risk Engine Integration | ✅ No bypass paths. Oracle validation is mandatory on all consumer instructions. |
| Overflow Analysis | ✅ All operations safe within normative bounds. |

**Critical/High Findings:** 0
**Medium Findings:** 1 (INV-02: Missing update_oracle_config)
**Low Findings:** 2 (INV-03, INV-08)
**Informational:** 5 (INV-01, INV-04, INV-05, INV-06, INV-07)
