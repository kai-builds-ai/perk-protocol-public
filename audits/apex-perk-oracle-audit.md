# Apex Security Audit — PerkOracle Implementation

**Protocol:** Perk Protocol (Solana/Anchor Perpetual Futures DEX)  
**Scope:** PerkOracle system — all oracle state, instructions, reader engine, and interactions with trading instructions  
**Date:** 2026-03-24  
**Auditor:** Apex (automated security audit)  
**Severity Scale:** Critical / High / Medium / Low / Informational

---

## Executive Summary

The PerkOracle implementation is well-structured with solid defensive patterns: checked math, rate limiting, gap attack protection, frozen state enforcement, and proper PDA derivation. However, the audit identified **1 High**, **4 Medium**, **2 Low**, and **3 Informational** findings. The most significant issue is that unfreezing an oracle serves a stale price as fresh, creating a front-runnable window for economic exploitation.

No Critical-severity issues were found. No direct fund theft vectors exist through the oracle alone, though economic exploitation is possible through the High-severity finding.

---

## Findings

### H-01: Unfreeze Serves Stale Price as Fresh — Front-Running Window

**Severity:** High

**File:** `instructions/freeze_perk_oracle.rs` (lines 28-31), `engine/oracle.rs` (read_perk_oracle_price)

**Description:**  
When an admin unfreezes an oracle, the handler resets `oracle.timestamp = clock.unix_timestamp` to prevent the gap-attack check from rejecting the first post-unfreeze cranker update. However, this also makes the **old price** pass the staleness check in `read_perk_oracle_price`. Between the unfreeze transaction and the next cranker update (at minimum 1 slot / ~400ms, but potentially longer if cranker is slow), any instruction that reads the oracle will see the stale price as valid and fresh.

```rust
// freeze_perk_oracle.rs — unfreeze path
if !frozen {
    let clock = Clock::get()?;
    oracle.timestamp = clock.unix_timestamp;  // ← stale price now looks fresh
}
```

**Impact:**  
If the real market price moved significantly while the oracle was frozen, an attacker can front-run the cranker update:

1. Oracle shows $1.00 for token X, admin freezes (e.g., suspected manipulation)
2. Real price drops to $0.50 during freeze period
3. Admin unfreezes — oracle now: `price = $1.00`, `timestamp = NOW`, `is_frozen = false`
4. Before cranker posts $0.50 update, attacker opens a SHORT position at the stale $1.00 price
5. Cranker updates oracle to $0.50
6. Attacker closes short next slot (min holding period = 1 slot) for ~50% profit on notional

The attack works in reverse (price increase → open long at stale low price).

**Proof of Concept:**
```
Slot N:   Admin TX: unfreeze_perk_oracle (price=$1.00, timestamp=NOW)
Slot N:   Attacker TX: open_position(SHORT, large_size) — oracle reads $1.00 ✓
Slot N+1: Cranker TX: update_perk_oracle(price=$0.50)
Slot N+1: Attacker TX: close_position — oracle reads $0.50, short is profitable
```

**Recommended Fix:**  
On unfreeze, invalidate the price so `read_perk_oracle_price` rejects reads until the cranker posts a fresh update:

```rust
if !frozen {
    let clock = Clock::get()?;
    oracle.timestamp = clock.unix_timestamp;
    oracle.price = 0;      // Forces read_perk_oracle_price to fail on `price > 0` check
    oracle.ema_price = 0;   // Reset EMA too — will reinitialize on next update
}
```

This ensures no instruction can use the oracle between unfreeze and the first cranker update.

---

### M-01: Fallback Oracle Is Dead Code — No Resilience Benefit

**Severity:** Medium

**Files:** `engine/oracle.rs` (read_oracle_price_with_fallback), `state/market.rs` (fallback_oracle_source, fallback_oracle_address), `instructions/open_position.rs`, `close_position.rs`, `liquidate.rs`, `deposit.rs`, `withdraw.rs`

**Description:**  
The spec defines a two-tier oracle system with fallback support. The `Market` struct has `fallback_oracle_source` and `fallback_oracle_address` fields, and `oracle.rs` has a `read_oracle_price_with_fallback` function. However:

