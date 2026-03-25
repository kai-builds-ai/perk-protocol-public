# Apex Red Team Audit — Round 3

**Auditor:** Kai (AI Security Auditor)  
**Date:** 2026-03-25  
**Scope:** Verify Round 2 fixes (ATK-01 through ATK-06) and hunt remaining attack vectors  
**Severity Scale:** Critical / High / Medium / Low / Informational

---

## Executive Summary

All five Round 2 fixes are **correctly implemented** and achieve their stated security goals. The code is well-structured with clear comments tracing each fix to its original finding.

One new **Low severity** finding was identified (rapid freeze/unfreeze cycling without intermediate updates), plus two **Informational** observations. No Critical, High, or Medium issues found.

---

## Round 2 Fix Verification

### ✅ ATK-01 Fix: EMA Anchoring on Unfreeze

**Location:** `freeze_perk_oracle.rs:46-56`

**Verification:**
- On unfreeze, `ema_price` is set to `pre_freeze_price` (the oracle's price at the moment of unfreeze) — **correct**
- This ensures the circuit breaker has a meaningful reference for the first post-unfreeze update
- The EMA update path in `update_perk_oracle.rs` handles `ema_price > 0` correctly (uses the weighted formula, not the "first update" path)

**Edge case — pre-freeze price was 0 (oracle never updated):**
- If `oracle.price == 0` at unfreeze time, `ema_price` is set to 0
- First post-unfreeze update: `ema_price == 0` triggers the "first update" path → `ema_price = params.price`
- Circuit breaker: `old_ema == 0` skips the check — **acceptable**, same as fresh initialization
- Banding: `reference_price == 0` skips the check — **acceptable**, no reference exists

**Verdict: PASS.** The fix is correct. The zero-EMA edge case is equivalent to normal oracle initialization and is handled identically.

---

### ✅ ATK-01/ATK-06 Fix: Window Reset on Unfreeze

**Location:** `freeze_perk_oracle.rs:51-55`

**Verification:**
- Window reference price is set to `pre_freeze_price`
- Window reference slot is set to `clock.slot` (current slot at unfreeze)
- This prevents both stale window references (from long freeze) and window expiry bypass

**Post-unfreeze update flow:**
1. Cranker submits update at slot N ≥ unfreeze slot
2. `slots_since = N - unfreeze_slot` — within window if ≤ 50 slots
3. Cumulative deviation checked against `pre_freeze_price * WINDOW_BAND_MULTIPLIER`
4. Both per-update banding AND sliding window are active on first update

**Verdict: PASS.** Window reset correctly anchors to pre-freeze state.

---

### ✅ ATK-03 Fix: Removed 5-Second Liquidation Freshness Check

**Location:** `liquidate.rs:71-73` (comment at removal site)

**Verification:**
- The 5-second freshness check was removed from the liquidation handler
- Oracle integrity now relies on: (a) per-source staleness (15s Pyth / configurable PerkOracle), (b) circuit breaker, (c) per-update banding, (d) sliding window

**Does removing the 5s check leave a gap?**
- The 5s check was shadowing fallback oracle resolution: primary at 7s age passes its own 15s limit but failed the 5s liquidation check, preventing fallback from being tried
- Without the 5s check, oracle prices up to 15s old can be used for liquidation
- This is **standard practice** across DeFi protocols (Drift, Mango, etc.)
- The circuit breaker prevents stale-price manipulation within this window

**Verdict: PASS.** The removal is correct. Standard staleness + circuit breaker is sufficient.

---

### ✅ ATK-04 Fix: Insurance Epoch Reset in Liquidate Handler

**Location:** `liquidate.rs:75-80`

**Verification:**
```rust
let epoch_elapsed = clock.unix_timestamp.saturating_sub(market.insurance_epoch_start);
if epoch_elapsed >= crate::constants::INSURANCE_EPOCH_SECONDS {
    market.insurance_epoch_start = clock.unix_timestamp;
    market.insurance_epoch_payout = 0;
}
```

**Race condition analysis with crank_funding:**
- Both handlers reset the epoch independently when 24h has elapsed
- If both execute in the same slot: first resets (start=now, payout=0), second sees elapsed=0 < 86400 → no-op
- The `insurance_epoch_payout` accumulator is additive — both handlers correctly increment it via `use_insurance_buffer`
- No double-counting: the epoch cap is checked atomically within each call to `use_insurance_buffer`

**Double-reset exploit analysis:**
- Worst case: epoch resets in both handlers at the boundary → payout counter starts fresh
- This is **identical** to a single reset — the epoch is 24 hours, and the reset is idempotent within the same second
- An attacker cannot trigger multiple resets per epoch because `epoch_elapsed >= 86400` is required

**Verdict: PASS.** The defense-in-depth reset is safe. No race condition or double-reset exploit.

---

### ✅ ATK-05 Fix: Circuit Breaker Bounds Validation

**Location:** `constants.rs:118-119`, `initialize_perk_oracle.rs:55-60`, `update_oracle_config.rs:60-68`

**Verification:**
- `MIN_CIRCUIT_BREAKER_BPS = 500` (5%) — prevents admin from setting trivially tight bounds that DoS the oracle
- `MAX_CIRCUIT_BREAKER_BPS = 9999` (99.99%) — prevents overflow in deviation calculation
- Both `initialize_perk_oracle` and `update_oracle_config` enforce: `bps == 0 || bps >= 500 && bps <= 9999`

**Can circuit breaker still be disabled (0)?**
- Yes, `circuit_breaker_deviation_bps == 0` is explicitly allowed in both handlers
- This is by design: memecoin oracles need high volatility tolerance
- When disabled, per-update banding + sliding window still provide protection (if `max_price_change_bps > 0`)

**Are the bounds reasonable?**
- 5% minimum: prevents griefing via tight thresholds — reasonable
- 99.99% maximum: `deviation_bps = deviation * 10_000 / ema`. Max price is 1e12, so max `deviation * 10_000 = 1e16`, well within u64 range (~1.8e19) — no overflow
- Intentional gap: admin can set 0 (disabled) or [500, 9999], but NOT [1, 499] — prevents dangerously tight configurations

**Verdict: PASS.** Bounds are well-reasoned and correctly enforced in all code paths.

---

## New Attack Vector Analysis

### ATK-R3-01: Rapid Freeze/Unfreeze Cycling Without Intermediate Updates [LOW]

**Attack scenario:**
1. Admin freezes oracle (price=100, ema=100)
2. Admin unfreezes → pre_freeze_price=100, ema=100, price=0, window_ref=100
3. **No cranker update happens**
4. Admin freezes again → price=0 (from step 2's zeroing)
5. Admin unfreezes → pre_freeze_price=**0**, ema=**0**, window_ref=**0**
6. First cranker update: circuit breaker skipped (old_ema=0), banding skipped (reference=0), gap check bypassed (unfreeze_pending)

**Impact:** After rapid cycling without intermediate updates, ALL oracle protections reset to uninitialized state. The first post-cycle update can set any arbitrary price within normative bounds (≤ 1e12).

**Mitigating factors:**
- Requires admin key (admin is already fully trusted with protocol configuration)
- Admin could achieve the same result by: freezing → setting `max_price_change_bps=0` and `circuit_breaker_deviation_bps=0` → unfreezing
- Admin could also change the oracle authority directly
- No path for non-admin exploitation

**Recommendation (optional hardening):**
In the unfreeze path, add a check: if `oracle.price == 0` (never updated or already unfroze-without-update), preserve the existing `pre_freeze_price` from `_reserved` rather than overwriting with 0:

```rust
let pre_freeze_price = if oracle.price > 0 {
    oracle.price
} else {
    // Preserve existing pre-freeze reference from _reserved
    u64::from_le_bytes(oracle._reserved[RESERVED_OFFSET_PRE_FREEZE_PRICE..RESERVED_OFFSET_PRE_FREEZE_PRICE + 8]
        .try_into().unwrap_or([0u8; 8]))
};
```

**Severity: Low** — admin-only, defense-in-depth improvement.

---

### ATK-R3-02: Same-Slot Unfreeze + Update [INFORMATIONAL]

**Scenario:** Cranker submits an update transaction in the same slot as the admin's unfreeze transaction.

**Analysis:**
- After unfreeze: `oracle.last_slot` retains its pre-freeze value (not reset)
- If `current_slot > oracle.last_slot`, the update passes the rate limit check
- This is possible and **intentional** — the unfreeze + first update can occur in the same slot
- All protections apply: banding against pre-freeze price, window check, circuit breaker (if ema > 0)

**Verdict: No vulnerability.** This is correct behavior — minimizes time between unfreeze and price restoration.

---

### ATK-R3-03: Primary vs Fallback Oracle Selection Manipulation [INFORMATIONAL]

**Scenario:** Attacker tries to force the protocol to use the fallback oracle (which might have a more favorable price).

**Analysis:**
- `read_oracle_price_with_fallback` tries primary first, falls back only on failure
- Fallback account is validated against `market.fallback_oracle_address` (Market PDA, immutable to attacker)
- Attacker cannot inject a fake fallback — address is checked: `*fallback_account.key == *expected_fallback_address`
- To force fallback, attacker would need to make primary oracle fail (stale/frozen) — requires admin access or cranker DoS
- Cranker DoS (network-level) is outside protocol's threat model

**Additional observation:** The `OracleSource::DexPool` variant returns `DexPoolOracleNotSupported`, preventing DEX pool manipulation as a fallback vector.

**Verdict: No vulnerability.** Fallback selection is correctly secured.

---

### ATK-R3-04: Insurance Epoch Cap Interaction Across Handlers [INFORMATIONAL]

**Scenario:** Both `liquidate` and `crank_funding` reset the insurance epoch. Can an attacker drain more insurance by timing resets?

**Detailed analysis of `use_insurance_buffer`:**
```rust
let epoch_cap = (ins_bal * INSURANCE_EPOCH_CAP_BPS as u128) / 10_000;
let epoch_remaining = epoch_cap.saturating_sub(market.insurance_epoch_payout as u128);
let capped_available = core::cmp::min(available, epoch_remaining);
```

- `epoch_cap` is computed from **current** insurance balance (dynamic, decreases as insurance is spent)
- `epoch_remaining` decreases monotonically within an epoch
- After epoch reset: `insurance_epoch_payout = 0`, cap refreshes based on new (lower) balance
- **Self-regulating:** as insurance drains, the cap shrinks proportionally

**Race scenario:** If liquidate resets the epoch at second T, and crank_funding also runs at second T:
- Both see `epoch_elapsed >= 86400` → both reset
- Result: `insurance_epoch_start = T, insurance_epoch_payout = 0`
- Identical to a single reset — no extra payout capacity created

**Verdict: No vulnerability.** The epoch cap is self-limiting and idempotent.

---

## Code Quality Observations

### Positive Findings

1. **Clear fix traceability:** Every fix is tagged with its finding ID (ATK-01 R2, ATK-03 R2, etc.) — excellent for audit trail
2. **Defense-in-depth approach:** Insurance epoch reset in both liquidate and crank_funding covers low-activity markets
3. **Atomic state transitions:** EMA update + circuit breaker check + price update are all within one handler — Solana's atomic transactions ensure no partial state on revert
4. **Conservative EMA cap:** `raw_ema.min(MAX_ORACLE_PRICE)` prevents EMA corruption from extreme prices (M-01 fix still solid)
5. **Reserved field layout:** Non-overlapping offsets with explicit constants — no field collision risk

### Minor Observations (No Action Required)

- The `_reserved` field pattern works but is fragile for future extensions. Consider a dedicated struct if more fields are needed.
- The `unfreeze_pending` flag at `_reserved[0]` uses raw byte manipulation. A bool accessor function would improve readability.
- The `INSURANCE_EPOCH_CAP_BPS` is 3000 (30%). Combined with the dynamic floor (20% of insurance balance), max single-epoch drain is effectively 30% × 80% = 24% of insurance. This is conservative and appropriate.

---

## Summary Table

| ID | Finding | Severity | Status |
|---|---|---|---|
| ATK-01 R2 | EMA anchoring on unfreeze | — | ✅ Verified correct |
| ATK-03 R2 | Removed 5s freshness check | — | ✅ Verified correct |
| ATK-04 R2 | Insurance epoch reset in liquidate | — | ✅ Verified correct |
| ATK-05 R2 | Circuit breaker bounds validation | — | ✅ Verified correct |
| ATK-06 R2 | Window reset on unfreeze | — | ✅ Verified correct |
| ATK-R3-01 | Rapid freeze/unfreeze cycling | Low | New — optional hardening |
| ATK-R3-02 | Same-slot unfreeze + update | Info | No vulnerability |
| ATK-R3-03 | Primary vs fallback oracle manipulation | Info | No vulnerability |
| ATK-R3-04 | Insurance epoch cross-handler interaction | Info | No vulnerability |

---

## Conclusion

**The Round 2 fixes are solid.** All five fixes correctly address their target vulnerabilities without introducing regressions. The code demonstrates good security engineering practices:

- Protections layer correctly (banding → circuit breaker → sliding window → staleness)
- Edge cases at boundaries (zero prices, epoch transitions, rapid admin actions) are handled
- Admin trust model is consistent — admin has full config control, non-admin users cannot exploit oracle state

The one Low finding (ATK-R3-01) is an optional hardening for a strictly admin-only path. The protocol's security posture is strong for production deployment.
