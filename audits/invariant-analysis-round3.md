# Invariant Analysis — Round 3

**Date:** 2026-03-25  
**Scope:** Verify Round 2 fixes are mathematically correct  
**Status:** ✅ ALL INVARIANTS HOLD (with one minor observation)

---

## 1. Unfreeze EMA Anchoring

### Code Path (`freeze_perk_oracle.rs`, lines in `if !frozen` block)

```
1. pre_freeze_bytes = oracle.price.to_le_bytes()       // store price → _reserved[3..11]
2. let pre_freeze_price = oracle.price;                 // capture by value
3. oracle.ema_price = pre_freeze_price;                 // EMA ← pre-freeze price
4. window ref ← (pre_freeze_price, clock.slot)          // window anchored
5. oracle.price = 0;                                    // zero the live price
6. oracle._reserved[0] = 1;                             // set unfreeze_pending flag
```

### Verification: Ordering

**Claim:** EMA is set BEFORE price is zeroed.

**Proof:** Line 3 (`oracle.ema_price = pre_freeze_price`) executes before line 5 (`oracle.price = 0`). The value `pre_freeze_price` is captured at line 2 as a `u64` copy of `oracle.price` before any mutation. ✅

**Claim:** `_reserved[3..11]` (pre_freeze_price) is stored correctly.

**Proof:** Line 1 writes `oracle.price.to_le_bytes()` into `_reserved[3..11]` BEFORE line 5 zeros `oracle.price`. The offset `RESERVED_OFFSET_PRE_FREEZE_PRICE = 3` and the 8-byte write `[3..11)` is correct for a `u64`. ✅

### Verification: Edge Case — Oracle Never Updated (price=0 at freeze time)

If the oracle was initialized but never received an update:
- `oracle.price = 0` at freeze time
- `pre_freeze_price = 0`
- `oracle.ema_price = 0` (stays zero)
- `_reserved[3..11] = 0` (pre-freeze price = 0)

On first post-unfreeze update (`update_perk_oracle.rs`):

**Circuit breaker check:**
```rust
if cb_bps > 0 && old_ema > 0 { ... }
```
Since `old_ema = 0`, the condition `old_ema > 0` is **false** → circuit breaker is **skipped**. ✅

**Price banding check:**
```rust
let reference_price = if oracle.price > 0 {
    oracle.price
} else {
    u64::from_le_bytes(oracle._reserved[3..11])  // = 0
};
if reference_price > 0 { ... }  // skipped when 0
```
Since both `oracle.price = 0` and pre-freeze price = 0, `reference_price = 0` → banding is **skipped**. ✅

**EMA initialization:**
```rust
if oracle.ema_price == 0 {
    oracle.ema_price = params.price;  // set to first update price
}
```
EMA = 0 → first update sets `ema_price = P`. ✅

**Window initialization:**
```rust
if window_ref_price > 0 { ... } else {
    // window_ref_price = 0 from pre_freeze_price = 0
    // ...wait, window_ref_price was set to pre_freeze_price = 0
}
```
Since `pre_freeze_price = 0`, `window_ref_price = 0` → window initializes to first update price. ✅

**Conclusion:** Never-updated oracle correctly bypasses all protections on first update and bootstraps cleanly. The state is identical to a freshly initialized oracle receiving its first update.

### Mathematical Proof: EMA Continuity After Unfreeze

Let P_old = price at freeze time (> 0 for normal case).

After unfreeze:
- `ema_price = P_old`
- `oracle.price = 0`

First post-unfreeze update with price P_new:

**EMA update path:**
```
old_ema = P_old  (non-zero, so not first-update path)
new_ema = (P_new + 9 * P_old) / 10
```

**Circuit breaker check (against old_ema = P_old):**
```
deviation = |P_new - P_old|
deviation_bps = deviation * 10000 / P_old
require: deviation_bps <= cb_bps
```

This means the first post-unfreeze update is bounded to within `cb_bps` of the pre-freeze price, which is the correct security invariant. ✅

---

## 2. Window Reference Reset on Unfreeze

### Code Path (`freeze_perk_oracle.rs`)

```rust
let clock = Clock::get()?;
oracle._reserved[11..19].copy_from_slice(&pre_freeze_price.to_le_bytes());
oracle._reserved[19..27].copy_from_slice(&clock.slot.to_le_bytes());
```

### Verification: Clock::get() validity

`Clock::get()` is a Solana sysvar read that returns the current slot/timestamp. It is infallible on mainnet (only fails in edge test scenarios). The `?` propagates any error. The slot returned is always the current transaction's slot. ✅

### Verification: Storage correctness