1. **`create_market` never sets the fallback fields** — they default to `OracleSource::Pyth` and `Pubkey::default()` (zero address)
2. **No instruction exists to configure fallback** on an existing market
3. **No trading instruction calls `read_oracle_price_with_fallback`** — all use `read_oracle_price` directly
4. **No trading instruction passes a fallback oracle account** — account structs only include one oracle

The entire fallback system is implemented in the engine but never wired into the instruction layer.

**Impact:**  
The protocol has zero oracle resilience. If the primary oracle goes stale or is frozen, all trading on that market halts with no automatic fallback. The spec's Tier 1 promise (Pyth primary + PerkOracle fallback for majors) is not delivered.

**Proof of Concept:**  
Any market using Pyth as primary will have `fallback_oracle_source = Pyth` (default) and `fallback_oracle_address = Pubkey::default()`. Even if someone manually set these, `open_position` etc. only constrain `oracle.key() == market.oracle_address` and never pass a second account.

**Recommended Fix:**  
1. Add `fallback_oracle_source` and `fallback_oracle_address` params to `create_market`
2. Add an `admin_update_market_oracle` instruction to set/change fallback config
3. Add a second `/// CHECK: fallback_oracle` account to all trading instruction structs
4. Replace `read_oracle_price` calls with `read_oracle_price_with_fallback` in all trading instructions
5. Validate fallback oracle mint matches market token_mint at configuration time

---

### M-02: No Confidence Validation on PerkOracle Reads

**Severity:** Medium

**File:** `engine/oracle.rs` (read_perk_oracle_price vs read_pyth_price)

**Description:**  
Pyth oracle reads enforce a confidence band check: `conf <= price * ORACLE_CONFIDENCE_BPS / 10000` (2% max). PerkOracle reads perform **no confidence validation whatsoever**. The confidence value is stored and returned but never checked against any threshold.

```rust
// Pyth path — confidence validated
let max_conf = price_scaled.checked_mul(ORACLE_CONFIDENCE_BPS as u64)...;
require!(conf_scaled <= max_conf, PerkError::OracleConfidenceTooWide);

// PerkOracle path — confidence NOT validated
Ok(OraclePrice {
    price: oracle.price,
    confidence: oracle.confidence,  // ← accepted blindly
    timestamp: oracle.timestamp,
})
```

**Impact:**  
A compromised cranker (or a legitimate cranker during extreme market conditions) can post a price with `confidence = u64::MAX` while the actual price is highly uncertain. All trading instructions will execute against this uncertain price without any guard. This creates asymmetric risk where PerkOracle-based markets have weaker price quality guarantees than Pyth-based markets.

**Recommended Fix:**  
Add confidence validation to `read_perk_oracle_price`:

```rust
// Reject if confidence > price * ORACLE_CONFIDENCE_BPS / 10000
let max_conf = oracle.price
    .checked_mul(ORACLE_CONFIDENCE_BPS as u64)
    .ok_or(PerkError::MathOverflow)?
    / BPS_DENOMINATOR;
require!(oracle.confidence <= max_conf, PerkError::OracleConfidenceTooWide);
```

---

### M-03: `num_sources` Is Self-Reported — Multi-Source Invariant Not Enforced On-Chain

**Severity:** Medium

**File:** `instructions/update_perk_oracle.rs`

**Description:**  
The spec's Security Properties claim: *"No single entity can unilaterally move the oracle price. Min 2 sources required."* However, `num_sources` is a parameter passed by the cranker and accepted at face value. The on-chain program has no way to verify that the reported number of sources actually corresponds to independent price feeds.

```rust
pub struct UpdatePerkOracleParams {
    pub price: u64,
    pub confidence: u64,
    pub num_sources: u8,  // ← cranker self-reports this
}

// Only check: num_sources >= oracle.min_sources
require!(params.num_sources >= oracle.min_sources, PerkError::OracleInsufficientSources);
```

**Impact:**  
A compromised cranker can set `num_sources = 255` while using zero or one actual source, posting any arbitrary price between 1 and `MAX_ORACLE_PRICE` (1e12). The multi-source requirement provides security theater — it only defends against bugs in the cranker, not against cranker compromise.

