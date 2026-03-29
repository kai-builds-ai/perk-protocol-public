# K-Coefficient Bug Report — Critical

**Date:** March 29, 2026  
**Severity:** Critical — causes incorrect PNL settlement, loss of user funds  
**Affects:** All markets, all positions (shorts much worse), all interactions  
**Discovered by:** Roger + Kai during live mainnet testing

---

## Summary

`create_market.rs` never initializes `last_market_slot` or `current_slot`. They default to `0`. This causes `accrue_market_to` to process a gap of ~409 million slots on first interaction, producing catastrophically wrong K-coefficient values. Every subsequent trade/deposit/close compounds the error by processing more of the never-ending gap.

The result: positions gain or lose thousands of percent in "phantom PNL" that has nothing to do with actual price movement. Roger lost ~$45 and gained ~$5 in separate tests on a chart that barely moved.

---

## Root Cause

### Missing Initialization in `create_market.rs`

```rust
// These fields are NEVER set in create_market.rs:
market.last_market_slot    // defaults to 0
market.current_slot        // defaults to 0
market.last_oracle_price   // defaults to 0
```

### What happens on first interaction

When ANY instruction calls `accrue_market_to(market, now_slot, oracle_price)`:

1. **`total_dt = now_slot - last_market_slot = 409,587,761 - 0 = 409,587,761`** — 409 million slots!

2. **Mark-once rule:** `delta_p = oracle_price - last_oracle_price = 2,941,446 - 0 = 2,941,446` (the ENTIRE price)
   - `long_k_index += A × delta_p = 1,000,000 × 2,941,446 = 2.94 trillion`
   - `short_k_index -= A × delta_p = -2.94 trillion`

3. **Funding loop:** Runs 50 iterations × MAX_FUNDING_DT (65,535 slots each):
   - Each step: `funding_term = price × rate × dt / PRECISION = 2,941,446 × 1111 × 65,535 / 1,000,000 = 214,129,458`
   - `delta_K_payer_abs = ceil(1,000,000 × 214,129,458 / 10,000) = 21.4 trillion per step`
   - 50 steps = **~1.07 quadrillion K shift per accrue call**

4. **Partial catch-up:** After processing 3.27M slots, `last_market_slot` advances from 0 to ~3.27M. Gap is still ~406M. Next interaction processes another 3.27M. **Every user interaction accumulates more phantom K.**

### Current on-chain state (TRUMP-PERP market)

| Field | Value | Expected |
|-------|-------|----------|
| `last_market_slot` | 226,095,750 | ~409,587,761 (current) |
| `current_slot` | 409,587,761 | Same |
| `long_k_index` | +6,437,973,970,000 | ~0 (barely moved chart) |
| `short_k_index` | -6,458,933,970,000 | ~0 (barely moved chart) |
| K asymmetry | 20,960,000,000 | ~0 |

The market has been "catching up" through user interactions. `last_market_slot` has advanced from 0 to 226M through dozens of trades tonight, but it's still 183M slots behind. **Every interaction pushes K further from zero.**

### How this causes phantom PNL

When a user opens a position, `attach_effective_position` snapshots the current `short_k_index` as `position.k_snapshot`.

When they next interact (deposit, close, etc.), `settle_side_effects` computes:
```
pnl_delta = abs_basis × (k_side - k_snap) / (a_basis × POS_SCALE)
```

Between interactions, `accrue_market_to` runs and shifts K by trillions. The K-diff produces massive phantom PNL unrelated to actual price movement.

- **First short test:** K shifted negative → `-$22` PNL on a $35 position (62% loss in minutes)
- **Second short test:** K shifted positive → `+$5` PNL on a $5 position (100% gain instantly)
- **Direction depends on:** how many accrue calls happened between open and next interaction, which direction oracle price shifted by even 1 cent, how many funding iterations ran

### Why shorts are worse

The mark-once rule: `long_k += A × delta_p`, `short_k -= A × delta_p`. Since `last_oracle_price` started at 0, the first mark-once applied the FULL price as delta_p. For shorts, this was a massive negative K shift. Longs got a massive positive shift, but since longs profit when K goes up, this produces phantom positive PNL for longs (less visible to users).

Subsequent oracle price oscillations compound differently on each side due to the accumulated K asymmetry.

---

## Fix Required

### 1. `create_market.rs` — Initialize accrue state (CRITICAL)

Add these lines after the existing market initialization:

```rust
// Initialize accrue state to current slot/price to prevent
// phantom K accumulation from slot 0
market.last_market_slot = clock.slot;
market.current_slot = clock.slot;
market.last_oracle_price = oracle_price_result.price;
market.funding_price_sample_last = oracle_price_result.price;
```

### 2. Admin instruction to reset corrupted markets

Need a new `admin_reset_market_accrue_state` instruction that:
- Sets `last_market_slot = current_slot` (closes the gap)
- Sets `long_k_index = 0`, `short_k_index = 0` (resets K)
- Resets `last_oracle_price` to current oracle price
- Settles or zeroes all affected positions' `k_snapshot` values
- Only callable by protocol admin

This is needed because the TRUMP market (and any other created markets) already have corrupted K values that the `create_market` fix won't retroactively repair.

### 3. Guard in `accrue_market_to` for absurd gaps

Add a safety check:
```rust
// Reject accrue if gap is absurdly large (market was never initialized properly)
const MAX_REASONABLE_GAP: u64 = 1_000_000; // ~6.9 minutes at 2.4 slots/sec
if total_dt > MAX_REASONABLE_GAP {
    // Cap to prevent catastrophic K accumulation
    total_dt = MAX_REASONABLE_GAP;
    // Also update last_market_slot to close the gap
    market.last_market_slot = now_slot.saturating_sub(MAX_REASONABLE_GAP);
}
```

---

## Impact Assessment

- **All existing markets affected** — every market created without `last_market_slot`/`current_slot` initialization
- **TRUMP-PERP:** K values are in the trillions, `last_market_slot` gap is 183M slots. All PNL calculations are wrong.
- **Other markets:** SOL, MOODENG, NEET, TROLL, Buttcoin — all have the same initialization bug
- **User funds at risk:** Phantom PNL causes incorrect settle_losses, draining real collateral. Also causes phantom gains that could be exploited.
- **Exploit potential:** An attacker could open a position, wait for a few accrue calls to shift K favorably, then close for phantom profit extracted from the vault.

---

## Deploy Plan

1. Fix `create_market.rs` + add admin reset instruction + add gap guard
2. Build via CI Docker (`solana-verify build`)
3. Deploy program upgrade
4. Admin calls reset instruction on all affected markets
5. Re-verify with OtterSec
6. Resume trading

---

## Evidence

### Transaction history showing phantom PNL:
- Roger opens SHORT $35 at 3x → vault $35
- Deposits $20 more → `settle_side_effects` runs during deposit, K-diff produces `-$22` PNL
- `settle_losses` deducts $22 from `deposited_collateral`
- Result: $35 + $20 = $55 deposited, but only $18.06 remaining

### Second test:
- Opens SHORT $5 at 3x → vault $4.97
- Adds $5 → K-diff produces `+$4.95` PNL
- Position shows +49.80% gain with zero price movement

### On-chain K state dump (taken during investigation):
```
long_k_index:  +6,437,973,970,000
short_k_index: -6,458,933,970,000
long_a:         1,000,000
short_a:        1,000,000
last_market_slot:  226,095,750
current_slot:      409,587,761
last_oracle_price: 2,941,446
```
