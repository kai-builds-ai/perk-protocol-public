# Red Team Report: Fallback Oracle Wiring

**Date:** 2026-03-24  
**Target:** Perk Protocol — Fallback Oracle System  
**Scope:** 9 instructions accepting `fallback_oracle`, oracle engine, market/oracle state  
**Auditor:** Red Team (Kai subagent)

---

## Executive Summary

The fallback oracle system has a **well-implemented runtime address check** that prevents fake oracle injection. However, there are **two significant issues**:

1. **CRITICAL (Liveness):** No instruction exists to SET `fallback_oracle_address`/`fallback_oracle_source` on a market. The fallback oracle is **dead code** — unreachable in production. The fields default to `Pubkey::default()` / `OracleSource::Pyth`, and the first guard in `read_oracle_price_with_fallback` (`expected_fallback_address == Pubkey::default()`) always short-circuits.

2. **MEDIUM (Defense-in-depth):** The `fallback_oracle` account in all 9 Accounts structs has no Anchor-level constraint. Validation relies entirely on a runtime `require!` inside the error branch of `read_oracle_price_with_fallback`. If the primary oracle succeeds, the fallback account is **never validated** — an attacker can pass any garbage account and the instruction succeeds. This is not currently exploitable but violates defense-in-depth.

---

## Attack Vector Analysis

### 1. Fake Fallback Oracle Injection

**Attack:** Create my own PerkOracle for a shitcoin I control. Pass it as `fallback_oracle` when opening a BTC position. If the primary Pyth feed is stale, the program reads MY price.

**Feasibility:** Impossible (currently); Medium (if `set_fallback` is added without proper constraints)

**What stops it:**
- `read_oracle_price_with_fallback` validates `fallback_account.key == expected_fallback_address` (line 251 of oracle.rs)
- `expected_fallback_address` comes from `market.fallback_oracle_address`, which is stored on-chain
- **Currently:** `fallback_oracle_address` is always `Pubkey::default()`, so the function returns the primary error before reaching any fallback logic

**Risk if `set_fallback` is added without token_mint validation:**
- At market creation, `validate_perk_oracle_mint` checks `oracle.token_mint == market.token_mint`
- If a future `admin_set_fallback_oracle` instruction skips this check, a cross-token oracle could be wired in
- **Fix:** Any future `set_fallback` instruction MUST call `validate_perk_oracle_mint` for PerkOracle sources

---

### 2. Force Primary Failure to Activate Fallback

**Attack:** Frontrun or wait for primary Pyth oracle staleness (>60s with no Pyth update), then execute trades at the fallback price which may differ.

**Feasibility:** Impossible (currently); Hard (if fallback is enabled)

**Step-by-step (hypothetical — requires fallback to be configured):**
1. Monitor Pyth feed for the target market
2. Wait for Pyth to go stale (network congestion, feed outage)
3. If PerkOracle fallback is configured with a price lag, exploit the spread
4. Open position at favorable fallback price
5. Wait for Pyth to recover, close at better price

**What stops it (current):**
- Fallback is unreachable (see Executive Summary)
- Even if enabled, PerkOracle has its own staleness check (`max_staleness_seconds`)
- Price banding on PerkOracle limits cranker price movements per update
- Both sources must fail for `OracleFallbackFailed` — the attacker can't cherry-pick

**What stops it (if enabled):**
- The `same source` guard (`fallback_source == primary_source`) prevents Pyth→Pyth fallback
- Cross-source price divergence is bounded by confidence checks (max 2% of price)
- But: a 2% divergence on a 100x leveraged position is a 200% PnL swing — still significant

**Fix:** If fallback is ever enabled, add a **max price divergence check** between primary's last known price (`market.last_oracle_price`) and the fallback reading. Reject if divergence exceeds a threshold (e.g., 5%).

---

### 3. Price Divergence Exploitation

**Attack:** Pyth says $100, PerkOracle says $95. Force fallback, get 5% better entry.

**Feasibility:** Impossible (currently); Medium (if fallback enabled without divergence guard)

**Analysis:**
- Confidence band check limits each oracle's internal spread to ≤2% of price
- But there is **no cross-oracle divergence check** between primary and fallback
- PerkOracle cranker controls the fallback price (within banding limits)
- If primary goes stale, any price within the PerkOracle's banding window is accepted

**Impact:** On a market with 100x leverage:
- 5% price divergence → up to 500% PnL advantage on a max-leveraged position
- Attacker opens at favorable fallback price, waits for primary recovery, closes at true price

**Fix:** Add to `read_oracle_price_with_fallback`:
```rust
// After reading fallback price, check divergence from last known primary
if market.last_oracle_price > 0 {
    let divergence = abs_diff(fallback_price, market.last_oracle_price) * BPS_DENOMINATOR
        / market.last_oracle_price;
    require!(divergence <= MAX_FALLBACK_DIVERGENCE_BPS, PerkError::OracleDivergenceTooHigh);
}
```