**Proof of Concept:**  
Compromised cranker calls `update_perk_oracle` with `{ price: 1, confidence: 0, num_sources: 3 }` for a token worth $100. All security checks pass. All positions are now wildly mispriced.

**Recommended Fix:**  
This is fundamentally a trust-model limitation. Document clearly that the multi-source guarantee is off-chain only and that cranker compromise breaks it. Consider:

1. Adding on-chain price banding (max % change per update) as an optional per-oracle parameter
2. Requiring multiple independent signers for price updates (on-chain multisig oracle)
3. At minimum, updating the spec's Security Properties to accurately reflect that invariant #3 is off-chain only

---

### M-04: No Admin Override for Oracle Authority — Permanent Market Lockout Risk

**Severity:** Medium

**Files:** `instructions/transfer_oracle_authority.rs`, `instructions/initialize_perk_oracle.rs`

**Description:**  
Oracle authority can only be transferred by the current authority. There is no admin-level override. The PDA derivation `[b"perk_oracle", token_mint.as_ref()]` ensures exactly one oracle per token mint — a new one cannot be created for the same mint.

If the oracle authority key is lost or stolen (and attacker transfers authority to their own key), the sequence of events is:

1. Admin freezes oracle (preventing bad prices)
2. Admin cannot transfer authority (only current authority can)
3. Admin cannot create a new oracle for the same mint (PDA collision)
4. If no `admin_update_market` instruction allows changing `market.oracle_address`, the market is permanently frozen

**Impact:**  
Permanent denial of service for any market using a PerkOracle whose authority is irrecoverably lost. All positions in that market would be locked (cannot open, close, or liquidate) since every operation requires a valid oracle read.

**Proof of Concept:**
```
1. Attacker compromises cranker key
2. Attacker calls transfer_oracle_authority → attacker's key
3. Attacker calls transfer_oracle_authority → Pubkey(1) (burned key)
4. Admin calls freeze_perk_oracle (can still do this)
5. Market is permanently frozen — no path to recovery for this token
```

**Recommended Fix:**  
Add admin authority override to `transfer_oracle_authority`:

```rust
// Allow EITHER current authority OR protocol admin to transfer
let is_authority = ctx.accounts.signer.key() == oracle.authority;
let is_admin = /* check protocol.admin */;
require!(is_authority || is_admin, PerkError::Unauthorized);
```

Or add a `close_perk_oracle` instruction that lets admin close the account and reclaim rent, followed by a fresh `initialize_perk_oracle` for the same mint.

---

### L-01: `token_mint` Not Validated as Actual SPL Mint in `initialize_perk_oracle`

**Severity:** Low

**File:** `instructions/initialize_perk_oracle.rs`

**Description:**  
The `token_mint` account is declared as `UncheckedAccount` and is not validated as an actual SPL Mint account. An admin could create an oracle for an arbitrary pubkey that isn't a real token mint.

```rust
/// CHECK: Token mint to create oracle for
pub token_mint: UncheckedAccount<'info>,
```

**Impact:**  
Low — the admin is a trusted role, and `create_market` validates `token_mint: Account<'info, Mint>` and calls `validate_perk_oracle_mint` to match mints. An oracle for a non-mint pubkey would simply never be usable. However, it wastes rent and clutters state.

**Recommended Fix:**  
Change to `Account<'info, Mint>`:
```rust
pub token_mint: Account<'info, anchor_spl::token::Mint>,
```

---

### L-02: EMA Price Is Computed But Never Consumed

**Severity:** Low

**Files:** `instructions/update_perk_oracle.rs` (EMA computation), `engine/oracle.rs` (read_perk_oracle_price)

**Description:**  
The `update_perk_oracle` instruction computes and stores `ema_price` using exponential smoothing (`(price + 9 * old_ema) / 10`). However, `read_perk_oracle_price` returns `oracle.price` (spot) and never reads `ema_price`. No trading instruction uses EMA for any purpose.

