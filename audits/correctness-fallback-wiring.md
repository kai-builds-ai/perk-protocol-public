# Fallback Oracle Wiring — Correctness Review

**Date:** 2026-03-24  
**Reviewer:** Kai (automated security review)  
**Scope:** All 9 instructions using oracle prices, oracle engine, SDK client, cranker

---

## Executive Summary

The fallback oracle wiring has a **critical security vulnerability**: the `fallback_oracle` account passed by the caller is **never validated** against `market.fallback_oracle_address`. An attacker can pass any account they control as the fallback oracle and, when the primary oracle is stale/frozen, get an arbitrary price accepted by the protocol.

**Severity: CRITICAL**

---

## Finding 1 — CRITICAL: Fallback Oracle Account Not Constrained

### Description

The primary oracle has an Anchor constraint in every instruction:
```rust
#[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
pub oracle: UncheckedAccount<'info>,
```

The fallback oracle has **no equivalent constraint**:
```rust
/// CHECK: Fallback oracle account (pass any account if no fallback configured)
pub fallback_oracle: UncheckedAccount<'info>,
```

There is no check anywhere — not in the Accounts struct, not in `read_oracle_price_with_fallback()` — that verifies:
```rust
fallback_oracle.key() == market.fallback_oracle_address
```

### Attack Scenario

1. Attacker creates a PerkOracle account (they are the oracle authority) with an extreme price
2. Attacker waits for primary oracle to become stale (natural occurrence) or frontrun-freezes it (if they have freeze authority on a PerkOracle primary)
3. Attacker calls `open_position`, passing their malicious oracle as `fallback_oracle`
4. Primary oracle fails (stale) → fallback path activates → reads attacker's price
5. Attacker opens a position at a manipulated price, then closes at real price for profit

### Impact

Complete price manipulation. Attacker can open/close/liquidate at arbitrary prices whenever the primary oracle is temporarily unavailable.

### Affected Instructions

All 9: `open_position`, `close_position`, `deposit`, `withdraw`, `liquidate`, `execute_trigger_order`, `crank_funding`, `update_amm`, `reclaim_empty_account`

### Fix

Add a constraint to every Accounts struct:
```rust
/// CHECK: Fallback oracle — must match market config or be zero (unconfigured)
#[account(
    constraint = fallback_oracle.key() == market.fallback_oracle_address
        || fallback_oracle.key() == Pubkey::default()
        @ PerkError::InvalidFallbackOracle
)]
pub fallback_oracle: UncheckedAccount<'info>,
```

**OR** validate inside `read_oracle_price_with_fallback()`:
```rust
pub fn read_oracle_price_with_fallback(
    primary_source: &OracleSource,
    primary_account: &AccountInfo,
    fallback_source: &OracleSource,
    fallback_account: &AccountInfo,
    expected_fallback_key: &Pubkey,  // <-- NEW: pass market.fallback_oracle_address
    current_time: i64,
) -> Result<OraclePrice> {
    match read_oracle_price(primary_source, primary_account, current_time) {
        Ok(result) => Ok(result),
        Err(primary_err) => {
            if fallback_source == primary_source
                || *fallback_account.key == Pubkey::default()
            {
                return Err(primary_err);
            }
            // CRITICAL: Validate fallback account matches config
            require!(
                *fallback_account.key == *expected_fallback_key,
                PerkError::InvalidFallbackOracle
            );
            read_oracle_price(fallback_source, fallback_account, current_time)
                .map_err(|_| error!(PerkError::OracleFallbackFailed))
        }
    }
}
```

**Recommendation:** Use the Anchor constraint approach (defense in depth at the account validation layer) AND the engine-level check. Belt and suspenders.

---

## Finding 2 — MEDIUM: Fallback Skip Logic Uses Source Equality, Not Address

### Description

In `read_oracle_price_with_fallback`:
```rust
if fallback_source == primary_source
    || *fallback_account.key == Pubkey::default()
{
    return Err(primary_err);
}
```

The "no fallback configured" check uses `fallback_source == primary_source`. This means:
- If primary is `Pyth` and fallback is a *different* `Pyth` feed → fallback is skipped
- If primary is `PerkOracle` and fallback is a *different* `PerkOracle` → fallback is skipped

This seems intentional (same-source fallback is less useful), but it's overly restrictive. A market might legitimately want a Pyth feed for SOL/USD from publisher A as primary, and another Pyth feed from publisher B as fallback. The current logic prevents this.

### Recommendation

Consider checking `fallback_account.key == primary_account.key` instead of `fallback_source == primary_source`:
```rust
if *fallback_account.key == *primary_account.key
    || *fallback_account.key == Pubkey::default()
{
    return Err(primary_err);
}
```

Or remove the source check entirely and rely on address-based dedup.

---

## Finding 3 — LOW: SDK Uses `SystemProgram.programId` as Sentinel, Engine Checks `Pubkey::default()`

### Description

The SDK defaults to `SystemProgram.programId` when no fallback is configured:
```typescript
fallbackOracle: fallbackOracle ?? SystemProgram.programId,
```

`SystemProgram.programId` = `11111111111111111111111111111111` (all ones)

The engine checks for `Pubkey::default()` = `00000000000000000000000000000000` (all zeros):
```rust
|| *fallback_account.key == Pubkey::default()
```

**These are different values.** When the SDK passes `SystemProgram.programId`, the engine does NOT see it as "unconfigured" and will attempt to deserialize the System Program account as an oracle (Pyth or PerkOracle), which will fail with `InvalidOracleSource`.

### Why This Hasn't Blown Up (Yet)

The fallback path only activates when the primary oracle *fails*. If the primary oracle is healthy, `read_oracle_price_with_fallback` returns on the happy path and never checks the fallback account. So this mismatch only matters during primary oracle failures — at which point:

