# PerkOracle Security Audit — Pashov Style (Round 1)

Date: 2026-03-25

Auditor: Kai (AI Security Auditor)

Scope: PerkOracle system — custom oracle for Perk Protocol (permissionless perps DEX on Solana). Includes oracle state, all oracle instructions (initialize, update, freeze, transfer authority, config update, set fallback), oracle reader/fallback engine, and integration with position lifecycle instructions (open, close, liquidate, execute trigger order).

---

## Summary

The PerkOracle system is well-designed with defense-in-depth. Multiple prior audit rounds have addressed critical issues (C-01 banding bypass, H-01 stale price after unfreeze). The current codebase shows strong security posture: PDA-based account validation, proper owner checks, checked arithmetic throughout, staleness enforcement, frozen-state enforcement, and a carefully constructed fallback mechanism with address pinning.

**No critical findings.** The architecture correctly isolates cranker authority (write-only, no fund access), enforces fail-closed semantics (stale/frozen → revert, never use bad price), and validates fallback oracle identity against on-chain market state.

However, I identified **1 High**, **3 Medium**, and **5 Low/Informational** findings primarily around edge cases in the `_reserved` field encoding, operational inflexibility, and minor integration concerns.

**Overall assessment: Production-ready with minor fixes recommended.** The system's invariants hold under adversarial conditions. The most significant risk is operational (inability to reconfigure oracle parameters post-init) rather than exploitable.

---

## Critical Findings

*None identified.*

---

## High Findings

### [H-01] Double Freeze/Unfreeze Cycle Bypasses Price Banding on First Post-Unfreeze Update

**Severity:** High

**Location:** `freeze_perk_oracle.rs:27-35`, `update_perk_oracle.rs:52-65`

**Description:**
When an oracle is unfrozen, the handler stores `oracle.price` in `_reserved[3..11]` as the pre-freeze reference price for post-unfreeze banding, then zeros `oracle.price`. If an admin performs a double freeze/unfreeze cycle *without* any cranker update in between:

1. First unfreeze: stores legitimate pre-freeze price in `_reserved[3..11]`, zeros `oracle.price`.
2. Freeze again: just sets `is_frozen = true`. Does NOT touch `_reserved[3..11]`.
3. Second unfreeze: stores `oracle.price` (which is 0 from step 1) into `_reserved[3..11]`, zeros price again.

Now `_reserved[3..11]` contains `0u64`. In `update_perk_oracle`, the banding logic checks:
```rust
let reference_price = if oracle.price > 0 {
    oracle.price
} else {
    u64::from_le_bytes(oracle._reserved[3..11]) // = 0
};
if reference_price > 0 { /* apply banding */ }
// reference_price == 0 → "true first-ever update" → NO BANDING
```

The first post-unfreeze update is completely unbanded, allowing the cranker to post any price up to `MAX_ORACLE_PRICE`.

**Impact:**
A compromised cranker combined with an admin performing a double unfreeze (even legitimately, e.g., accidental freeze-unfreeze) can post an arbitrary price on the first update, potentially enabling oracle manipulation for position opening/liquidation. While both admin AND cranker compromise are needed, the banding system is specifically designed to limit cranker damage even under compromise — this finding bypasses that defense.

**Recommendation:**
In the freeze handler, only store pre-freeze price when it's non-zero:
```rust
if !frozen {
    let current_price = oracle.price;
    if current_price > 0 {
        let pre_freeze_bytes = current_price.to_le_bytes();
        oracle._reserved[3..11].copy_from_slice(&pre_freeze_bytes);
    }
    // If price is already 0 (from prior unfreeze), keep the existing _reserved[3..11]
    oracle.price = 0;
    oracle.ema_price = 0;
    oracle._reserved[0] = 1;
}
```

---

## Medium Findings

### [M-01] No Confidence Bounds Validation in `update_perk_oracle`

**Severity:** Medium

**Location:** `update_perk_oracle.rs` — `handler()` function

**Description:**
The `update_perk_oracle` instruction accepts `confidence: u64` without any validation. While `read_perk_oracle_price` rejects oracles with `confidence > price * 2%`, a malicious or buggy cranker can post a valid price with absurdly high confidence, making the oracle fail the read-time confidence check and effectively bricking it until the next update.

