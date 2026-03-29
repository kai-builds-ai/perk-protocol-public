# Fallback Oracle Wiring — Security Audit Report

**Auditor:** Pashov  
**Date:** 2026-03-24  
**Scope:** Fallback oracle feature across 9 instructions, oracle engine, admin instruction, and SDK  
**Severity Scale:** Critical / High / Medium / Low / Informational

---

## Executive Summary

The fallback oracle wiring is architecturally sound. The runtime validation pattern (`expected_fallback_address` from trusted `Market` state) is a correct and sufficient security boundary. However, there is one **critical** issue: the IDL has not been regenerated after the on-chain changes. The SDK will fail at runtime for every instruction that now requires a `fallback_oracle` account. Additionally, the SDK's `adminSetFallbackOracle` removal flow passes `Pubkey::default()` as both the params address and the `fallback_oracle` account key, which is incorrect — that account cannot be passed to Anchor.

---

## Findings

### [C-01] IDL Not Regenerated — SDK Cannot Build Valid Transactions

**Severity:** Critical  
**Location:** `sdk/src/idl.json`, all 9 instructions + `admin_set_fallback_oracle`

The on-chain program now expects a `fallback_oracle: UncheckedAccount` in the accounts struct of all 9 instructions (`open_position`, `close_position`, `deposit`, `withdraw`, `liquidate`, `execute_trigger_order`, `crank_funding`, `update_amm`, `reclaim_empty_account`), plus the new `admin_set_fallback_oracle` instruction.

The IDL (`idl.json`) has **not been regenerated**. Verification:
- `open_position` in the IDL has accounts: `protocol`, `market`, `user_position`, `oracle`, `authority`, `user` — **no `fallback_oracle`**.
- `admin_set_fallback_oracle` does **not exist** in the IDL at all.
- The `Market` type in the IDL **does** include `fallback_oracle_source` and `fallback_oracle_address` fields (lines 3036–3044), so the state struct was updated, but instruction signatures were not.

**Impact:** Every SDK call will fail. The Anchor serializer will produce transactions missing the `fallback_oracle` account, causing the runtime to read the wrong account for subsequent fields (account index off-by-one). This will produce cryptic errors like `InvalidOracleSource`, `Unauthorized`, or outright deserialization failures.

**Recommendation:** Run `anchor build` to regenerate the IDL, then copy it to `sdk/src/idl.json`. This is a **hard blocker** for any deployment.

---

### [H-01] SDK `adminSetFallbackOracle` — Removal Passes `Pubkey::default()` as Account

**Severity:** High  
**Location:** `sdk/src/client.ts:857`

When removing a fallback oracle, the caller would set `params.fallbackOracleAddress = PublicKey.default` (all zeros). The SDK passes this as the `fallbackOracle` account:

```typescript
.accounts({
  fallbackOracle: params.fallbackOracleAddress,  // PublicKey.default when removing
  ...
})
```

