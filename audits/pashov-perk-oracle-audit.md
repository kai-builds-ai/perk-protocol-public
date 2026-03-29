# Perk Protocol — PerkOracle Security Audit

**Auditor:** Pashov Audit Group (solo review)  
**Date:** March 24, 2026  
**Scope:** PerkOracle subsystem — state, instructions, oracle engine, and all consumer instructions  
**Commit:** Pre-mainnet (development branch)  
**Severity Scale:** Critical > High > Medium > Low > Informational

---

## Executive Summary

> **All findings in this report have been resolved or acknowledged. See individual status lines per finding.**

The PerkOracle is a custom oracle system for the Perk Protocol perpetual futures DEX on Solana. It provides price feeds for SPL tokens using off-chain aggregation (Jupiter, Birdeye, on-chain DEX reads) posted by an authorized cranker.

The design is fundamentally sound — PDA-seeded oracles, admin-only creation, rate limiting, gap attack prevention, and a fail-closed staleness model. The codebase shows evidence of prior audit hardening (Pashov-tagged fixes visible throughout). However, I identified **1 High**, **3 Medium**, **2 Low**, and **3 Informational** issues, the most severe of which allows trading on arbitrarily stale prices after an admin unfreeze.

No critical severity issues were found. All findings have been resolved or acknowledged with no unresolved issues remaining.

---

## Findings

### [H-01] Unfreeze resets timestamp, enabling trading on stale prices

**Severity:** High
**Status:** Resolved — Unfreeze now zeros `oracle.price` and sets `unfreeze_pending` flag instead of resetting timestamp; `read_perk_oracle_price` rejects until cranker posts fresh price.

**File:** `freeze_perk_oracle.rs` (L28-31), `oracle.rs` (L52-55)

**Description:**

When an admin unfreezes an oracle, the handler sets `oracle.timestamp = clock.unix_timestamp` to prevent the gap-attack check in `update_perk_oracle` from rejecting the first post-unfreeze cranker update. This is documented and intentional. However, it has a dangerous side effect: the oracle's `price` field retains its pre-freeze value, while the `timestamp` now indicates the price is fresh.

The reader function `read_perk_oracle_price` checks staleness as:
```rust
let age = current_time.saturating_sub(oracle.timestamp);
require!(age <= oracle.max_staleness_seconds as i64, PerkError::OracleStale);
```

After unfreeze, `age ≈ 0`, so the staleness check passes. The stale pre-freeze price is now treated as a live price by every consumer instruction.

**Impact:**

Between the unfreeze transaction and the first cranker price update, all trading instructions (open, close, liquidate, trigger execution, funding crank, AMM peg update) will use a price that could be hours or days old. If the real market price moved significantly during the freeze period, this creates an arbitrage window where traders can:

- Open positions at a price they know is wrong
- Close profitable positions before the real price lands
- Front-run the cranker update transaction

This is particularly dangerous because freezes are used during suspected manipulation — meaning the true market price is likely to have diverged significantly from the last-recorded price.

**Attack Scenario:**

1. Admin freezes SOL/USD PerkOracle when SOL is at $150 due to suspected manipulation
2. SOL trades at $200 for the next 2 days while oracle is frozen
3. Admin unfreezes oracle — `oracle.price = $150`, `oracle.timestamp = now`
4. Attacker monitoring the mempool sees the unfreeze tx, immediately opens a max-leverage long at $150
5. Cranker posts real price ($200) one slot later
6. Attacker closes position for ~33% profit per unit of leverage

**Recommendation:**

Do not reset `timestamp` on unfreeze. Instead, add a separate field (e.g., `unfreeze_pending: bool`) that the `update_perk_oracle` handler checks to bypass the gap check for exactly one update:

```rust
// In update_perk_oracle:
if oracle.timestamp > 0 && !oracle.unfreeze_pending {
    let gap = clock.unix_timestamp.saturating_sub(oracle.timestamp);
    let max_gap = (oracle.max_staleness_seconds as i64).saturating_mul(2);
    require!(gap <= max_gap, PerkError::OracleGapTooLarge);
}
if oracle.unfreeze_pending {
    oracle.unfreeze_pending = false;
}
```

This way, the oracle remains stale (and thus unusable for trading) until the cranker posts a fresh price, while still allowing the cranker's first post-unfreeze update to land.

---

### [M-01] Fallback oracle system is entirely dead code

**Severity:** Medium
**Status:** Resolved — `admin_set_fallback_oracle` instruction implemented; all consumer instructions now use `read_oracle_price_with_fallback` and accept `fallback_oracle` account.