Unlike posting price=0 (which is rejected by the update handler), posting a valid price with high confidence passes ALL update checks but makes the oracle unreadable. This creates an asymmetric DoS: the oracle *appears* updated (non-zero price, recent timestamp) but fails all read attempts.

**Impact:**
A compromised cranker can render any PerkOracle-dependent market non-functional by posting valid prices with inflated confidence. Since staleness checks pass (timestamp is fresh), the fallback oracle won't trigger — the primary oracle read fails with `OracleConfidenceTooWide`, not staleness. This is a subtle DoS vector.

**Recommendation:**
Add confidence validation in the update handler:
```rust
let max_conf = params.price
    .checked_mul(ORACLE_CONFIDENCE_BPS as u64)
    .ok_or(PerkError::MathOverflow)?
    / BPS_DENOMINATOR;
require!(params.confidence <= max_conf, PerkError::OracleConfidenceTooWide);
```

### [M-02] Oracle Parameters (`min_sources`, `max_staleness_seconds`) Immutable After Initialization

**Severity:** Medium

**Location:** `initialize_perk_oracle.rs`, `update_oracle_config.rs`

**Description:**
The `update_oracle_config` instruction only allows changing `max_price_change_bps`. There is no mechanism to update `min_sources` or `max_staleness_seconds` after oracle initialization.

In production, operational needs change:
- A new price source becomes available (want to increase `min_sources` from 2 to 3)
- Network congestion requires temporarily increasing `max_staleness_seconds`
- A source goes permanently offline (need to decrease `min_sources`)

The only recourse is to deploy a new oracle (different mint = impossible, same mint = PDA collision) or modify the program.

**Impact:**
Operational inflexibility. If a price source permanently goes offline and `min_sources` can't be lowered, the oracle becomes permanently unusable (cranker can't meet the source requirement). The market using this oracle would halt with no on-chain recovery path.

**Recommendation:**
Extend `UpdateOracleConfigParams` to include optional `min_sources` and `max_staleness_seconds` fields with the same validation bounds as initialization:
```rust
pub struct UpdateOracleConfigParams {
    pub max_price_change_bps: u16,
    pub min_sources: Option<u8>,
    pub max_staleness_seconds: Option<u32>,
}
```

### [M-03] Fallback Oracle Doesn't Trigger on Confidence Failure

**Severity:** Medium

**Location:** `engine/oracle.rs:168-193` (`read_oracle_price_with_fallback`)

**Description:**
The fallback mechanism activates when the primary oracle read returns `Err(_)`. The `read_perk_oracle_price` function returns `Err(OracleConfidenceTooWide)` when confidence is too high. So fallback DOES trigger on confidence failure — this is correct.

However, the fallback function catches ALL errors from the primary read:
```rust
match read_oracle_price(primary_source, primary_account, current_time) {
    Ok(result) => Ok(result),
    Err(primary_err) => { /* try fallback */ }
}
```

This means if the primary oracle has a *deserialization* error (corrupt data, wrong account type accidentally set via admin_update_market), the fallback silently takes over without any signal. There's no way to distinguish "expected fallback activation" (staleness, frozen) from "unexpected primary corruption."

**Impact:**
Silent fallback activation on unexpected primary failures could mask critical issues. In particular, if an admin accidentally sets the wrong account as the primary oracle (via `admin_update_market`), the system would silently fall through to the fallback without any alert, potentially using a less reliable price source indefinitely.

**Recommendation:**
Emit distinct log messages for fallback activation reason. Consider adding an on-chain counter for fallback activations:
```rust
Err(primary_err) => {
    msg!("Primary oracle failed: {:?}, attempting fallback", primary_err);
    // ... fallback logic
}
```

---

## Low / Informational

### [L-01] Spec/Implementation Type Mismatch for `price` and `ema_price`

**Severity:** Informational

**Location:** `PERK-ORACLE-SPEC.md` vs `state/perk_oracle.rs`

**Description:**
The spec defines `price: i64` and `ema_price: i64` (signed), but the implementation uses `price: u64` and `ema_price: u64` (unsigned). The implementation is actually *better* — prices should never be negative, and unsigned types enforce this at the type level. However, the spec/code mismatch could cause confusion for integrators or SDK developers.

