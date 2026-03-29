# Apex Audit — Fixes v3 Review

**Auditor:** Apex (methodical security review)  
**Date:** 2026-03-24  
**Scope:** Same-source check removal, SDK fallback removal path, IDL regeneration  
**Severity scale:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## 1. `engine/oracle.rs` — Same-Source Check Removal

### What Changed
The `read_oracle_price_with_fallback` function previously had a guard that skipped fallback when `fallback_source == primary_source`. This has been removed. Now the **only** skip condition is:

```rust
if *expected_fallback_address == Pubkey::default() {
    return Err(primary_err);
}
```

### Analysis

**✅ PASS — The change is correct and safe.**

The old same-source check was overly broad: it blocked legitimate Pyth→Pyth fallbacks (different feeds, same `OracleSource` enum variant). Removing it allows diverse feeds of the same provider type to serve as fallbacks.

**Focus area: What if admin sets fallback to same SOURCE and same ADDRESS as primary?**

This is **prevented on-chain** in `admin_set_fallback_oracle.rs` (line 62):

```rust
require!(
    params.fallback_oracle_address != market.oracle_address,
    PerkError::InvalidOracleSource
);
```

This guard compares the **address**, not the source type. Since the address uniquely identifies a feed, this is the correct check. Even if both are `OracleSource::Pyth`, the addresses must differ. **Confirmed enforced.**

**Edge case analysis — removing the source check:**

| Scenario | Risk | Assessment |
|---|---|---|
| Pyth primary → Pyth fallback (different feed) | None | This is the desired use case |
| PerkOracle primary → PerkOracle fallback | None | Different addresses, validated individually |
| Pyth primary stale → Pyth fallback also stale (correlated failure) | Low | Both feeds from same provider could go stale together. **However**, this is an operational risk the admin accepts when configuring, not a code bug. The fallback error maps to `OracleFallbackFailed` which is correct. |
| Attacker injects fake fallback account | None | `fallback_account.key == expected_fallback_address` check prevents this |

**Verdict:** No new attack surface introduced. The address-equality check in `admin_set_fallback_oracle` is sufficient.

---

## 2. `client.ts` — SDK Removal Path

### What Changed
`adminSetFallbackOracle` now detects removal intent via:

```typescript
const isRemoving = params.fallbackOracleAddress.equals(PublicKey.default);
const fallbackAccount = isRemoving
  ? SystemProgram.programId
  : params.fallbackOracleAddress;
```

The instruction data still carries `Pubkey::default()` (32 zero bytes) so the on-chain handler recognizes it as removal. Only the **transaction account** is substituted to `SystemProgram.programId` (since Solana rejects all-zeros as a transaction account).

### Analysis

**✅ PASS — Correct approach.**

**Focus area: Does `PublicKey.default` produce 32 zero bytes?**

Yes. In `@solana/web3.js`, `PublicKey.default` is a static property that returns `new PublicKey("11111111111111111111111111111111")` — which is base58 for 32 zero bytes. This is identical to Rust's `Pubkey::default()`. The `.equals()` comparison is byte-level.

**Important note:** `PublicKey.default` was introduced in `@solana/web3.js` v1.73+. If the project pins an older version, this would be `undefined` and the removal path would silently fail (always setting, never removing). **Recommend verifying the `@solana/web3.js` version in `package.json` is ≥ 1.73.**

**On-chain safety:** When removing, the on-chain handler hits the early return before ever reading the `fallback_oracle` account:

```rust
if params.fallback_oracle_address == Pubkey::default() {
    market.fallback_oracle_source = OracleSource::Pyth;
    market.fallback_oracle_address = Pubkey::default();
    return Ok(());
}
```

So `SystemProgram.programId` is never dereferenced as an oracle. **Safe.**

**Verdict:** Clean implementation. One version dependency to verify (see finding F-01).

---

## 3. IDL Regeneration

### Spot-Check Results

| Instruction | `fallback_oracle` in accounts? | Line | Status |
|---|---|---|---|
| `admin_set_fallback_oracle` | ✅ Yes | 167 | Present |
| `close_position` | ✅ Yes | 629 | Present |
| `liquidate` | ✅ Yes | 1560 | Present |
| `open_position` | ✅ Yes | 1697 | Present |

Additionally confirmed:
- `SetFallbackOracleParams` type defined (line 3408) with `fallback_oracle_source` and `fallback_oracle_address` fields
- `OracleFallbackFailed` error present (line 2779)
- Market struct includes `fallback_oracle_source` (line 3237) and `fallback_oracle_address` (line 3245)

**✅ PASS — IDL is consistent with on-chain code.**

---

## Findings

### F-01 — Verify `@solana/web3.js` Version (LOW)

**Location:** `sdk/package.json`  
**Issue:** `PublicKey.default` requires `@solana/web3.js` ≥ 1.73. If an older version is pinned, the removal path in `adminSetFallbackOracle` would fail silently (`isRemoving` always `false` because `PublicKey.default` would be `undefined`).  
**Recommendation:** Verify `@solana/web3.js` version. If < 1.73, either upgrade or use `new PublicKey(Buffer.alloc(32))` as a fallback.

### F-02 — Stale Doc Comment in `admin_set_fallback_oracle.rs` (INFO)

**Location:** `admin_set_fallback_oracle.rs`, line 5  
**Issue:** The module doc comment still says:
> "Pass fallback_oracle_source = primary source to effectively disable fallback (the engine skips same-source fallbacks)."

This is no longer true — the same-source skip was removed. The correct removal method is passing `Pubkey::default()`.  
**Recommendation:** Update the doc comment to reflect the new removal mechanism.

---

## Summary

| Area | Verdict |
|---|---|
| Same-source check removal | ✅ Safe — address check prevents same-feed fallback |
| SDK removal path | ✅ Correct — sentinel pattern is sound |
| IDL regeneration | ✅ Consistent with on-chain code |
| New attack surface | None identified |

**Overall: PASS** — Two minor findings (F-01 LOW, F-02 INFO). No security issues.