**Files:** `oracle.rs` (L170-189), `market.rs` (L119-120), all consumer instructions

**Description:**

The spec defines a two-tier oracle system where Tier 1 markets (SOL, BTC, ETH) use Pyth as primary with PerkOracle as fallback. The codebase includes:

1. `read_oracle_price_with_fallback()` function in `oracle.rs`
2. `fallback_oracle_source` and `fallback_oracle_address` fields on `Market`

However:
- `create_market.rs` never initializes the fallback fields (they default to `OracleSource::Pyth` and `Pubkey::default()`)
- No instruction accepts a fallback oracle account
- Every consumer instruction calls `read_oracle_price()`, never `read_oracle_price_with_fallback()`
- There is no instruction to set/update fallback oracle fields on an existing market

The fallback system exists in code but is completely non-functional.

**Impact:**

If Pyth goes down temporarily (network congestion, price feed expiry, Pythnet issues), all Tier 1 markets immediately halt. The PerkOracle fallback that the spec promises — and that the team likely assumes is active — does not function. This contradicts the spec's invariant: "Fallback only activates when primary fails."

**Recommendation:**

Either implement the fallback path end-to-end (add fallback account to all instruction contexts, call `read_oracle_price_with_fallback`, add admin instruction to configure fallback on existing markets), or remove the dead code and fields to avoid false confidence.

---

### [M-02] No confidence band validation for PerkOracle prices

**Severity:** Medium
**Status:** Resolved — Confidence band check (`conf <= price * 200bps / 10000`) added to `read_perk_oracle_price`, matching Pyth validation.

**File:** `oracle.rs` (L44-66 vs L75-108)

**Description:**

For Pyth prices, the reader validates that confidence doesn't exceed 2% of price:

```rust
// Pyth path
let max_conf = price_scaled * ORACLE_CONFIDENCE_BPS / BPS_DENOMINATOR;
require!(conf_scaled <= max_conf, PerkError::OracleConfidenceTooWide);
```

For PerkOracle prices, confidence is returned but never validated:

```rust
// PerkOracle path — no confidence check
Ok(OraclePrice {
    price: oracle.price,
    confidence: oracle.confidence,
    timestamp: oracle.timestamp,
})
```

Furthermore, the `update_perk_oracle` instruction accepts any `confidence` value with zero validation — no bounds check, no relationship to price enforced.

**Impact:**

A compromised or buggy cranker can post a price with `confidence = u64::MAX`, signaling extreme uncertainty, and it will be silently accepted. Consumer instructions don't check confidence either — they only use `price`. This means the protocol trades on prices that the cranker itself flagged as highly uncertain.

While the cranker is trusted infrastructure, oracle design should be defense-in-depth. If Pyth's confidence matters enough to validate, PerkOracle's should too.

**Recommendation:**

Add confidence validation in `read_perk_oracle_price`:

```rust
let max_conf = oracle.price
    .checked_mul(ORACLE_CONFIDENCE_BPS as u64)
    .ok_or(PerkError::MathOverflow)?
    / BPS_DENOMINATOR;
require!(oracle.confidence <= max_conf, PerkError::OracleConfidenceTooWide);
```

Also add a basic sanity bound in `update_perk_oracle` (e.g., `confidence <= price`).

---

### [M-03] No upper bound on `max_staleness_seconds` allows effectively disabling staleness protection

**Severity:** Medium
**Status:** Resolved — Bounds enforced: `max_staleness_seconds` in [5, 300], `min_sources` in [1, 10] via `MIN/MAX_ORACLE_STALENESS_SECONDS` and `MAX_MIN_SOURCES` constants.

**File:** `initialize_perk_oracle.rs` (L33-36)

**Description:**

The initialization handler validates:
```rust
require!(params.min_sources >= 1, PerkError::InvalidAmount);
require!(params.max_staleness_seconds > 0, PerkError::InvalidAmount);
```

There is no upper bound on either parameter. An admin could set `max_staleness_seconds = 4_294_967_295` (u32::MAX, ~136 years), effectively disabling the staleness check that is supposed to be a core safety invariant. Similarly, `min_sources = 255` would make the oracle permanently un-updatable since the cranker likely can't provide 255 sources.

**Impact:**

While admin-only, this violates the spec's invariant #1: "No trade executes on a stale price." A misconfigured `max_staleness_seconds` silently degrades this guarantee. There's no on-chain enforcement that the admin chose reasonable parameters.

**Recommendation:**

Add normative bounds:

```rust
pub const MIN_STALENESS_SECONDS: u32 = 5;
pub const MAX_STALENESS_SECONDS: u32 = 300; // 5 minutes — generous upper bound
pub const MAX_MIN_SOURCES: u8 = 10;

require!(params.max_staleness_seconds >= MIN_STALENESS_SECONDS, PerkError::InvalidAmount);
require!(params.max_staleness_seconds <= MAX_STALENESS_SECONDS, PerkError::InvalidAmount);
require!(params.min_sources <= MAX_MIN_SOURCES, PerkError::InvalidAmount);
```

---

### [L-01] `token_mint` in `initialize_perk_oracle` is UncheckedAccount

**Severity:** Low
**Status:** Resolved — Changed to `Account<'info, Mint>` with full SPL Mint deserialization and owner validation.

**File:** `initialize_perk_oracle.rs` (L27)

**Description:**

```rust
/// CHECK: Token mint to create oracle for
pub token_mint: UncheckedAccount<'info>,
```

The `token_mint` is used only as a PDA seed (`seeds = [b"perk_oracle", token_mint.key().as_ref()]`) and stored in `oracle.token_mint`. There's no validation that the pubkey is actually an SPL Token Mint account.

**Impact:**

The admin could create an oracle for any arbitrary pubkey. While `create_market.rs` validates the oracle's `token_mint` matches the market's actual token mint (which IS validated as a Mint), a malformed oracle entry pollutes the PDA namespace.

More subtly: `validate_perk_oracle_mint` checks `oracle.token_mint == *expected_mint`, but if two different non-mint pubkeys happen to collide with desired seeds, or if an oracle is created for a pubkey that isn't a mint but later becomes one via program upgrade, the oracle could serve an unintended market.

**Recommendation:**

Change to `Account<'info, Mint>` or at minimum verify the account owner is the Token Program:

```rust
pub token_mint: Account<'info, Mint>,
```

---

### [L-02] Single-step authority transfer — typo permanently bricks oracle

**Severity:** Low
**Status:** Resolved — Admin override added to `transfer_oracle_authority` (admin OR current authority can transfer); zero-address check prevents bricking.

**File:** `transfer_oracle_authority.rs`

**Description:**

Authority transfer is a single-step operation: current authority signs, new authority is set immediately. The only validation is `new_authority != Pubkey::default()`.

```rust
oracle.authority = ctx.accounts.new_authority.key();
```

If the admin accidentally passes a wrong pubkey (typo, copy-paste error, wrong wallet), the oracle authority is irrevocably transferred to an address nobody controls.

**Impact:**

A bricked oracle means no more price updates. The oracle becomes stale, trading halts for all markets using it. The admin must create a new oracle and update all markets to point to it — but there's no instruction to update a market's oracle address post-creation. The market is permanently broken.

**Recommendation:**

Implement two-step transfer (propose + accept pattern), consistent with how the protocol handles admin transfers:

```rust
// Step 1: Current authority proposes
oracle.pending_authority = new_authority;

// Step 2: New authority accepts
require!(signer == oracle.pending_authority);
oracle.authority = oracle.pending_authority;
oracle.pending_authority = Pubkey::default();
```

Add a `pending_authority` field to `PerkOraclePrice` (space available in `_reserved`).

---

### [I-01] EMA price is dead state — computed but never consumed

**Severity:** Informational
**Status:** Resolved — EMA is now consumed by the circuit breaker, which computes deviation against `old_ema` before each update.

**Files:** `perk_oracle.rs` (L10), `update_perk_oracle.rs` (L41-49), `oracle.rs`

**Description:**

`ema_price` is updated on every `update_perk_oracle` call using a 1/10 exponential smoothing factor. However, `read_perk_oracle_price` returns `oracle.price` (spot), not `ema_price`. No consumer instruction reads `ema_price`. It's 8 bytes of dead state updated every slot for no purpose.

**Impact:** Wasted compute on every oracle update. No security impact.

**Recommendation:** Either use EMA price for something (e.g., funding rate TWAP comparison, manipulation detection) or remove the computation to save CU.

---

### [I-02] Fallback oracle rejects same-source pairs unnecessarily

**Severity:** Informational
**Status:** Acknowledged — Design limitation; current Pyth→PerkOracle fallback model works correctly. Future flexibility deferred.

**File:** `oracle.rs` (L178-179)

**Description:**

```rust
if fallback_source == primary_source || *fallback_account.key == Pubkey::default()
```

This rejects fallback when the source type matches the primary, even if the accounts differ. You cannot use two different PerkOracle feeds (from different authorities) or two different Pyth feeds as primary+fallback.