- `RESERVED_OFFSET_WINDOW_REF_PRICE = 11` → `[11..19)` = 8 bytes for `u64` price ✅
- `RESERVED_OFFSET_WINDOW_REF_SLOT = 19` → `[19..27)` = 8 bytes for `u64` slot ✅
- No overlap with other fields: `[0]` = unfreeze_pending, `[1..3)` = max_price_change_bps, `[3..11)` = pre_freeze_price, `[27..29)` = circuit_breaker_bps ✅

### Verification: Borrow checker

`pre_freeze_price` is a `u64` (Copy type), captured by value at line 2. It does not borrow `oracle` — it's a stack copy. All subsequent writes to `oracle._reserved` are through `&mut oracle` which is the only mutable reference. No aliasing issues. ✅

### Post-Unfreeze Window Behavior

On first update after unfreeze, `update_perk_oracle.rs` reads the window:
```
window_ref_price = P_old (from _reserved[11..19])
window_ref_slot = S_unfreeze (from _reserved[19..27])
```

Since the unfreeze just happened and `S_update > S_unfreeze`, `slots_since = S_update - S_unfreeze`.

**Case A: `slots_since <= CIRCUIT_BREAKER_WINDOW_SLOTS (50)`** (typical — update immediately after unfreeze):
```
window_max_bps = max_price_change_bps * WINDOW_BAND_MULTIPLIER (3)
window_diff = |P_new - P_old|
window_change_bps = window_diff * 10000 / P_old
require: window_change_bps <= window_max_bps
```
First update is bounded to 3x the per-update band from pre-freeze price. ✅

**Case B: `slots_since > 50`** (update delayed >20s after unfreeze):
Window expired → new window starts at `P_new`. This is correct because after a long gap, the old reference is stale. ✅

---

## 3. Insurance Double Epoch Reset

### Code Paths

**liquidate.rs:**
```rust
let epoch_elapsed = clock.unix_timestamp.saturating_sub(market.insurance_epoch_start);
if epoch_elapsed >= INSURANCE_EPOCH_SECONDS {
    market.insurance_epoch_start = clock.unix_timestamp;
    market.insurance_epoch_payout = 0;
}
```

**crank_funding (referenced in ATK-04 comment):** Same pattern — checks elapsed, resets `epoch_start` and `epoch_payout`.

### Proof: Double-Reset is Idempotent

Let `T` = current unix_timestamp, `T_0` = insurance_epoch_start.

**First reset (e.g., in liquidate):**
```
epoch_elapsed = T - T_0 >= 86400
→ market.insurance_epoch_start = T
→ market.insurance_epoch_payout = 0
```

**Second reset (e.g., in crank_funding, same slot/second):**
```
epoch_elapsed = T - T = 0
0 >= 86400 → FALSE → no reset occurs
```

The second call is a no-op because `epoch_elapsed = 0 < 86400`. ✅

If both happen in the same slot but different unix_timestamp (impossible — same slot = same timestamp on Solana), the logic still holds because:
- Reset sets `epoch_start = T` 
- Any subsequent check with the same `T` yields `elapsed = 0`

### Proof: No Race Condition

Solana's runtime model is **single-threaded per account**. Two transactions touching the same `Market` account are serialized — they cannot execute concurrently. The account lock guarantees:

- If `liquidate` and `crank_funding` both reference the same `Market` PDA, they are ordered by the runtime
- The second transaction sees the state written by the first
- No interleaving is possible within a single slot for the same account

**Formal argument:** Let `tx_1` and `tx_2` both write `market.insurance_epoch_payout`. Since both include `market` as a mutable account, Solana's SVM enforces a total order. WLOG let `tx_1` execute first:

```
After tx_1: epoch_start = T, epoch_payout = 0
tx_2 reads: epoch_elapsed = T - T = 0 < 86400 → no reset
```

The epoch payout counter is monotonically increasing within an epoch, reset only at epoch boundaries. Double-reset at boundary is harmless (second is no-op). ✅

---

## 4. Circuit Breaker Bounds

### Constants
```rust
MIN_CIRCUIT_BREAKER_BPS: u16 = 500   // 5%
MAX_CIRCUIT_BREAKER_BPS: u16 = 9999  // 99.99%
```

### Validation in `initialize_perk_oracle.rs`

```rust
require!(
    params.circuit_breaker_deviation_bps == 0
        || params.circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS,
    PerkError::InvalidAmount
);
require!(params.circuit_breaker_deviation_bps <= MAX_CIRCUIT_BREAKER_BPS, PerkError::InvalidAmount);
```

**Accepted values:** `{0} ∪ [500, 9999]`

- `0` → disabled ✅
- `1..499` → rejected by first require (not 0 AND < 500) ✅
- `500..9999` → passes both requires ✅
- `10000..65535` → rejected by second require (> 9999) ✅