**Impact:**  
Wasted computation on every oracle update. The EMA occupies 8 bytes of account space but provides no on-chain utility. If the intent was to use EMA for more robust pricing (e.g., for funding rate calculations or manipulation resistance), this is a missing integration.

**Recommended Fix:**  
Either:
1. Remove EMA computation and field (saves CU and space), or
2. Add EMA to `OraclePrice` return struct and use it where appropriate (e.g., funding calculations, liquidation margin checks with TWAP-like smoothing)

---

### I-01: Spec Says `price: i64`, Implementation Uses `u64` (Improvement)

**Severity:** Informational

**File:** `state/perk_oracle.rs` vs `PERK-ORACLE-SPEC.md`

**Description:**  
The spec defines `price` as `i64` but the implementation uses `u64`. This is actually an improvement — prices are always positive, and `u64` provides a larger positive range while eliminating the need for sign checks. The `update_perk_oracle` handler already requires `price > 0`.

**Recommendation:** Update the spec to match the implementation (`u64` for price, confidence, ema_price).

---

### I-02: Gap Attack Bypass via Freeze/Unfreeze Cycle Is Intentional

**Severity:** Informational

**File:** `instructions/freeze_perk_oracle.rs`

**Description:**  
The gap-attack protection in `update_perk_oracle` (rejecting updates after 2x staleness gap) can be bypassed by the admin freeze/unfreeze cycle, since unfreeze resets the timestamp. This is explicitly documented in the code comments and is by design — without this, an oracle frozen for longer than 2x staleness could never receive updates again without admin intervention.

**Recommendation:** No action needed. The design tradeoff is reasonable. However, see H-01 for the stale price window this creates.

---

### I-03: `create_market` Does Not Validate PerkOracle Mint for Pyth Markets

**Severity:** Informational

**File:** `instructions/create_market.rs`

**Description:**  
The `validate_perk_oracle_mint` check only runs when `oracle_source == OracleSource::PerkOracle`. For Pyth oracles, there's no on-chain verification that the Pyth feed corresponds to the market's token. This is inherent to Pyth's architecture (feeds aren't keyed by mint), so there's no easy fix. The admin/creator must supply the correct Pyth feed address.

**Recommendation:** Consider adding a mapping or registry for Pyth feed → mint pairs that can be verified, or document this as a trusted-admin responsibility.

---

## Summary Table

| ID | Severity | Title |
|----|----------|-------|
| H-01 | **High** | Unfreeze serves stale price as fresh — front-running window |
| M-01 | Medium | Fallback oracle is dead code — no resilience benefit |
| M-02 | Medium | No confidence validation on PerkOracle reads |
| M-03 | Medium | `num_sources` is self-reported — multi-source invariant not enforced on-chain |
| M-04 | Medium | No admin override for oracle authority — permanent market lockout risk |
| L-01 | Low | `token_mint` not validated as actual SPL Mint in initialize |
| L-02 | Low | EMA price computed but never consumed |
| I-01 | Informational | Spec/impl type mismatch (improvement, not bug) |
| I-02 | Informational | Gap attack bypass via freeze/unfreeze is intentional |
| I-03 | Informational | No Pyth feed → mint verification |

---

## Positive Observations

The following security patterns are well-implemented:

- **Checked math throughout** — all arithmetic uses `checked_add/sub/mul/div` or `saturating_*` with explicit error handling
- **Rate limiting** — one update per slot prevents rapid-fire manipulation
- **Gap attack protection** — 2x staleness gap detection prevents stale-to-wild-jump exploitation
- **PDA-based oracle derivation** — deterministic, one-per-mint, no spoofing
- **Owner checks in reader** — oracle account must be owned by the program
- **Frozen state respected everywhere** — both in updates and reads
- **MAX_ORACLE_PRICE bound** — prevents overflow in downstream risk math
- **Authority separation** — cranker cannot admin-freeze, admin cannot post prices
- **Zero-address transfer prevention** — cannot brick oracle by transferring to default pubkey
- **Min-sources requirement** — configurable per oracle at creation
- **Staleness configurable per oracle** — different tokens can have different staleness thresholds

---

*End of audit report.*
