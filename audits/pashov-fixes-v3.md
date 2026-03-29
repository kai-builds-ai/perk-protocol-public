# Pashov — Fixes Verification Report (v3)

**Date:** 2026-03-24  
**Scope:** Focused review of three fixes applied after the initial audit.  
**Commit:** Post-audit fix batch (same-source removal, SDK removal path, IDL regen)

---

## Fix 1: Same-Source Check Removed from Engine

**File:** `programs/perk-protocol/src/engine/oracle.rs` (lines 232–260)

### What Changed
`read_oracle_price_with_fallback` no longer compares `fallback_source == primary_source`. The only skip condition is `expected_fallback_address == Pubkey::default()`, which correctly represents "no fallback configured."

### Verdict: ✅ SAFE

The removal is correct and well-guarded:

1. **Address validation is the real security boundary.** The function validates `fallback_account.key == expected_fallback_address` (line ~253), where `expected_fallback_address` comes from the on-chain `Market` account. This prevents any attacker-injected oracle regardless of source type.

2. **Same-address-as-primary is blocked at write time.** `admin_set_fallback_oracle` handler (line ~67) enforces `params.fallback_oracle_address != market.oracle_address`. So the stored market state can never have `fallback_address == primary_address`.

3. **Even if bypassed hypothetically:** If `fallback_address == primary_address` and `fallback_source == primary_source`, the fallback read would fail for the same reason the primary did (stale, frozen, etc.). This is a no-op, not an exploit. The error would just become `OracleFallbackFailed` instead of the primary error — slightly worse error message, zero security impact.

4. **Pyth→Pyth with different feeds now works.** This is the intended use case — different Pyth feed accounts for the same source type. Correct design.

### Minor Finding (Informational)

**Stale doc comment in `admin_set_fallback_oracle.rs` (line 5):**
```
/// Pass fallback_oracle_source = primary source to effectively disable fallback
/// (the engine skips same-source fallbacks).
```
This comment is now **incorrect** — the engine no longer skips same-source fallbacks. Should be removed or updated to reflect the current behavior ("Pass `Pubkey::default()` as address to remove fallback" already covers the removal path).

**Severity:** Informational — misleading docs, no security impact.

---

## Fix 2: SDK Removal Path

**File:** `sdk/src/client.ts` (lines 852–876)

### What Changed
`adminSetFallbackOracle` detects `fallbackOracleAddress.equals(PublicKey.default)` and substitutes `SystemProgram.programId` as the transaction account, while still passing `Pubkey::default()` (all zeros) in the instruction params.

### Verdict: ✅ CORRECT

The divergence between JS account and on-chain params is handled properly:

1. **Why it's needed:** Solana transactions cannot include the null address (`11111111111111111111111111111112` all zeros) as an account. The runtime rejects it. `SystemProgram.programId` (`11111111111111111111111111111111`) is a valid, universally-accessible account.

2. **On-chain short-circuit:** The handler checks `params.fallback_oracle_address == Pubkey::default()` **before** reading `fallback_oracle` account data. When removing, it sets default values and returns early. The `SystemProgram.programId` account is never deserialized or validated. Correct.

3. **No confused-deputy risk:** The sentinel account (`SystemProgram.programId`) is never stored on-chain. The market stores `Pubkey::default()` as `fallback_oracle_address`, which is the canonical "no fallback" sentinel checked by the engine.

4. **`PublicKey.default` vs `Pubkey::default()`:** Both are all-zeros (32 zero bytes). The `@solana/web3.js` `PublicKey.default` getter returns `new PublicKey(Buffer.alloc(32))`. The Rust `Pubkey::default()` is `[0u8; 32]`. These serialize identically. No divergence.

### No Issues Found.

---

## Fix 3: IDL Regeneration

**File:** `sdk/src/idl.json`

### Verification

Checked all 26 instructions for `fallback_oracle` account presence:

| Instruction | Has `fallback_oracle` | Expected | ✓ |
|---|---|---|---|
| `admin_set_fallback_oracle` | ✅ | ✅ | ✓ |
| `open_position` | ✅ | ✅ | ✓ |
| `close_position` | ✅ | ✅ | ✓ |
| `deposit` | ✅ | ✅ | ✓ |
| `withdraw` | ✅ | ✅ | ✓ |
| `liquidate` | ✅ | ✅ | ✓ |
| `execute_trigger_order` | ✅ | ✅ | ✓ |
| `crank_funding` | ✅ | ✅ | ✓ |
| `update_amm` | ✅ | ✅ | ✓ |
| `reclaim_empty_account` | ✅ | ✅ | ✓ |
| `update_oracle_config` | ❌ | ❌ | ✓ |

**`update_oracle_config` correctly omits `fallback_oracle`** — this instruction operates on `PerkOraclePrice` accounts (oracle banding configuration), not on market price reads. It doesn't invoke `read_oracle_price_with_fallback` and has no need for fallback oracle accounts.

Instructions that don't read market oracle prices (`place_trigger_order`, `cancel_trigger_order`, `initialize_*`, `admin_pause`, `admin_update_market`, `create_market`, `claim_fees`, `freeze_perk_oracle`, `update_perk_oracle`, `transfer_oracle_authority`, `propose_admin`, `accept_admin`, `admin_withdraw_sol`) correctly omit `fallback_oracle`.

Also confirmed IDL contains:
- `SetFallbackOracleParams` type with `fallback_oracle_source` and `fallback_oracle_address` fields
- `UpdateOracleConfigParams` type with `max_price_change_bps` field

### Verdict: ✅ IDL is complete and correct.

---

## Regression Check

| Vector | Status |
|---|---|
| Attacker passes fake fallback oracle | **Blocked** — `expected_fallback_address` from Market state, validated on-chain |
| Fallback set to same address as primary | **Blocked** — `admin_set_fallback_oracle` handler rejects it |
| Fallback set to cross-token oracle | **Blocked** — PerkOracle mint validation in admin handler |
| SDK sends null address in transaction | **Fixed** — SystemProgram sentinel used instead |
| Fallback removal leaves stale source | **Safe** — source reset to `Pyth` (default), address set to `default()`, engine checks address first |
| Primary works → fallback ignored | **Correct** — fallback only attempted on primary error |

---

## Summary

| Fix | Verdict | Issues |
|---|---|---|
| Same-source check removal | ✅ Safe | 1 stale comment (Informational) |
| SDK removal path | ✅ Correct | None |
| IDL regeneration | ✅ Complete | None |

**Overall: All three fixes are correctly implemented. No security regressions. One informational finding (stale doc comment).**

---

*Pashov — Independent Security Researcher*