### Validation in `update_oracle_config.rs`

```rust
require!(
    circuit_breaker_deviation_bps == 0
        || circuit_breaker_deviation_bps >= MIN_CIRCUIT_BREAKER_BPS,
    PerkError::InvalidAmount
);
require!(
    circuit_breaker_deviation_bps <= MAX_CIRCUIT_BREAKER_BPS,
    PerkError::InvalidAmount
);
```

**Identical logic.** Accepted values: `{0} ∪ [500, 9999]` ✅

### Consistency with Price Banding

Price banding uses the same pattern:
```rust
// 0 = disabled, otherwise [MIN_PRICE_CHANGE_BPS, MAX_PRICE_CHANGE_BPS]
// = {0} ∪ [100, 9999]
```

Circuit breaker: `{0} ∪ [500, 9999]`  
Price banding:   `{0} ∪ [100, 9999]`

Both follow the "0-or-range" pattern. The minimum for circuit breaker (5%) is higher than price banding (1%), which makes sense — the CB is a wider safety net while banding is a tighter per-update control. ✅

### Runtime Enforcement in `update_perk_oracle.rs`

```rust
let cb_bps = u16::from_le_bytes([...]);
if cb_bps > 0 && old_ema > 0 {
    // deviation check
}
```

- `cb_bps = 0` → disabled, skip check ✅
- `cb_bps > 0` (guaranteed ≥ 500 by init/config validation) → check active ✅
- `old_ema = 0` → skip (no EMA reference yet, first update) ✅

---

## 5. Complete State Machine

### State Diagram

```
                    ┌─────────────────────────────────────┐
                    │           UNINITIALIZED              │
                    └──────────────┬──────────────────────┘
                                   │ initialize_perk_oracle
                                   ▼
                    ┌─────────────────────────────────────┐
                    │     INIT (price=0, ema=0, win=0)    │
                    │     is_frozen=false                  │
                    └──────────────┬──────────────────────┘
                                   │ update_perk_oracle (first)
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  ACTIVE (price=P, ema=P, win=P@S)   │◄──────┐
                    │  is_frozen=false                     │       │
                    └──────┬──────────────────────────────┘       │
                           │ freeze(frozen=true)                  │
                           ▼                                      │
                    ┌─────────────────────────────────────┐       │
                    │  FROZEN (is_frozen=true, price=P)   │       │
                    └──────┬──────────────────────────────┘       │
                           │ freeze(frozen=false) [UNFREEZE]      │
                           ▼                                      │
                    ┌─────────────────────────────────────┐       │
                    │  UNFROZEN-PENDING                    │       │
                    │  price=0, ema=P_old, win=P_old@S    │       │
                    │  _reserved[0]=1 (unfreeze_pending)  │       │
                    │  _reserved[3..11]=P_old             │       │
                    └──────┬──────────────────────────────┘       │
                           │ update_perk_oracle (first post-      │
                           │ unfreeze, clears pending flag)       │
                           ▼                                      │
                    ┌─────────────────────────────────────┐       │
                    │  ACTIVE (price=P_new, ema updated)  │───────┘
                    │  All protections re-engaged         │ (subsequent updates)
                    └─────────────────────────────────────┘
```

### Transition Analysis

#### T1: Uninitialized → Init

**Trigger:** `initialize_perk_oracle`

**State after:**
| Field | Value |
|-------|-------|
| price | 0 |
| ema_price | 0 |
| _reserved[3..11] (pre_freeze) | 0 |
| _reserved[11..19] (window_price) | 0 |
| _reserved[19..27] (window_slot) | 0 |
| _reserved[27..29] (cb_bps) | param |
| is_frozen | false |
| timestamp | 0 |

**Protections:** Oracle cannot be read by `read_perk_oracle_price` because `price = 0` fails the `require!(oracle.price > 0)` check. No market can use this oracle until first update. ✅

#### T2: Init → Active (First Update)

**Trigger:** `update_perk_oracle` with `price = P > 0`

**Checks applied:**
- `is_frozen = false` ✅
- `price > 0` ✅
- `num_sources >= min_sources` ✅
- `slot > last_slot` ✅ (last_slot = 0, current slot > 0)
- Gap check: `timestamp = 0` → skipped (correct, no prior update) ✅
- Banding: `reference_price = 0` → skipped ✅
- EMA: `ema_price = 0` → `ema_price = P` (first update bootstrap) ✅
- CB: `old_ema = 0` → skipped ✅
- Window: `window_ref_price = 0` → initialized to `(P, slot)` ✅

**State after:**
| Field | Value |
|-------|-------|
| price | P |
| ema_price | P |
| window_ref | (P, S) |
| timestamp | T |
| last_slot | S |

#### T3: Active → Active (Subsequent Updates)

