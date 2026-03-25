# Security Audit — Price Banding + Jito Bundle Changes

**Auditor:** Pashov  
**Date:** 2026-03-24  
**Scope:** Price banding enforcement (on-chain), oracle config update instruction, Jito bundle submission (off-chain cranker), `buildUpdatePerkOracleIx` SDK pattern  
**Severity Scale:** Critical / High / Medium / Low / Informational

---

## Executive Summary

The price banding implementation is well-designed with correct overflow protection via `checked_mul`. The `_reserved` byte layout is consistent across init/update/config paths. The Jito integration is functional but has one medium-severity mempool leakage concern on fallback and a low-severity tip instruction encoding issue. Overall the changes are solid — no critical or high-severity findings.

---

## Findings

### [M-01] Jito Fallback Leaks Transaction to Public Mempool

**Severity:** Medium  
**File:** `sdk/src/oracle-cranker.ts` (Jito fallback path, ~line 370)

**Description:**  
When Jito bundle submission fails, the cranker falls back to `this.client.updatePerkOracle()` which sends the transaction via standard RPC. This defeats the entire purpose of using Jito (front-run resistance). An attacker monitoring both the Jito block engine rejections and the public mempool could observe the oracle update before it lands on-chain and front-run it.

The transaction sent via Jito and the fallback transaction are different objects (different blockhash, no Jito tip), so there's no risk of the *same* signed transaction appearing in both Jito and public mempool simultaneously. However, the *price data* is identical, and the fallback path publicly exposes it.

**Recommendation:**  
Add a configurable `jitoOnly` mode that skips fallback entirely — if the oracle operator wants MEV protection, a silent failure + retry next tick is safer than public mempool exposure. At minimum, log a warning that the fallback sacrifices MEV protection:

```typescript
if (this.config.jito?.fallbackToRpc !== true) {
  this.log(`Jito failed for ${mintKey} — skipping (no fallback). Will retry next tick.`);
  continue;
}
```

---

### [M-02] Price Banding Bypass After Unfreeze

**Severity:** Medium  
**File:** `update_perk_oracle.rs` (banding check), `freeze_perk_oracle.rs` (unfreeze logic)

**Description:**  
When an oracle is unfrozen, the freeze handler sets `oracle.price = 0`. The banding check in `update_perk_oracle` has the condition:

```rust
if max_change_bps > 0 && oracle.price > 0 {
```

Since `oracle.price` is zeroed on unfreeze, the **first update after unfreeze skips banding entirely**. This is likely intentional (you need to re-establish a price from zero), but it creates a one-shot window where a compromised cranker can post any arbitrary price without banding constraints.

**Impact:** Low in practice because:
1. The cranker authority is trusted (single key)
2. The unfreeze itself is admin-gated
3. The first post-unfreeze price is expected to be "fresh" anyway

**Recommendation:**  
Document this as an explicit design decision. If you want defense-in-depth, consider having the unfreeze instruction accept an `expected_price` parameter that the admin provides, and the first update must be within banding of *that* value rather than skipping the check entirely.

---

### [L-01] Jito Tip Instruction Uses Hardcoded Data Layout

**Severity:** Low  
**File:** `sdk/src/oracle-cranker.ts` (~line 273)

**Description:**  
The tip transfer instruction is manually constructed:

```typescript
data: Buffer.from([
  2, 0, 0, 0, // transfer instruction index
  ...new BN(tipLamports).toArray("le", 8),
]),
```

This is correct — `2` is the SystemProgram `Transfer` instruction discriminator and the amount is 8 bytes LE. However, this hardcoded byte layout is fragile. If the System Program ever changes (unlikely but non-zero), or if a developer misreads the `2` as something else during maintenance, it could silently break.

**Recommendation:**  
Use `SystemProgram.transfer()` from `@solana/web3.js` instead:

```typescript
import { SystemProgram } from "@solana/web3.js";
const tipIx = SystemProgram.transfer({
  fromPubkey: payer.publicKey,
  toPubkey: tipAccount,
  lamports: tipLamports,
});
```

This is semantically identical, type-safe, and self-documenting.

---

### [L-02] `BPS_DENOMINATOR` Type Mismatch in Banding Check

**Severity:** Low  
**File:** `update_perk_oracle.rs` (line ~64), `constants.rs`

**Description:**  
`BPS_DENOMINATOR` is `u64` (value `10_000`). The banding math:

```rust
let change_bps = diff
    .checked_mul(BPS_DENOMINATOR)
    .ok_or(PerkError::MathOverflow)?
    / oracle.price;
```

`diff` is `u64` (max value: `MAX_ORACLE_PRICE = 1_000_000_000_000`). `diff * 10_000` max = `10_000_000_000_000_000` which is well within `u64::MAX` (~1.8e19). **No overflow risk here.** The `checked_mul` is correct defense-in-depth.

