# Apex SDK Security Audit — PerkOracle System

**Date:** 2026-03-24  
**Auditor:** Kai (Apex-level automated audit)  
**Scope:** SDK TypeScript types, client methods, PDA derivation, IDL consistency for PerkOracle subsystem  
**Commit:** HEAD (pre-release)

---

## Executive Summary

The PerkOracle SDK implementation is **well-constructed** with no critical, high, or medium severity issues found. The TypeScript types accurately mirror the Rust on-chain state, instruction account ordering matches the IDL and Rust `Accounts` structs, enum ordering is consistent across all layers, PDA derivation seeds match exactly, and the IDL contains all required new instructions and types. Two informational findings are noted below.

---

## Audit Checklist Results

### ✅ TypeScript Types vs Rust On-Chain State

**PerkOracleAccount (TS) ↔ PerkOraclePrice (Rust):**

| # | Rust Field | Rust Type | TS Field | TS Type | Match |
|---|-----------|-----------|----------|---------|-------|
| 1 | bump | u8 | bump | number | ✅ |
| 2 | token_mint | Pubkey | tokenMint | PublicKey | ✅ |
| 3 | authority | Pubkey | authority | PublicKey | ✅ |
| 4 | price | u64 | price | BN | ✅ |
| 5 | confidence | u64 | confidence | BN | ✅ |
| 6 | timestamp | i64 | timestamp | BN | ✅ |
| 7 | num_sources | u8 | numSources | number | ✅ |
| 8 | min_sources | u8 | minSources | number | ✅ |
| 9 | last_slot | u64 | lastSlot | BN | ✅ |
| 10 | ema_price | u64 | emaPrice | BN | ✅ |
| 11 | max_staleness_seconds | u32 | maxStalenessSeconds | number | ✅ |
| 12 | is_frozen | bool | isFrozen | boolean | ✅ |
| 13 | created_at | i64 | createdAt | BN | ✅ |
| 14 | total_updates | u64 | totalUpdates | BN | ✅ |
| 15 | _reserved | [u8; 64] | (omitted) | — | ✅ ¹ |

¹ `_reserved` is correctly omitted from the TS interface — it's internal padding, handled by Anchor deserialization. The field exists at runtime on fetched objects but needn't be typed.

**Field ordering:** Matches exactly between Rust struct, IDL, and TS interface. ✅

**MarketAccount fallback fields:**

| Rust Field | TS Field | Match |
|-----------|----------|-------|
| fallback_oracle_source: OracleSource | fallbackOracleSource: OracleSource | ✅ |
| fallback_oracle_address: Pubkey | fallbackOracleAddress: PublicKey | ✅ |

Both fields are present at the end of the MarketAccount interface, matching Rust field ordering. ✅

### ✅ Instruction Account Ordering

**initialize_perk_oracle:**

| # | IDL Account | Rust Struct Field | TS .accounts() | Match |
|---|------------|-------------------|----------------|-------|
| 1 | protocol | protocol | protocol | ✅ |
| 2 | perk_oracle (mut) | perk_oracle (init) | perkOracle | ✅ |
| 3 | token_mint | token_mint | tokenMint | ✅ |
| 4 | oracle_authority | oracle_authority | oracleAuthority | ✅ |
| 5 | admin (mut, signer) | admin (mut, signer) | admin: wallet.publicKey | ✅ |
| 6 | system_program | system_program | systemProgram | ✅ |

**update_perk_oracle:**

| # | IDL Account | Rust Struct Field | TS .accounts() | Match |
|---|------------|-------------------|----------------|-------|
| 1 | perk_oracle (mut) | perk_oracle (mut) | perkOracle | ✅ |
| 2 | authority (signer) | authority (signer) | authority: wallet.publicKey | ✅ |

**freeze_perk_oracle:**

| # | IDL Account | Rust Struct Field | TS .accounts() | Match |
|---|------------|-------------------|----------------|-------|
| 1 | protocol | protocol | protocol | ✅ |
| 2 | perk_oracle (mut) | perk_oracle (mut) | perkOracle | ✅ |
| 3 | admin (signer) | admin (signer) | admin: wallet.publicKey | ✅ |

**transfer_oracle_authority:**

| # | IDL Account | Rust Struct Field | TS .accounts() | Match |
|---|------------|-------------------|----------------|-------|
| 1 | protocol | protocol | protocol | ✅ |
| 2 | perk_oracle (mut) | perk_oracle (mut) | perkOracle | ✅ |
| 3 | signer (signer) | signer (signer) | signer: wallet.publicKey | ✅ |
| 4 | new_authority | new_authority | newAuthority | ✅ |

### ✅ OracleSource Enum Ordering

| Index | Rust | IDL | TypeScript | Match |
|-------|------|-----|-----------|-------|
| 0 | Pyth | Pyth | Pyth | ✅ |
| 1 | PerkOracle | PerkOracle | PerkOracle | ✅ |
| 2 | DexPool | DexPool | DexPool | ✅ |

Anchor serialization map in client.ts uses correct camelCase variant names: `{ pyth: {} }`, `{ perkOracle: {} }`, `{ dexPool: {} }`. ✅