**Recommendation:**
Update the spec to reflect the actual types (`u64`).

### [L-02] `_reserved` Field Encoding Lacks Documentation and Safety Abstraction

**Severity:** Low

**Location:** `state/perk_oracle.rs`, `initialize_perk_oracle.rs`, `update_perk_oracle.rs`, `freeze_perk_oracle.rs`, `update_oracle_config.rs`

**Description:**
The `_reserved` field is used as a structured data store with specific byte offsets:
- `[0]`: unfreeze_pending flag
- `[1..3]`: max_price_change_bps (u16 LE)
- `[3..11]`: pre-freeze reference price (u64 LE)
- `[11..64]`: unused

This layout is spread across 4 different instruction files with raw byte manipulation. There are no helper functions, no constants for offsets, and no documentation on the layout in the state definition. This is fragile and error-prone for future development.

**Recommendation:**
Create named constants and helper methods:
```rust
impl PerkOraclePrice {
    const RESERVED_UNFREEZE_FLAG: usize = 0;
    const RESERVED_BANDING_BPS: std::ops::Range<usize> = 1..3;
    const RESERVED_PREFREEZE_PRICE: std::ops::Range<usize> = 3..11;

    pub fn unfreeze_pending(&self) -> bool { self._reserved[0] == 1 }
    pub fn max_price_change_bps(&self) -> u16 { ... }
    pub fn pre_freeze_price(&self) -> u64 { ... }
}
```

### [L-03] `update_perk_oracle` Missing Protocol Paused Check

**Severity:** Low

**Location:** `update_perk_oracle.rs`

**Description:**
The `update_perk_oracle` instruction does not check `protocol.paused`. It doesn't even take a `Protocol` account. This means oracle updates continue even when the protocol is paused.

This is likely intentional — keeping oracles fresh during a pause prevents staleness issues when the protocol resumes. However, it's undocumented and could surprise operators who expect a full pause to stop all activity.

**Recommendation:**
Document this as intentional behavior in the spec. If paused oracles are desired for some emergency scenarios, consider adding an optional `protocol` account and only enforcing the pause check when present.

### [L-04] EMA Smoothing Factor Hardcoded

**Severity:** Informational

**Location:** `update_perk_oracle.rs:71-80`

**Description:**
The EMA calculation uses a fixed 10% new / 90% old weighting (`(price + 9 * old_ema) / 10`). This can't be configured per oracle. For volatile memecoins, a faster EMA (e.g., 20/80) might be more appropriate. For stablecoins, a slower EMA (5/95) would reduce noise.

Currently EMA is not consumed by any on-chain instruction (noted as "non-critical"), so this is purely informational.

**Recommendation:**
If EMA is ever used for on-chain decisions (e.g., circuit breakers, banding reference), make the smoothing factor configurable via `_reserved` or a dedicated field.

### [L-05] `transfer_oracle_authority` Allows Admin to Silently Hijack Oracle Authority

**Severity:** Low

**Location:** `transfer_oracle_authority.rs:30-35`

**Description:**
The admin can transfer oracle authority without the current authority's knowledge or consent (M-04 fix for emergency recovery). While this is documented and intentional, there's no on-chain event distinguishing an admin-initiated transfer from an authority-initiated one beyond the `msg!` log.

In a scenario where the admin is compromised, the attacker can silently replace the oracle authority with their own key, then post manipulated prices. The legitimate cranker would only discover this when their next update fails with `has_one = authority` constraint.

**Impact:**
Admin compromise already implies full control, so this doesn't expand the attack surface. However, the lack of a distinct event type makes post-incident forensics harder.

**Recommendation:**
Consider adding a timelock or two-step transfer for admin-initiated authority changes, similar to the admin_transfer pattern for protocol admin. At minimum, emit a distinct event (not just msg!) for admin-override transfers.

---

## Gas Optimizations

### [G-01] `read_perk_oracle_price` Deserializes Full Account Unnecessarily

**Severity:** Gas

**Location:** `engine/oracle.rs:46-67`

**Description:**
`read_perk_oracle_price` calls `PerkOraclePrice::try_deserialize()` which processes the entire 192-byte account including the 64-byte `_reserved` field. The reader only needs: `is_frozen`, `price`, `confidence`, `timestamp`, `num_sources`, `min_sources`, `max_staleness_seconds`. This is ~25 bytes of useful data out of 192.