The comparison `change_bps <= max_change_bps as u64` is also safe since `max_change_bps` is `u16` (max 9999) cast to `u64`.

**Note:** This is **not** a finding — just confirming the math is sound. No action needed.

---

### [L-03] `_reserved` Byte Layout Is Undocumented in State Struct

**Severity:** Low  
**File:** `state/perk_oracle.rs`

**Description:**  
The `_reserved` field is declared as `[u8; 64]` with no inline documentation of the byte layout. The actual usage is:

| Byte(s) | Purpose | Set by |
|---------|---------|--------|
| `[0]` | `unfreeze_pending` flag (0/1) | `freeze_perk_oracle.rs` |
| `[1..3]` | `max_price_change_bps` (LE u16) | `initialize_perk_oracle.rs`, `update_oracle_config.rs` |
| `[3..64]` | Unused | — |

This is consistent across all three writers and the one reader (`update_perk_oracle.rs`). However, the lack of documentation in the struct itself makes it easy for a future developer to accidentally reuse bytes `[1..3]` for something else.

**Recommendation:**  
Add a comment block in `perk_oracle.rs`:

```rust
/// _reserved layout:
///   [0]    = unfreeze_pending flag (0=false, 1=true) — set by freeze handler
///   [1..3] = max_price_change_bps (LE u16, 0=disabled) — set by init/config
///   [3..64] = unused
pub _reserved: [u8; 64],
```

Or better, replace the reserved bytes with named fields in the next IDL version.

---

### [I-01] `update_oracle_config` Does Not Validate Oracle Is Not Frozen

**Severity:** Informational  
**File:** `update_oracle_config.rs`

**Description:**  
The `update_oracle_config` instruction allows the admin to change `max_price_change_bps` even while the oracle is frozen. This is likely fine — the admin should be able to reconfigure during a freeze — but it's worth noting for completeness. If the admin changes banding to 0 while frozen, then unfreezes, the first update will have no banding protection.

**Impact:** None beyond what the admin already controls. Admin can already set banding to 0 at init time.

---

### [I-02] Jito Tip Account List Is Hardcoded

**Severity:** Informational  
**File:** `sdk/src/oracle-cranker.ts` (~line 260)

**Description:**  
The 8 Jito tip accounts are hardcoded. Jito rotates these periodically. If the list becomes stale, tips will go to accounts that Jito validators no longer monitor, and bundles may not be prioritized.

**Recommendation:**  
Fetch current tip accounts from Jito's `getTipAccounts` RPC method at cranker startup, with the hardcoded list as fallback:

```typescript
const tipAccounts = await this.fetchJitoTipAccounts() ?? JITO_TIP_ACCOUNTS;
```

---

### [I-03] `buildUpdatePerkOracleIx` Pattern Is Clean

**Severity:** Informational (positive)

**Description:**  
The `buildUpdatePerkOracleIx` method correctly:
1. Returns `preInstructions` (compute budget) + the main instruction
2. Does not sign or send — leaves that to the caller
3. Uses the same account resolution as `updatePerkOracle`

This is the correct pattern for Jito bundle construction. No issues found.

---

## Verified Properties

| Property | Status | Notes |
|----------|--------|-------|
| LE u16 encoding consistent across init/update/config | ✅ | All three use `to_le_bytes()` / `from_le_bytes()` on `_reserved[1..2]` |
| `max_price_change_bps` validated ≤ 9999 on all write paths | ✅ | Init and config both check `<= MAX_PRICE_CHANGE_BPS` |
| Banding check uses `checked_mul` for overflow protection | ✅ | Returns `MathOverflow` error on overflow |
| Banding skipped when `max_change_bps == 0` | ✅ | Allows memecoins to move freely |
| Banding skipped on first price post (`oracle.price == 0`) | ✅ | Correct — no reference price to band against |
| `_reserved[0]` (unfreeze flag) not clobbered by banding writes | ✅ | Banding uses `[1..3]`, unfreeze uses `[0]` |
| Admin-only gate on `update_oracle_config` | ✅ | `has_one = admin` on Protocol account |
| Jito tip transfer is valid SystemProgram transfer | ✅ | Discriminator=2, LE u64 amount, correct accounts |
| Fallback transaction is independent (different sig) | ✅ | New transaction built by `updatePerkOracle`, not re-sent Jito tx |

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 2 (1 is "no action needed" confirmation) |
| Informational | 3 |

The implementation is clean and production-ready with the recommended mitigations for M-01 and M-02. The core price banding logic is mathematically sound with no overflow or bypass vectors beyond the intentional unfreeze edge case.

---

*Pashov — Independent Security Researcher*