On-chain, the removal path (`params.fallback_oracle_address == Pubkey::default()`) short-circuits before validating the account — so it technically works. However, passing `PublicKey.default` (the System Program's native address `11111111111111111111111111111111`) as an account is fragile. The Anchor framework may reject it depending on configuration, and future changes to the instruction that add validation before the short-circuit would break removal.

**Recommendation:** Document explicitly that removal requires passing `SystemProgram.programId` as the `fallbackOracle` account (like the other 9 instructions do). Add a helper:

```typescript
async removeFallbackOracle(tokenMint: PublicKey): Promise<TransactionSignature> {
  return this.adminSetFallbackOracle(tokenMint, {
    fallbackOracleSource: OracleSource.Pyth, // ignored on removal
    fallbackOracleAddress: PublicKey.default,
  });
}
```

Note: `PublicKey.default` in JS is `new PublicKey('11111111111111111111111111111111')` which equals `SystemProgram.programId`. But `Pubkey::default()` in Rust is `[0u8; 32]` — the **null address**, NOT the System Program. These are **different values**. If the SDK uses `PublicKey.default` (JS), it will NOT match `Pubkey::default()` (Rust), and the on-chain short-circuit will NOT trigger. The removal path is broken.

**Fix:** The SDK must send the actual null address (`new PublicKey(new Uint8Array(32))`) as `params.fallbackOracleAddress`, and use `SystemProgram.programId` as the account key (since the null address isn't a valid Solana account).

**Update after re-check:** Actually, in `@solana/web3.js`, `PublicKey.default` is indeed the all-zeros key (same as Rust `Pubkey::default()`). But passing the all-zeros pubkey as a Solana account will fail — Solana requires all account keys in a transaction to be valid. This means the removal transaction will fail at the runtime level before even reaching the program.

---

### [M-01] Same-Source Check Prevents Pyth→Pyth Fallback (Different Feed)

**Severity:** Medium  
**Location:** `engine/oracle.rs:183` — `fallback_source == primary_source`

The engine skips fallback when `fallback_source == primary_source`. This prevents a legitimate use case: primary = Pyth feed A (e.g., SOL/USD from publisher X), fallback = Pyth feed B (e.g., SOL/USD from publisher Y).

The `admin_set_fallback_oracle` instruction also prevents this by requiring `params.fallback_oracle_address != market.oracle_address`, but the engine check is broader — it rejects even if the addresses differ, as long as the source enum matches.

**Impact:** Cannot use two different Pyth feeds or two different PerkOracles for primary/fallback. The only valid fallback configuration is cross-source (e.g., Pyth primary + PerkOracle fallback).

**Recommendation:** Remove the `fallback_source == primary_source` check from the engine. The address-based validation (`expected_fallback_address != Pubkey::default()` + key match) is sufficient to ensure a valid, distinct fallback.

---

### [M-02] Frozen Fallback PerkOracle Causes Hard Revert When Primary Fails

**Severity:** Medium  
**Location:** `engine/oracle.rs:190-193`

When primary oracle fails and fallback is configured:
1. Engine calls `read_oracle_price(fallback_source, fallback_account, ...)`
2. For PerkOracle, this checks `!oracle.is_frozen` → returns `OracleFrozen`
3. The error is mapped to `OracleFallbackFailed`

This means: if admin sets a PerkOracle fallback, then the PerkOracle gets frozen (e.g., emergency pause), and then the primary goes stale — **the instruction reverts entirely**. All 9 instructions become unusable for that market.

**Impact:** A frozen fallback can brick a market when the primary is also unavailable. The admin must remember to remove the fallback before (or immediately after) freezing the PerkOracle.

**Recommendation:** Either:
- (a) In `read_oracle_price_with_fallback`, if fallback fails, return the primary error (not `OracleFallbackFailed`). This makes fallback failure transparent.
- (b) Add a check: if fallback source is PerkOracle and the oracle is frozen, skip fallback gracefully (return primary error). This avoids a strictly-worse outcome.
- (c) When freezing a PerkOracle via `freeze_perk_oracle`, automatically remove it as fallback from any market that references it. (Complex, requires iterating markets.)

Option (a) is simplest and most correct.

---

### [M-03] No Anchor Constraint on `fallback_oracle` Account

**Severity:** Medium (but mitigated)  
**Location:** All 9 instructions — `fallback_oracle: UncheckedAccount<'info>`

The `fallback_oracle` account has zero Anchor-level constraints. Unlike the primary oracle which has:
```rust
#[account(constraint = oracle.key() == market.oracle_address @ PerkError::InvalidOracleSource)]
```

The fallback has:
```rust
/// CHECK: Fallback oracle account (pass any account if no fallback configured)
pub fallback_oracle: UncheckedAccount<'info>,
```

Validation happens at runtime in `read_oracle_price_with_fallback()` which checks `*fallback_account.key == *expected_fallback_address`.

**Mitigation assessment:** This is **acceptable** because:
1. The runtime check uses `market.fallback_oracle_address` from the already-validated `Market` PDA — this is trusted data.
2. When no fallback is configured (`Pubkey::default()`), the engine short-circuits before reading the account.
3. An Anchor constraint would require a conditional (`if market.fallback_oracle_address != Pubkey::default()`), which Anchor constraints don't natively support.

**However**, there's a minor gas optimization miss: if an attacker passes a garbage account as `fallback_oracle` but the primary oracle succeeds, the garbage account is never validated (primary returns early). This is benign — no security impact — but it means the instruction accepts any account in the fallback slot when it's not needed.

**Recommendation:** Acceptable as-is. Document the intentional `UncheckedAccount` pattern for future auditors.

---

### [L-01] `admin_set_fallback_oracle` — No Validation That Fallback Source Matches Passed Account Type

**Severity:** Low  
**Location:** `instructions/admin_set_fallback_oracle.rs:51-56`

The instruction calls `validate_oracle()` which dispatches on the source enum. If an admin passes `fallback_oracle_source = Pyth` but the account is actually a PerkOracle (or vice versa), `validate_oracle` will fail with `InvalidOracleSource`. This is correct behavior.

However, the `validate_perk_oracle_mint` check only runs for `PerkOracle` source:
```rust
if params.fallback_oracle_source == OracleSource::PerkOracle {
    oracle::validate_perk_oracle_mint(...)?;
}
```

For Pyth fallbacks, there's no token-mint cross-check. A Pyth feed for ETH/USD could be set as fallback on a SOL/USD market.

**Impact:** Low — requires admin key, and Pyth feeds don't have an on-chain token_mint field to validate against. The admin is trusted to set the correct feed.

**Recommendation:** Informational only. Could add a comment noting this trust assumption for Pyth sources.

---

### [L-02] `OracleSource` Enum Manipulation — Not a Risk

**Severity:** Low (informational)  
**Location:** `state/market.rs:3-9`

The `OracleSource` enum derives `AnchorSerialize`/`AnchorDeserialize` with standard Borsh encoding (u8 discriminant: 0=Pyth, 1=PerkOracle, 2=DexPool). Borsh deserialization rejects any value ≥ 3.

The same-source comparison uses derived `PartialEq` on the enum, which compares discriminants. There is no way to craft a `PerkOracle` that compares equal to `Pyth` or vice versa.

**Conclusion:** No manipulation vector. The enum is safe.

---

### [L-03] Cranker `resolveFallbackOracle` Uses `PublicKey.default` Comparison

**Severity:** Low  
**Location:** `sdk/src/cranker.ts:resolveFallbackOracle()`

```typescript
function resolveFallbackOracle(market: MarketAccount): PublicKey {
  const addr = market.fallbackOracleAddress;
  if (addr.equals(PublicKey.default)) return SystemProgram.programId;
  return addr;
}
```

Same issue as H-01: if `PublicKey.default` in the JS SDK is the all-zeros key, this comparison is correct. But if the Anchor deserialization of `Pubkey::default()` produces a different JS object, the comparison could fail.

In practice, Anchor's Borsh deserialization of `[0u8; 32]` creates `new PublicKey(Buffer.alloc(32))` which equals `PublicKey.default`. So this works correctly.

**Recommendation:** Add a unit test asserting `PublicKey.default.equals(new PublicKey(new Uint8Array(32)))` to catch any future SDK version changes.

---

### [I-01] No Reentrancy or CPI Concerns

**Severity:** Informational

The `fallback_oracle` account is read-only in all 9 instructions (never written to, never used as CPI authority). There are no CPI calls involving the fallback oracle. The only CPI in liquidation/trigger execution is for token transfers (vault → reward account), which don't involve the oracle accounts.

Solana's single-writer lock model prevents any concurrent modification of the fallback oracle account during instruction execution.

**Conclusion:** No reentrancy risk.

---

### [I-02] State Transition: Removing Fallback While Primary Is Stale

**Severity:** Informational  
**Location:** `instructions/admin_set_fallback_oracle.rs`

The `admin_set_fallback_oracle` instruction does NOT read oracle prices — it only validates the oracle account structure. Therefore, an admin can:
1. Set a fallback while the primary is stale → The fallback becomes active on next user interaction.
2. Remove a fallback while the primary is stale → Next user interaction fails with primary staleness error.

Scenario (2) could brick a market temporarily if the admin removes the fallback thinking the primary is healthy, but it goes stale before users interact.

**Recommendation:** Consider adding an optional `validate_primary_health` flag or documenting that admin should verify primary oracle health before removing fallback. This is an operational concern, not a code bug.

---

### [I-03] Fallback Oracle Address Field Initialization

**Severity:** Informational  
**Location:** `instructions/create_market.rs`, `state/market.rs`

`create_market` does not explicitly set `fallback_oracle_source` or `fallback_oracle_address`. These default to `OracleSource::Pyth` (enum default = 0) and `Pubkey::default()` (all zeros).

The engine's first check is `expected_fallback_address == Pubkey::default()` → skip fallback. So the default state is safe: no fallback configured.

The default `fallback_oracle_source = Pyth` is misleading (it suggests Pyth fallback) but harmless since the address check prevents fallback from ever executing.

**Recommendation:** Consider explicitly initializing to `fallback_oracle_source = OracleSource::Pyth` and `fallback_oracle_address = Pubkey::default()` in `create_market` with a comment explaining the sentinel pattern.

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| C-01 | **Critical** | IDL not regenerated — SDK cannot build valid transactions | Open |
| H-01 | **High** | SDK removal flow: `PublicKey.default` vs `Pubkey::default()` mismatch / account validity | Open |
| M-01 | Medium | Same-source check prevents legitimate Pyth→Pyth fallback | Open |
| M-02 | Medium | Frozen fallback PerkOracle bricks market when primary fails | Open |
| M-03 | Medium | No Anchor constraint on `fallback_oracle` (mitigated by runtime check) | Acknowledged |
| L-01 | Low | No token-mint cross-check for Pyth fallback source | Informational |
| L-02 | Low | `OracleSource` enum manipulation — confirmed not a risk | Informational |
| L-03 | Low | Cranker `resolveFallbackOracle` PublicKey comparison edge case | Open |
| I-01 | Info | No reentrancy or CPI concerns with new account | N/A |
| I-02 | Info | Removing fallback while primary is stale — operational risk | Informational |
| I-03 | Info | Fallback fields default initialization in `create_market` | Informational |

---

## Recommended Action Items (Priority Order)

1. **`anchor build`** → regenerate IDL → copy to `sdk/src/idl.json`. This unblocks everything.
2. Fix `adminSetFallbackOracle` SDK removal path — use null address in params, `SystemProgram.programId` as account.
3. Remove or relax the same-source check in the engine (M-01) — decide if Pyth→Pyth fallback is a desired use case.
4. Change `read_oracle_price_with_fallback` to return primary error when fallback also fails (M-02).
5. Add SDK unit tests for fallback oracle wiring (especially removal path and cranker resolution).

---

*End of audit report.*
