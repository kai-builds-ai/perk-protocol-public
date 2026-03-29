# Apex Red Team — Round 2 (Fix Verification)
Date: 2026-03-25

Auditor: Kai (AI Red Team)
Scope: Security fixes #1–#8 applied to Perk Protocol

---

## [ATK-01] Post-Unfreeze Triple Bypass — Circuit Breaker, Sliding Window, and EMA All Neutralized

**Target Fix:** Circuit breaker (#1), Sliding window banding (#2)
**Severity:** Critical
**Feasibility:** Practical (requires compromised or colluding cranker + admin unfreeze)

**Description:**
After an admin unfreezes an oracle, three security mechanisms are simultaneously neutralized for the first update:

1. **Circuit breaker bypassed:** `old_ema` is 0 (set to 0 on unfreeze), so the `cb_bps > 0 && old_ema > 0` guard skips the circuit breaker entirely.
2. **Sliding window bypassed:** The `window_ref_slot` is not reset on unfreeze. If the oracle was frozen for >50 slots (~20 seconds — nearly guaranteed in any real freeze scenario), `slots_since > CIRCUIT_BREAKER_WINDOW_SLOTS` evaluates to true. The window simply resets to the attacker's chosen price. No cumulative deviation check occurs.
3. **EMA anchored to attacker's price:** Since `ema_price == 0`, the first update sets `oracle.ema_price = params.price` directly. All subsequent circuit breaker checks reference this attacker-chosen EMA.

The only constraint is per-update banding against the `pre_freeze_price` stored in `_reserved[3..11]`. But this allows up to `max_price_change_bps` (potentially 99.99%) deviation in a single update.

**Attack Steps:**
1. Wait for (or socially engineer) an admin freeze/unfreeze cycle.
2. On the first post-unfreeze update, submit a price at the maximum banding limit (e.g., pre-freeze ± 30%).
3. EMA is now anchored to the manipulated price. Sliding window starts a fresh window from this price.
4. On the second update, the circuit breaker now checks against the manipulated EMA. Continue walking the price using the EMA-walking technique (ATK-02).

**Impact:** An attacker with cranker access can establish an arbitrary price (within banding) as the new EMA anchor after any freeze/unfreeze event. This corrupts all downstream circuit breaker protection for the oracle's lifetime.

**Recommendation:**
- On unfreeze, set `ema_price` to `pre_freeze_price` instead of 0. This ensures the circuit breaker has a meaningful reference on the first post-unfreeze update.
- On unfreeze, reset `window_ref_price` to `pre_freeze_price` and `window_ref_slot` to the current slot. This forces the sliding window to constrain the first post-unfreeze update.
- Consider requiring the first N post-unfreeze updates to use tighter banding (e.g., half the normal max_price_change_bps).

---

## [ATK-02] EMA Walking — Gradual Oracle Price Manipulation Through Circuit Breaker

**Target Fix:** Circuit breaker (#1)
**Severity:** High
**Feasibility:** Practical (requires cranker access, 1 update per slot)

**Description:**
The circuit breaker checks `|price - old_ema| <= cb_bps`. The EMA is a simple exponential average: `new_ema = (price + 9 * old_ema) / 10`. By posting prices consistently at the circuit breaker threshold on one side, the EMA walks ~1/10 of the threshold per update.

With `cb_bps = 1000` (10%) and one update per slot (~0.4s):
- Each update moves EMA by ~1% (10% deviation / 10 EMA weight)
- After 50 slots (20s): EMA moved ~(1.01)^50 ≈ 64% from starting value
- After 100 slots (40s): EMA moved ~(1.01)^100 ≈ 170% from starting value

The sliding window only constrains cumulative movement to `3 × max_price_change_bps` per 50-slot window. After the window expires, a new window starts from the current (walked) price. So the attacker chains windows:
- Window 1: Walk 3× banding limit
- Window 2: Walk another 3× banding limit from new reference
- Repeat indefinitely

**Attack Steps:**
1. Post price = `old_ema * (1 + cb_bps/10000)` every slot.
2. After each window (50 slots), the window reference resets to the current (walked) price.
3. Continue for N windows until the oracle price is at the desired target.
4. Exploit the manipulated price for favorable trades/liquidations.

**Impact:** Over minutes, a compromised cranker can walk the oracle to any price while never tripping any single check. The sliding window and circuit breaker, while individually correct, don't prevent gradual multi-window manipulation.

**Recommendation:**
- Add a **long-term anchor**: track the oracle price at initialization/config-update and enforce a maximum lifetime deviation (e.g., 10x from anchor).
- Consider an asymmetric EMA that's slower to move in one direction (e.g., use a higher weight for the EMA when it's being pushed away from the long-term anchor).
- Add a secondary rate limit: maximum cumulative change over a longer window (e.g., 1000 slots / ~6.5 minutes).

---

## [ATK-03] Liquidation Freshness Bypass Due to Primary Oracle Shadowing Fallback

**Target Fix:** Stricter liquidation oracle freshness (#6)
**Severity:** High
**Feasibility:** Practical

**Description:**
The liquidation freshness check (5-second max age) is applied AFTER `read_oracle_price_with_fallback` returns. The fallback is only tried if the primary oracle **fails** (returns an error). But if the primary oracle is stale-but-within-its-own-limit (e.g., 7 seconds old with a 15-second staleness limit), it returns successfully. The 5-second liquidation check then rejects it, but **the fallback is never tried**.

```rust
// In liquidate.rs:
let oracle_result = oracle::read_oracle_price_with_fallback(...)?; // Returns primary (7s old)
let oracle_age = clock.unix_timestamp.saturating_sub(oracle_result.timestamp);
require!(oracle_age <= MAX_LIQUIDATION_ORACLE_AGE, PerkError::OracleStale); // REJECTS (7 > 5)
```

Even if the fallback oracle (e.g., Pyth) has a 1-second-old price, it's never consulted because the primary oracle didn't fail.

**Attack Steps:**
1. As a position holder with an underwater position, ensure the primary oracle (PerkOracle) hasn't been updated in >5 seconds but <15 seconds (within its own staleness).
2. Liquidation attempts fail because the primary oracle returns a price that fails the 5-second liquidation check.
3. The fallback oracle (which may be fresh) is never consulted.
4. The position avoids liquidation during this window.

For PerkOracles with infrequent updates, this window could be common. The oracle authority only needs to post updates every 15 seconds (its own staleness limit), creating a ~10-second window per cycle where liquidations are impossible.

**Impact:** Systematic liquidation delays. A colluding oracle authority could keep updates at exactly 6-14 second intervals, making liquidation impossible while the oracle technically remains "live."

**Recommendation:**
- Pass the required freshness as a parameter to `read_oracle_price_with_fallback`, or check freshness BEFORE committing to the primary oracle.
- Alternatively, after the 5-second check fails, explicitly try the fallback oracle:
```rust
let oracle_result = read_oracle_price_with_fallback(...)?;
if clock.unix_timestamp - oracle_result.timestamp > 5 {
    // Try fallback directly
    let fallback_result = read_oracle_price(fallback_source, fallback_account, ...)?;
    require!(clock.unix_timestamp - fallback_result.timestamp <= 5, OracleStale);
    // use fallback_result
}
```

---

## [ATK-04] Insurance Epoch Payout Never Resets — Fund Becomes Permanently Locked

**Target Fix:** Insurance epoch cap (#4)
**Severity:** High
**Feasibility:** Practical (happens naturally over time)

**Description:**
`use_insurance_buffer` computes `epoch_remaining = epoch_cap - insurance_epoch_payout`, but `insurance_epoch_payout` is only ever incremented (via `saturating_add`) and never reset to 0 at epoch boundaries. The constant `INSURANCE_EPOCH_SECONDS = 86400` is defined but never referenced in `use_insurance_buffer` or anywhere in the reviewed code.

After enough payouts accumulate, `insurance_epoch_payout` will always exceed `epoch_cap` (which is 30% of the current, likely-depleted balance), causing `epoch_remaining` to saturate to 0. From that point forward, no insurance payouts are possible regardless of the fund balance.

**Attack Steps:**
1. No attack needed — this happens organically through normal protocol operation.
2. After total historical insurance payouts exceed 30% of the current fund balance, the insurance fund is permanently locked.
3. All future losses bypass insurance entirely and go straight to ADL socialization.

**Impact:** The insurance fund becomes a black hole — funds go in but can never come out. All deficit socialization falls on opposing-side traders via ADL. This completely undermines the insurance mechanism.

**Recommendation:**
- Add epoch boundary detection in `use_insurance_buffer`:
```rust
let epoch_start = market.insurance_epoch_start;
if clock.unix_timestamp - epoch_start > INSURANCE_EPOCH_SECONDS {
    market.insurance_epoch_payout = 0;
    market.insurance_epoch_start = clock.unix_timestamp;
}
```
- **Note:** This requires access to `Clock` inside `use_insurance_buffer`, which currently doesn't have it. Either pass the timestamp as a parameter or restructure the call site.

---

## [ATK-05] Circuit Breaker Has No Validation Bounds in update_oracle_config

**Target Fix:** Expanded update_oracle_config (#7)
**Severity:** Medium
**Feasibility:** Requires admin collusion

**Description:**
`update_oracle_config` applies no validation to `circuit_breaker_deviation_bps`:

```rust
if let Some(circuit_breaker_deviation_bps) = params.circuit_breaker_deviation_bps {
    let cb_bytes = circuit_breaker_deviation_bps.to_le_bytes();
    oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS] = cb_bytes[0];
    oracle._reserved[RESERVED_OFFSET_CIRCUIT_BREAKER_BPS + 1] = cb_bytes[1];
}
```

Contrast with `max_price_change_bps` which validates against `[MIN_PRICE_CHANGE_BPS, MAX_PRICE_CHANGE_BPS]`. The circuit breaker can be set to:
- **0:** Disables the circuit breaker entirely.
- **1 bps (0.01%):** Effectively freezes the oracle (virtually no update will pass).
- **65535 bps (655%):** Makes the circuit breaker useless.

Combined with `max_price_change_bps = 0` (no banding), setting `circuit_breaker_deviation_bps = 0` removes **all** price validation from the oracle except the basic `price > 0 && price <= MAX_ORACLE_PRICE` checks.

**Attack Steps:**
1. Compromised admin freezes the oracle.
2. Sets `circuit_breaker_deviation_bps = 0` and `max_price_change_bps = 0`.
3. Unfreezes the oracle.
4. Cranker can now post any price (1 to MAX_ORACLE_PRICE) with no restrictions.

**Impact:** Complete oracle manipulation if admin keys are compromised. While admin compromise is always catastrophic, the lack of validation makes the attack path simpler and harder to detect.

**Recommendation:**
- Add validation bounds for circuit breaker: `require!(cb_bps == 0 || (cb_bps >= MIN_CB_BPS && cb_bps <= MAX_CB_BPS))`.
- Consider preventing both `cb_bps = 0` AND `max_price_change_bps = 0` simultaneously to ensure at least one protection is always active.
- Emit an event when either is set to 0, enabling off-chain monitoring.

---

## [ATK-06] Sliding Window Reference Stale After Freeze — False Accepts on Short Freezes

**Target Fix:** Sliding window banding (#2)
**Severity:** Medium
**Feasibility:** Practical (timing-dependent)

**Description:**
On freeze/unfreeze, the sliding window reference (`window_ref_price`, `window_ref_slot`) is not reset. Two scenarios arise:

**Scenario A — Long freeze (>50 slots):** Window expires, new window starts from attacker's price. This is the ATK-01 triple bypass.

**Scenario B — Short freeze (<50 slots):** The window is still "active" with the old reference. The cumulative deviation check fires against the pre-freeze `window_ref_price`. But the actual market price may have moved legitimately during the freeze. If it moved significantly, the first post-unfreeze update gets rejected (false negative — legitimate price blocked). The cranker must wait for the window to expire (~20 seconds from the old window start), during which the oracle has no valid price.

**Attack Steps (Scenario B - griefing):**
1. Observe a volatile market where an admin might freeze the oracle briefly (e.g., incident response).
2. After unfreeze, if the window hasn't expired, the legitimate post-unfreeze price (which reflects real market movement during freeze) is rejected by the stale window check.
3. Oracle remains at price=0 (set on unfreeze) until the window expires.
4. All trading, liquidation, and funding operations fail during this window (price=0 fails validation).

**Impact:** After short freezes during volatile markets, the oracle can be stuck at price=0 for up to 50 slots (~20 seconds), blocking all protocol operations for that market.

**Recommendation:**
- On unfreeze, reset `window_ref_price` to `pre_freeze_price` and `window_ref_slot` to the current slot. This starts a fresh window anchored to a known-good price.

---

## [ATK-07] Dynamic Insurance Floor Circumvention via Cross-Epoch Balance Inflation

**Target Fix:** Dynamic insurance floor (#3)
**Severity:** Medium
**Feasibility:** Theoretical (requires significant capital + epoch cap bug from ATK-04)

**Description:**
The dynamic floor is `max(configured_floor, ins_bal / 5)`. The epoch cap is `ins_bal * 30% / 10000`. Both are computed from the current `ins_bal` at call time, not from the epoch-start balance. Insurance fees from liquidations increase `ins_bal` mid-epoch.

If the epoch reset were working (ignoring ATK-04), an attacker could:
1. Early in the epoch, credit insurance with fees from self-liquidation of collateralized positions.
2. The inflated `ins_bal` raises the epoch cap for subsequent payouts.
3. Drain more than intended from the original balance.

With ATK-04 (epoch never resets), this is moot because the fund is already permanently locked after initial payouts.

Assuming ATK-04 is fixed:
- ins_bal=100, epoch starts, cap=30
- Attacker self-liquidates, crediting 20 to insurance → ins_bal=120, cap=36
- 6 additional units can be drained beyond the original cap

**Impact:** With a working epoch reset, attackers can inflate the per-epoch cap by ~30% of any insurance fees they generate. The economic cost (collateral lost to self-liquidation) likely exceeds the benefit in most cases.

**Recommendation:**
- Compute epoch cap from a snapshot of `ins_bal` at epoch start (stored as `insurance_epoch_start_balance`), not from the live balance.

---

## [ATK-08] TWAP Cap Circumventable via Transaction Splitting

**Target Fix:** TWAP single-trade cap (#5)
**Severity:** Medium
**Feasibility:** Practical

**Description:**
The TWAP cap limits each trade's weight to `market.k / 10`. However, an attacker can split a large trade across multiple transactions (1 per slot due to the holding period), each contributing up to `k/10` to the TWAP. Over N slots, total TWAP contribution = N × k/10 × manipulated_price.

For normal-sized markets, `k` is large (minimum `1e18`), so `k/10 = 1e17`. A trade with notional < 1e17 isn't capped at all. The cap only matters for whale-sized trades.

For smaller markets, the cap is tighter but the TWAP can still be dominated by consistent one-directional trading:
- Slot N: Open small long (push mark up) → TWAP records high mark
- Slot N+1: Close long (mark comes back down, but the TWAP sample is already recorded)
- Slot N+2: Open small long again → TWAP records high mark again

Each round-trip costs trading fees (2× 0.03%+ of notional) but biases the TWAP upward.

**Attack Steps:**
1. Over 100 slots, open and close small long positions, each sized just under `k/10` notional.
2. Each trade samples the mark price BEFORE the swap (pre-trade mark is sampled in open_position).
3. The cumulative TWAP is biased toward the higher mark prices from the long-side pressure.
4. When funding rate is computed from TWAP, it's biased in the attacker's favor.

**Impact:** TWAP manipulation for funding rate arbitrage. Cost is trading fees; profit depends on the funding rate differential × position size. For large positions, this can be profitable.

**Recommendation:**
- The cap is a good first step. Additional defenses:
  - Use time-weighted (slot-weighted) TWAP instead of volume-weighted TWAP to prevent weighting manipulation.
  - Or add a per-address TWAP contribution cap per funding period.
  - Consider sampling mark price AFTER the swap (post-trade mark) to capture the actual price impact rather than the pre-impact price.

---

## [ATK-09] Circuit Breaker Blocks Legitimate Liquidations During Sharp Price Moves

**Target Fix:** Circuit breaker (#1) + Liquidation freshness (#6) interaction
**Severity:** Medium
**Feasibility:** Practical (happens naturally in volatile markets)

**Description:**
When the real market price moves sharply (e.g., flash crash), the circuit breaker prevents oracle updates from reflecting the move. The oracle timestamp becomes stale. The 5-second liquidation freshness check then rejects the stale oracle. Net effect: positions that became underwater due to the sharp move cannot be liquidated while the circuit breaker is active.

This creates a window where:
1. Real price has crashed 20% (exceeds circuit breaker threshold).
2. Oracle can only update by walking the EMA gradually (~1% per slot).
3. It takes ~20-70 slots (8-28 seconds) for the oracle to reflect the true price.
4. During this time, underwater positions cannot be liquidated (stale oracle).
5. The deficit grows as the real price continues to move.

**Impact:** Systematic delay in liquidations during exactly the market conditions when liquidations are most needed. This increases protocol deficit and ADL burden.

**Recommendation:**
- This is a design tension with no perfect solution. Options:
  1. **Emergency mode:** If circuit breaker rejects N consecutive updates, auto-widen the threshold temporarily.
  2. **Liquidation uses wider staleness during circuit breaker events:** If the oracle's last update was rejected by the circuit breaker (detectable via a flag), allow liquidation to use up to 15-second-old prices.
  3. **Accept the tradeoff:** Document that the circuit breaker intentionally delays liquidations to prevent oracle manipulation attacks that would cause worse damage than the delay.

---

## [ATK-10] Window Band Multiplier Permits 3× Per-Update Move in Single Update

**Target Fix:** Sliding window banding (#2)
**Severity:** Low
**Feasibility:** Practical

**Description:**
The sliding window max is `max_price_change_bps × WINDOW_BAND_MULTIPLIER (3)`. This means within a single 50-slot window, the cumulative price change can be up to 3× the per-update band. But critically, this entire 3× move can happen in a **single update** — the first update of a new window.

When a new window starts (after the previous window expired), `window_ref_price` is set to `params.price`. The next update within the window checks `|new_price - window_ref_price| <= 3 × max_price_change_bps`. So the second update in a window can move 3× the per-update band from the first update's price.

Wait — re-reading the code, the per-update banding check happens BEFORE the sliding window check. So each individual update is still constrained by `max_price_change_bps` (checked against `oracle.price`). The sliding window is an additional constraint on cumulative movement. So the scenario above is prevented by the per-update check.

**Corrected analysis:** The per-update banding checks `|params.price - reference_price| <= max_price_change_bps` where `reference_price = oracle.price`. The sliding window checks `|params.price - window_ref_price| <= 3 × max_price_change_bps`. Within 50 slots, an attacker can make at most 50 updates (1 per slot), each moving the per-update band. The cumulative movement is capped at 3×, not 50×.

**This fix is solid.** The interaction between per-update banding and sliding window correctly limits both individual and cumulative movement.

**Impact:** Informational — the sliding window correctly constrains cumulative movement.

---

## [ATK-11] Both Protections Simultaneously Disableable — Oracle Completely Unguarded

**Target Fix:** Circuit breaker (#1), Sliding window (#2)
**Severity:** Low (requires admin action, but documenting for completeness)
**Feasibility:** Requires admin

**Description:**
`max_price_change_bps = 0` disables per-update banding AND sliding window (both check `if max_change_bps > 0` before executing).
`circuit_breaker_deviation_bps = 0` disables the circuit breaker (checks `if cb_bps > 0`).

Both can be set via `update_oracle_config` (requires admin + frozen oracle). With both set to 0, the oracle has zero price validation beyond `price > 0 && price <= MAX_ORACLE_PRICE`.

Unlike `max_price_change_bps` (which uses `MIN_PRICE_CHANGE_BPS = 100` as minimum when non-zero), the circuit breaker has no minimum validation at all.

**Impact:** A compromised admin can silently remove all oracle protections. While any admin compromise is severe, the protocol should enforce minimum safety guarantees.

**Recommendation:**
- Require at least one of circuit_breaker or banding to be non-zero at all times.
- Add a protocol-level constant `MIN_CIRCUIT_BREAKER_BPS` (e.g., 500 = 5%) when non-zero.

---

## Fixes Verified as Solid

### Dynamic Insurance Floor (#3)
✅ `max(configured_floor, ins_bal / 5)` correctly prevents the floor from being bypassed by setting `insurance_floor = 0`. The dynamic component ensures at least 20% of the fund is always reserved. The only issue is ATK-04 (epoch never resets), which blocks the entire mechanism.

### TWAP Single-Trade Cap (#5)
✅ Applied consistently across all 4 TWAP accumulation points (open_position, close_position, execute_trigger_order, update_amm). The cap `market.k / 10` is reasonable — it prevents a single whale trade from dominating the TWAP while allowing normal-sized trades to contribute fully.

### Expanded update_oracle_config (#7)
✅ All Optional fields correctly handled. Validation for `min_sources`, `max_staleness_seconds`, and `max_price_change_bps` is present and correct. The oracle must be frozen before config changes (M-02 fix), preventing live config manipulation. Only gap: circuit breaker validation (ATK-05).

### _reserved Offset Constants (#8)
✅ Offsets are centralized in `constants.rs` and used consistently across all files. No overlapping ranges. Layout:
- `[0]`: unfreeze_pending flag
- `[1..3]`: max_price_change_bps (u16 LE)
- `[3..11]`: pre_freeze_price (u64 LE)
- `[11..19]`: window_ref_price (u64 LE)
- `[19..27]`: window_ref_slot (u64 LE)
- `[27..29]`: circuit_breaker_bps (u16 LE)
- `[29..64]`: unused (35 bytes)

No collisions, no endianness issues.

---

## Summary

| ID | Title | Severity | Feasibility |
|----|-------|----------|-------------|
| ATK-01 | Post-Unfreeze Triple Bypass | Critical | Practical |
| ATK-02 | EMA Walking Attack | High | Practical |
| ATK-03 | Liquidation Freshness Shadows Fallback Oracle | High | Practical |
| ATK-04 | Insurance Epoch Payout Never Resets | High | Practical |
| ATK-05 | Circuit Breaker No Validation Bounds | Medium | Requires Admin |
| ATK-06 | Sliding Window Stale After Short Freeze | Medium | Practical |
| ATK-07 | Dynamic Floor Cross-Epoch Inflation | Medium | Theoretical |
| ATK-08 | TWAP Cap Circumventable via Splitting | Medium | Practical |
| ATK-09 | Circuit Breaker Blocks Legitimate Liquidations | Medium | Practical |
| ATK-10 | Window Band Multiplier Analysis | Informational | N/A |
| ATK-11 | Both Protections Simultaneously Disableable | Low | Requires Admin |

**Critical: 1 | High: 3 | Medium: 5 | Low: 1 | Informational: 1**