---

### 4. Account Substitution (UncheckedAccount Abuse)

**Attack:** Since `fallback_oracle` is `UncheckedAccount` with no Anchor constraint, what happens if I pass my wallet, a random token account, or a garbage account?

**Feasibility:** Easy (to pass) / No Impact (currently)

**What happens with each substitution:**

| Passed Account | When Primary Succeeds | When Primary Fails |
|---|---|---|
| My wallet | ✅ Ignored (primary OK) | ❌ Rejected: `key != expected_fallback_address` |
| Random token account | ✅ Ignored (primary OK) | ❌ Rejected: key check or `default()` short-circuit |
| Account owned by my program | ✅ Ignored (primary OK) | ❌ Rejected: key check |
| Primary oracle again | ✅ Ignored (primary OK) | ❌ Rejected: `fallback_source == primary_source` or key check |
| SystemProgram (SDK default) | ✅ Ignored (primary OK) | ❌ Rejected: `111...111 != default()` but then fails key check |

**Key insight:** The runtime check is solid. But the lack of an Anchor-level constraint means:
- **Gas waste:** Every transaction must include a `fallback_oracle` account even though it's never used
- **Confusion:** The `/// CHECK:` comment says "pass any account if no fallback configured" — this is technically correct but invites bad practices
- **Future risk:** If someone refactors and removes the runtime check, the constraint gap becomes critical

**Fix (defense-in-depth):** Add Anchor constraint on all 9 instructions:
```rust
#[account(
    constraint = fallback_oracle.key() == market.fallback_oracle_address
        || market.fallback_oracle_address == Pubkey::default()
    @ PerkError::InvalidOracleSource
)]
pub fallback_oracle: UncheckedAccount<'info>,
```

---

### 5. Sandwich via Fallback Manipulation (Cranker Insider Attack)

**Attack:** As the PerkOracle cranker (authority), post a favorable price → freeze primary → trade at fallback → unfreeze primary.

**Feasibility:** Impossible (currently); Hard (if fallback enabled)

**Step-by-step (hypothetical):**
1. Cranker posts lowball PerkOracle price ($95 when real is $100)
2. Admin freezes Pyth oracle (admin-only operation — requires protocol admin)
3. Open long at $95 fallback price
4. Admin unfreezes Pyth
5. Close at $100 → pocket 5% × leverage

**What stops it:**
- **Freeze is admin-only** (`FreezePerkOracle` requires `protocol.admin` signer) — cranker can't freeze Pyth
- Cranker can freeze their OWN PerkOracle, but that only DISABLES the fallback, not enables it
- To force fallback, the PRIMARY must fail — cranker doesn't control Pyth staleness
- **Price banding:** PerkOracle rejects price updates that move >X% per update
- **One update per slot:** Rate limiting prevents rapid price manipulation
- **Post-unfreeze price zeroing:** H-01 fix zeroes price on unfreeze, requiring a fresh update before the oracle is usable

**Collusion scenario (cranker + admin):**
- If the cranker IS the admin (or they collude), the attack is theoretically possible
- But admin can already drain the protocol directly — fallback manipulation is unnecessary
- Admin trust assumption is standard for Solana DeFi

**Fix:** Consider a **timelock on freeze/unfreeze** and requiring oracle price age < N slots when entering fallback mode.

---

### 6. SDK Trust Assumptions

**Attack:** The SDK defaults to `SystemProgram.programId` when no fallback is configured. Call the program directly via raw transaction with a different account.

**Feasibility:** Easy (to attempt) / No Impact

**Analysis:**
- SDK uses `SystemProgram.programId` (`111...111`) as default — this is NOT `Pubkey::default()` (`000...000`)
- The runtime check compares against `market.fallback_oracle_address` which IS `Pubkey::default()` (`000...000`)
- So the `expected_fallback_address == Pubkey::default()` guard triggers regardless of what account you pass
- Even if you pass a different account, the primary-success path ignores it entirely
- Even if primary fails, the `default()` check short-circuits before the address validation

**SDK inconsistency (non-exploitable):**
- The SDK sends `111...111` but the program checks against `000...000` — these are different values
- But it doesn't matter because the comparison is against the market's stored address, not the passed account
- Still, the SDK should ideally use `Pubkey::default()` for consistency

**Fix:** SDK should pass `Pubkey::default()` (all zeros) instead of `SystemProgram.programId` when no fallback is configured. While not exploitable, it's cleaner and avoids confusing auditors.

---

## Additional Findings

### 7. Dead Code: Fallback Oracle Is Unreachable (CRITICAL — Liveness)

**Description:** The `fallback_oracle_source` and `fallback_oracle_address` fields on `Market` are:
- Never set in `create_market` (defaults: `OracleSource::Pyth`, `Pubkey::default()`)
- Not updatable via `admin_update_market` (no params for fallback)
- No dedicated `set_fallback_oracle` instruction exists