### ✅ PDA Derivation

**Rust:** `seeds = [b"perk_oracle", token_mint.key().as_ref()]`  
**TS:** `[PERK_ORACLE_SEED, tokenMint.toBuffer()]` where `PERK_ORACLE_SEED = Buffer.from("perk_oracle")`

- Seed string bytes match exactly ✅
- Token mint is 32-byte pubkey buffer in both ✅
- Program ID passed correctly ✅

### ✅ IDL Completeness

All four new instructions present in IDL:
- `initialize_perk_oracle` ✅
- `update_perk_oracle` ✅
- `freeze_perk_oracle` ✅
- `transfer_oracle_authority` ✅

All new types present:
- `PerkOraclePrice` (account + type with 15 fields) ✅
- `InitPerkOracleParams` (min_sources: u8, max_staleness_seconds: u32) ✅
- `UpdatePerkOracleParams` (price: u64, confidence: u64, num_sources: u8) ✅

Account discriminator registered: `[215, 196, 234, 180, 130, 99, 25, 5]` ✅

### ✅ BN vs Number Types

All u64/i64/u128/i128 fields correctly use `BN`. All u8/u16/u32 fields correctly use `number` (safe within JS `Number.MAX_SAFE_INTEGER`). No silent truncation risk.

### ✅ Account Namespace Name

`this.accounts.perkOraclePrice` correctly references the Anchor camelCase derivation of the `PerkOraclePrice` Rust struct name. ✅

---

## Findings

### I-01: Missing `await` in `fetchPerkOracle` and `fetchPerkOracleNullable`

**Severity:** Informational  
**Title:** Inconsistent async pattern — Promise cast without await  

**Description:**  
In `client.ts`, `fetchPerkOracle()` and `fetchPerkOracleNullable()` return the result of `.fetch()` / `.fetchNullable()` without `await`:

```typescript
// Current (fetchPerkOracle):
return this.accounts.perkOraclePrice.fetch(address) as unknown as PerkOracleAccount;

// All other fetchers use await:
return (await this.accounts.market.fetch(address)) as unknown as MarketAccount;
```

The `as unknown as PerkOracleAccount` cast is technically applied to the `Promise` object, not the resolved value. This works at runtime because JavaScript `async` functions automatically flatten returned Promises, but the TypeScript cast is semantically incorrect.

**Impact:** Zero functional impact — works correctly at runtime. However, if this pattern were copied into a non-async function, it would return a Promise instead of the expected value. Also slightly impedes stack traces on rejection.

**Recommended Fix:**
```typescript
async fetchPerkOracle(tokenMint: PublicKey): Promise<PerkOracleAccount> {
  const address = this.getPerkOracleAddress(tokenMint);
  return (await this.accounts.perkOraclePrice.fetch(address)) as unknown as PerkOracleAccount;
}

async fetchPerkOracleNullable(tokenMint: PublicKey): Promise<PerkOracleAccount | null> {
  const address = this.getPerkOracleAddress(tokenMint);
  return (await this.accounts.perkOraclePrice.fetchNullable(address)) as unknown as PerkOracleAccount | null;
}
```

---

### I-02: No SDK-Side Validation for u8/u32 Oracle Parameters

**Severity:** Informational  
**Title:** Missing client-side bounds checking for oracle init/update params  

**Description:**  
The `openPosition` method validates `leverage` and `maxSlippageBps` before sending to the chain, catching bad values early with clear error messages. The oracle methods (`initializePerkOracle`, `updatePerkOracle`) do not perform equivalent validation on:

- `minSources` (u8: 0-255, valid range: 1-10)
- `maxStalenessSeconds` (u32: 0-4294967295, valid range: 5-300)
- `numSources` (u8: 0-255)
- `price` (u64, must be > 0 and ≤ MAX_ORACLE_PRICE)

**Impact:** Invalid values are caught by on-chain validation and the transaction will fail with an Anchor error. There is no security risk — the on-chain program rejects bad inputs. However, the error message from a failed transaction is less clear than a local SDK error.

**Recommended Fix:** Add optional SDK-side validation matching the on-chain constraints:

```typescript
async initializePerkOracle(tokenMint, oracleAuthority, params) {
  if (params.minSources < 1 || params.minSources > MAX_MIN_SOURCES) {
    throw new Error(`minSources must be 1-${MAX_MIN_SOURCES}, got ${params.minSources}`);
  }
  if (params.maxStalenessSeconds < MIN_ORACLE_STALENESS_SECONDS ||
      params.maxStalenessSeconds > MAX_ORACLE_STALENESS_SECONDS) {
    throw new Error(`maxStalenessSeconds must be ${MIN_ORACLE_STALENESS_SECONDS}-${MAX_ORACLE_STALENESS_SECONDS}`);
  }
  // ... rest of method
}
```

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Informational | 2 |

**Overall Assessment:** The PerkOracle SDK implementation is correct and secure. Types, accounts, enums, PDAs, and the IDL are all consistent across the TypeScript SDK and the Rust on-chain program. The two informational findings are code quality improvements with zero security impact.

---

*Audit complete. No blocking issues found.*