1. If `market.fallback_oracle_source == market.oracle_source` → skipped by source equality check ✓
2. If market has no fallback configured (`fallback_oracle_address == Pubkey::default()`) → the source fields in state are the initial/default values. Whether this triggers the skip depends on what `OracleSource::default()` is.

### Impact

Low, but a latent bug. When the primary oracle fails and a fallback IS configured, the engine correctly tries the fallback. When fallback is NOT configured, the current skip conditions (source equality) may coincidentally prevent reaching the deserialize. But it's fragile.

### Fix

Either:
- Change the SDK to pass `PublicKey.default` (all zeros) as sentinel, OR
- Change the engine to also check `SystemProgram.programId`:
```rust
|| *fallback_account.key == Pubkey::default()
|| *fallback_account.key == anchor_lang::system_program::ID
```

---

## Finding 4 — LOW: No Validation That Primary ≠ Fallback PerkOracle for Same Token

### Description

Nothing prevents admin from setting:
- `oracle_source = PerkOracle`, `oracle_address = oracle_A`  
- `fallback_oracle_source = PerkOracle`, `fallback_oracle_address = oracle_A`

With the current source-equality skip (`fallback_source == primary_source`), this would silently disable fallback. With the recommended fix (address-equality check instead), it would attempt the same oracle twice — both would fail with the same error.

### Impact

Low — admin misconfiguration, not exploitable. But confusing behavior.

### Recommendation

Add a check in `admin_update_market` or wherever fallback is configured:
```rust
if new_fallback_address != Pubkey::default() {
    require!(
        new_fallback_address != market.oracle_address,
        PerkError::FallbackSameAsPrimary
    );
}
```

---

## Finding 5 — INFO: Account Ordering in Structs

### Description

The `fallback_oracle` is placed immediately after `oracle` in all 9 structs. This is consistent and correct. In Anchor, the order of accounts in the struct determines the order in the IDL and the order clients must pass accounts. The placement is logical and consistent across all instructions.

### Status: ✅ No issues

---

## Finding 6 — INFO: Reclaim Empty Account Uses Fallback

### Description

`reclaim_empty_account` reads oracle price for the accrue→settle→warmup pattern, which is needed for correctness (settling PnL before checking emptiness). Using fallback here is appropriate — if the primary oracle is stale, we still want to settle before reclaiming.

### Status: ✅ Appropriate

---

## Finding 7 — MEDIUM: Oracle Freeze Frontrunning for Forced Fallback

### Description

If the primary oracle is a `PerkOracle`, the `freeze_perk_oracle` instruction is admin-only. However, if the primary is `Pyth`, staleness is time-based and an attacker cannot control it directly.

The risk: if an attacker knows the fallback oracle price diverges from the primary, they can wait for natural staleness (publisher lag, network congestion) and submit a transaction during that window. This is a general MEV concern rather than a protocol bug.

**However**, combined with Finding 1, this becomes critical: an attacker doesn't even need to wait for legitimate fallback — they can pass their own fake fallback oracle. Fix Finding 1 first; this finding becomes low-risk after.

### Status: Medium (becomes Low after Finding 1 is fixed)

---

## Finding 8 — Cranker `resolveFallbackOracle` Review

### Description

The cranker correctly resolves fallback from market state:
```typescript
function resolveFallbackOracle(market: MarketAccount): PublicKey {
  const addr = market.fallbackOracleAddress;
  if (addr.equals(PublicKey.default)) return SystemProgram.programId;
  return addr;
}
```

This reads `market.fallbackOracleAddress` from on-chain state and passes it. Combined with Finding 3 (sentinel mismatch), when no fallback is configured the cranker passes `SystemProgram.programId`, which doesn't match the engine's `Pubkey::default()` check.

The cranker also correctly passes fallback in all call sites: `crankFunding`, `updatePeg`, `scanLiquidations`, `scanTriggerOrders`, `scanReclaims`.

### Status: ✅ Cranker wiring is correct (subject to Finding 3 sentinel issue)

---

## Summary of Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | **CRITICAL** | Fallback oracle account not constrained to `market.fallback_oracle_address` | ❌ Must fix before deploy |
| 2 | Medium | Source-equality skip prevents same-source fallbacks | ⚠️ Design decision, consider relaxing |
| 3 | Low | SDK sentinel (`SystemProgram`) ≠ engine sentinel (`Pubkey::default`) | ⚠️ Latent bug, fix proactively |
| 4 | Low | No validation that primary ≠ fallback oracle address | ⚠️ Admin guard, nice to have |
| 5 | Info | Account ordering is consistent | ✅ |
| 6 | Info | Reclaim using fallback is appropriate | ✅ |
| 7 | Medium | Oracle freeze frontrunning (critical only with Finding 1 unfixed) | ⚠️ |
| 8 | Info | Cranker wiring correct | ✅ |

---

## Recommended Fix Order

1. **Finding 1 (CRITICAL):** Add `constraint = fallback_oracle.key() == market.fallback_oracle_address || fallback_oracle.key() == SystemProgram::id() @ PerkError::InvalidFallbackOracle` to all 9 instruction structs. Also add engine-level validation.

2. **Finding 3 (Low):** Align sentinels — either change SDK to `Pubkey.default` or engine to also accept `SystemProgram::id()`. Given the SDK already uses `SystemProgram.programId`, the pragmatic fix is to accept both in the engine:
   ```rust
   || *fallback_account.key == Pubkey::default()
   || *fallback_account.key == anchor_lang::system_program::ID
   ```

3. **Finding 2 (Medium):** Change skip condition from source-equality to address-equality.

4. **Finding 4 (Low):** Add admin-side validation.

---

*End of review.*