**Impact:** Design limitation. For the current Pyth→PerkOracle fallback design, this is fine. But it prevents future flexibility (e.g., PerkOracle primary backed by a different PerkOracle from a different authority).

**Recommendation:** Check account equality instead of source type equality, or remove the check entirely (if both fail, the error is returned regardless).

---

### [I-03] `num_sources` is an unverifiable trust-the-cranker value

**Severity:** Informational
**Status:** Acknowledged — Fundamental limitation of off-chain oracles; documented as trust assumption. On-chain banding + circuit breaker mitigate cranker compromise.

**File:** `update_perk_oracle.rs` (L31)

**Description:**

The `num_sources >= oracle.min_sources` check validates against a caller-provided value. Since on-chain code cannot verify how many off-chain sources the cranker actually queried, a compromised cranker can always claim `num_sources = 3` regardless of actual source count.

**Impact:** The `min_sources` check is security theater against cranker key compromise — the very scenario it's designed to protect against. It only protects against a well-intentioned cranker with a buggy aggregator.

**Recommendation:** Acknowledged as a fundamental limitation of off-chain oracle designs. Document this trust assumption explicitly. Consider requiring multiple independent cranker keys to co-sign updates (k-of-n threshold) as a future hardening measure, similar to Chainlink's multi-oracle aggregation.

---

## Architecture Review — What's Done Well

1. **PDA-seeded oracles (one per mint)** — Eliminates oracle spoofing. The seed `[b"perk_oracle", token_mint]` ensures deterministic, non-duplicable accounts.

2. **Rate limiting (one update per slot)** — Prevents rapid-fire price manipulation even with a compromised key. ~400ms minimum between updates.

3. **Gap attack prevention** — The `2x max_staleness` gap check prevents a stale→wild-jump attack where an attacker waits for the oracle to go stale and then posts a manipulated price.

4. **Fail-closed model** — Stale oracle → revert, frozen oracle → revert. No instruction can execute on bad data. This is the right design.

5. **Cranker cannot steal funds** — By design, the oracle authority can only write to the `PerkOraclePrice` account. It has no vault access, no admin privileges. Maximum damage from key compromise is price manipulation → bad trades, not direct theft.

6. **Cross-token validation at market creation** — `validate_perk_oracle_mint` prevents creating a SOL market with a BTC oracle. This was a known attack vector (see Bonq/AllianceBlock exploit, Feb 2023).

7. **Normative price bound** — `oracle.price <= MAX_ORACLE_PRICE` prevents overflow in downstream risk math.

---

## Comparison with Known Oracle Exploits

| Exploit | Vector | Perk Status |
|---------|--------|-------------|
| **Mango Markets (Oct 2022)** | Attacker manipulated spot price on illiquid market, then borrowed against inflated collateral | PerkOracle uses multi-source median (off-chain), not on-chain spot. Single-pool manipulation doesn't move the median. **Mitigated.** |
| **Bonq/AllianceBlock (Feb 2023)** | Attacker called `updatePrice()` on Tellor oracle with no validation, set WALBT to $1B | PerkOracle requires `authority` signer check. Only authorized cranker can update. **Mitigated.** |
| **Venus BSC (May 2021)** | Chainlink price feed paused, protocol continued trading on stale price | PerkOracle has staleness check with `max_staleness_seconds`. **Mitigated** (but see H-01 for unfreeze edge case). |
| **Cream Finance (Oct 2021)** | Flash loan → inflate oracle → borrow → profit, all atomic | PerkOracle updates are cranker-signed, not DEX-derived. Cannot be manipulated in a single tx. Rate limit prevents same-slot re-update. **Mitigated.** |

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| H-01 | High | Unfreeze resets timestamp, enabling trading on stale prices | Resolved |
| M-01 | Medium | Fallback oracle system is entirely dead code | Resolved |
| M-02 | Medium | No confidence band validation for PerkOracle prices | Resolved |
| M-03 | Medium | No upper bound on `max_staleness_seconds` | Resolved |
| L-01 | Low | `token_mint` in initialize is UncheckedAccount | Resolved |
| L-02 | Low | Single-step authority transfer can brick oracle | Resolved |
| I-01 | Info | EMA price is dead state | Resolved |
| I-02 | Info | Fallback rejects same-source pairs unnecessarily | Resolved |
| I-03 | Info | `num_sources` is unverifiable | Resolved |

---

*This audit was performed on a fixed codebase snapshot. Findings reflect the state of the code at review time. A follow-up review is recommended after fixes are applied.*