**Trigger:** `update_perk_oracle` with `price = P_new`

**All protections active:**
- Gap check: `|T_new - T_old| <= 2 * max_staleness` ✅
- Banding: `|P_new - P_old| * 10000 / P_old <= max_price_change_bps` ✅
- EMA: `ema = (P_new + 9 * ema_old) / 10` ✅
- CB: `|P_new - ema_old| * 10000 / ema_old <= cb_bps` ✅
- Window: if within 50 slots, `|P_new - P_ref| * 10000 / P_ref <= 3 * max_price_change_bps` ✅

#### T4: Active → Frozen

**Trigger:** `freeze_perk_oracle(frozen=true)`

**State change:** `is_frozen = true`. No other fields modified.

**Protections:**
- `update_perk_oracle` rejects: `require!(!oracle.is_frozen)` ✅
- `read_perk_oracle_price` rejects: `require!(!oracle.is_frozen)` ✅

#### T5: Frozen → Unfrozen-Pending

**Trigger:** `freeze_perk_oracle(frozen=false)`

**Execution order (verified above):**
1. Store `P_old` in `_reserved[3..11]`
2. Capture `pre_freeze_price = P_old` (stack copy)
3. `ema_price = P_old`
4. Window ref = `(P_old, current_slot)`
5. `price = 0`
6. `_reserved[0] = 1` (unfreeze_pending)
7. `is_frozen = false`

**Protection invariants after unfreeze:**
- `read_perk_oracle_price` rejects: `price = 0` fails `require!(oracle.price > 0)` ✅
- No stale price can be consumed by any instruction ✅
- EMA anchored to pre-freeze price → CB active on next update ✅
- Window anchored to pre-freeze price → window banding active ✅

#### T6: Unfrozen-Pending → Active (First Post-Unfreeze Update)

**Trigger:** `update_perk_oracle` with `price = P_new`

**Checks applied:**
- `is_frozen = false` ✅
- Gap check: `unfreeze_pending = true` → **skipped** (one-time bypass) ✅
  - Flag cleared: `_reserved[0] = 0` ✅
- Banding: `oracle.price = 0` → falls to pre-freeze reference:
  ```
  reference_price = _reserved[3..11] = P_old
  |P_new - P_old| * 10000 / P_old <= max_price_change_bps
  ```
  ✅ Banding active against pre-freeze price
- EMA: `ema_price = P_old ≠ 0` → normal path:
  ```
  new_ema = (P_new + 9 * P_old) / 10
  ```
  ✅
- CB: `old_ema = P_old > 0` and `cb_bps > 0`:
  ```
  |P_new - P_old| * 10000 / P_old <= cb_bps
  ```
  ✅ Circuit breaker active
- Window: `window_ref_price = P_old > 0`:
  - If `slots_since <= 50`: cumulative window check active ✅
  - If `slots_since > 50`: new window starts ✅

**All three protections (banding, CB, window) are active on the first post-unfreeze update.** This confirms the Round 2 triple-bypass fix (ATK-01) is correct.

### Oracle Read Gate: Defense in Depth

Even if `update_perk_oracle` were somehow bypassed, `read_perk_oracle_price` independently validates:
1. `!oracle.is_frozen` 
2. `oracle.price > 0`
3. `age <= max_staleness_seconds`
4. `num_sources >= min_sources`
5. `oracle.price <= MAX_ORACLE_PRICE`
6. `confidence <= 2% of price`

This means a zero-price oracle can never be consumed by any market instruction, regardless of update handler state. ✅

---

## Summary

| Invariant | Status | Notes |
|-----------|--------|-------|
| EMA anchoring on unfreeze | ✅ CORRECT | Ordering verified: EMA set before price zeroed |
| Never-updated oracle edge case | ✅ CORRECT | All protections correctly skip; bootstraps cleanly |
| Window reference reset | ✅ CORRECT | Clock valid, offsets correct, no borrow issues |
| Insurance double epoch reset | ✅ CORRECT | Idempotent (second call is no-op); no race (account locks) |
| Circuit breaker bounds (init) | ✅ CORRECT | Accepts `{0} ∪ [500, 9999]` |
| Circuit breaker bounds (config) | ✅ CORRECT | Identical validation logic |
| State machine completeness | ✅ CORRECT | All transitions verified, all protections active |
| Post-unfreeze triple protection | ✅ CORRECT | Banding, CB, and window all active on first update |
| Oracle read gate | ✅ CORRECT | `price > 0` check prevents stale price consumption |

### No Issues Found

All Round 2 fixes are mathematically correct. The state machine transitions are sound, protections are active at every stage, and edge cases (never-updated oracle, double epoch reset) are handled correctly.

---

*Analysis by formal verification subagent, Round 3*