**Impact:** The entire fallback oracle system — including the `fallback_oracle` account on 9 instructions, the `read_oracle_price_with_fallback` function, and the runtime validation — is **dead code**. If a Pyth feed goes stale, there is NO fallback. Markets are single-oracle-failure-mode.

**Fix:** Create an `admin_set_fallback_oracle` instruction:
```rust
#[derive(Accounts)]
pub struct AdminSetFallbackOracle<'info> {
    #[account(seeds = [b"protocol"], bump, has_one = admin)]
    pub protocol: Box<Account<'info, Protocol>>,
    #[account(mut, seeds = [b"market", market.token_mint.as_ref()], bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: validated in handler
    pub fallback_oracle: UncheckedAccount<'info>,
    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminSetFallbackOracle>, source: OracleSource) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let oracle_info = ctx.accounts.fallback_oracle.to_account_info();

    // Must be different source from primary
    require!(source != market.oracle_source, PerkError::InvalidOracleSource);

    // Validate the oracle account
    oracle::validate_oracle(&source, &oracle_info)?;

    // For PerkOracle: verify token_mint matches
    if source == OracleSource::PerkOracle {
        oracle::validate_perk_oracle_mint(&oracle_info, &market.token_mint)?;
    }

    market.fallback_oracle_source = source;
    market.fallback_oracle_address = oracle_info.key();
    Ok(())
}
```

### 8. Same-Source Guard May Be Too Strict

**Description:** `read_oracle_price_with_fallback` rejects fallback if `fallback_source == primary_source`. This means a PerkOracle primary can't have another PerkOracle fallback (e.g., different authority/sources).

**Impact:** Limits resilience for PerkOracle-primary markets. Two independent PerkOracle feeds (different crankers, different source sets) could provide meaningful redundancy.

**Feasibility of exploitation:** N/A — this is a design limitation, not a vulnerability.

**Fix:** Replace same-source guard with same-address guard:
```rust
if *expected_fallback_address == Pubkey::default()
    || *expected_fallback_address == *primary_account.key  // same account, not same source type
```

### 9. No `token_mint` Validation at Fallback Read Time

**Description:** `read_perk_oracle_price` does NOT check `oracle.token_mint`. The token_mint is only validated at market creation via `validate_perk_oracle_mint`. The runtime address check makes this safe (you can't pass a different oracle), but if the fallback address were ever corrupted or set incorrectly, a cross-token oracle could be used.

**Impact:** Currently safe due to address pinning. Risk increases if admin instructions are added carelessly.

**Fix:** Add `token_mint` validation inside `read_perk_oracle_price`:
```rust
// Optional: callers could pass expected_mint for extra safety
pub fn read_perk_oracle_price(
    oracle_account: &AccountInfo,
    current_time: i64,
    expected_mint: Option<&Pubkey>,  // NEW
) -> Result<OraclePrice> {
    // ... existing checks ...
    if let Some(mint) = expected_mint {
        require!(oracle.token_mint == *mint, PerkError::InvalidOracleSource);
    }
    // ...
}
```

---

## Risk Matrix

| # | Attack | Severity | Feasibility | Status |
|---|--------|----------|-------------|--------|
| 1 | Fake fallback injection | Critical | Impossible (now) | ✅ Blocked by runtime key check |
| 2 | Force primary failure | High | Impossible (now) | ✅ Blocked: fallback unreachable |
| 3 | Price divergence exploit | High | Impossible (now) | ⚠️ No cross-oracle divergence guard (future risk) |
| 4 | Account substitution | Low | Easy / No impact | ⚠️ Missing Anchor constraint (defense-in-depth) |
| 5 | Cranker sandwich | Critical | Impossible (now) | ✅ Blocked: admin-only freeze + fallback unreachable |
| 6 | SDK bypass | Low | Easy / No impact | ✅ Runtime check works regardless |
| 7 | **Dead code / no setter** | **Critical (liveness)** | **N/A** | **🔴 No way to configure fallback** |
| 8 | Same-source guard too strict | Low | N/A | ℹ️ Design consideration |
| 9 | No token_mint at read time | Low | Impossible (now) | ℹ️ Defense-in-depth |

---

## Priority Fixes

### P0 — Ship Blocker
1. **Create `admin_set_fallback_oracle` instruction** — without this, the fallback system is dead code and markets have zero oracle redundancy

### P1 — Before Mainnet
2. **Add Anchor-level constraint** on `fallback_oracle` in all 9 instructions (defense-in-depth)
3. **Add cross-oracle divergence guard** in `read_oracle_price_with_fallback` (max 5% divergence from last primary price)

### P2 — Hardening
4. **Add `token_mint` check** in `read_perk_oracle_price` at read time
5. **SDK consistency** — use `Pubkey::default()` instead of `SystemProgram.programId` for unconfigured fallback
6. **Reconsider same-source guard** — allow same-type oracles with different addresses

---

*Report generated by red team analysis of commit state as of 2026-03-24.*