On Solana, deserialization cost is proportional to account size. For a hot path called on every trade, this adds unnecessary CU consumption.

**Recommendation:**
Consider using zero-copy deserialization (`#[account(zero_copy)]`) or manual byte-offset reads for the oracle reader path:
```rust
// Direct byte reads instead of full deserialization
let is_frozen = data[offset_is_frozen] != 0;
let price = u64::from_le_bytes(data[offset_price..offset_price+8].try_into().unwrap());
// etc.
```

### [G-02] `update_perk_oracle` Reads `_reserved` Bytes Twice for Banding Check

**Severity:** Gas (Minor)

**Location:** `update_perk_oracle.rs:41-42, 52-54`

**Description:**
The unfreeze_pending flag and max_change_bps are read from `_reserved` as separate operations. These could be read once and destructured.

**Recommendation:**
Minor — combine reads:
```rust
let (unfreeze_pending, max_change_bps, pre_freeze_price) = (
    oracle._reserved[0] == 1,
    u16::from_le_bytes([oracle._reserved[1], oracle._reserved[2]]),
    u64::from_le_bytes(oracle._reserved[3..11].try_into().unwrap_or([0u8; 8])),
);
```

---

## Positive Observations

The following security properties were verified and found to be correctly implemented:

1. **Re-initialization prevention:** PDA seeds `[b"perk_oracle", token_mint]` with Anchor's `init` constraint prevent duplicate oracles per mint. ✅

2. **Frozen oracle rejection:** Both `update_perk_oracle` (write path) and `read_perk_oracle_price` (read path) check `is_frozen`. A frozen oracle cannot be updated OR read. ✅

3. **Staleness enforcement:** Read path validates `age <= max_staleness_seconds`. Stale oracles cause instruction reverts (fail-closed). ✅

4. **Gap attack protection:** The `2x max_staleness` gap check in update prevents stale→wild-jump exploitation. The unfreeze_pending bypass is correctly scoped to exactly one update. ✅

5. **Fallback injection prevention:** `read_oracle_price_with_fallback` validates `fallback_account.key == expected_fallback_address` where the expected address comes from the on-chain Market account (not user input). ✅

6. **Token mint cross-use prevention:** `validate_perk_oracle_mint` checks `oracle.token_mint == expected_mint`. PDA seeds also bind oracle to mint. ✅

7. **Oracle owner validation:** `read_perk_oracle_price` checks `oracle_account.owner == crate::ID` before deserialization, preventing spoofed oracle accounts. ✅

8. **Price bounds:** Both update (`price <= MAX_ORACLE_PRICE`) and read paths enforce the normative price bound, preventing overflow in downstream risk math. ✅

9. **Rate limiting:** One update per slot (`clock.slot > oracle.last_slot`) prevents rapid-fire price manipulation. ✅

10. **Access control separation:** Oracle authority (cranker) can only update prices. Admin controls freeze/unfreeze/config/authority-transfer. Neither can access vaults. ✅

11. **CPI safety:** No cross-program invocations in oracle instructions. The only CPI calls are in liquidate and execute_trigger_order (token transfers), which are standard SPL Token transfers with PDA signers. ✅

12. **Checked arithmetic:** All arithmetic in oracle code uses `checked_mul`, `checked_div`, `saturating_add`, etc. No unchecked overflow vectors found. ✅

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| H-01 | High | Double freeze/unfreeze bypasses price banding | Open |
| M-01 | Medium | No confidence bounds in update_perk_oracle | Open |
| M-02 | Medium | Oracle params immutable after init | Open |
| M-03 | Medium | Fallback activation masks primary corruption | Open |
| L-01 | Info | Spec/impl type mismatch (i64 vs u64) | Open |
| L-02 | Low | _reserved encoding lacks abstraction | Open |
| L-03 | Low | Missing protocol paused check in oracle update | Open |
| L-04 | Info | EMA smoothing factor hardcoded | Open |
| L-05 | Low | Admin can silently hijack oracle authority | Open |
| G-01 | Gas | Full deserialization in read path | Open |
| G-02 | Gas | Redundant _reserved reads in update | Open |
