# PerkOracle SDK Audit Report

**Auditor:** Pashov  
**Scope:** SDK TypeScript layer for PerkOracle instructions (`client.ts`, `types.ts`, `constants.ts`, `pda.ts`, `index.ts`, `cranker.ts`)  
**Compared Against:** On-chain Rust program (`initialize_perk_oracle.rs`, `update_perk_oracle.rs`, `freeze_perk_oracle.rs`, `transfer_oracle_authority.rs`, `state/perk_oracle.rs`, `state/market.rs`) and `idl.json`  
**Date:** 2026-03-24

---

## Summary

The PerkOracle SDK integration is **clean**. Account names, PDA seeds, parameter types, and instruction shapes all correctly mirror the on-chain program and IDL. No high or medium severity issues found. The code shows attention to detail — enum serialization maps, proper camelCase→snake_case alignment, and complete type exports.

Below are informational findings and one low-severity gap.

---

## Findings

### [L-01] Cranker has no PerkOracle price update support

**Severity:** Low  
**File:** `sdk/src/cranker.ts`

The `PerkCranker` class handles funding, liquidations, trigger orders, peg updates, and reclaims — but has **zero awareness of PerkOracle price feeds**. For markets using `OracleSource::PerkOracle`, the cranker will:

1. Still call `crankFunding()` and `updateAmm()` using `market.oracleAddress` — these will work on-chain only if the PerkOracle has been updated recently by an external process.
2. Use `market.lastOraclePrice` for client-side liquidation/trigger order checks — this value may be stale if no one is pushing prices.
3. Skip scans entirely if the oracle is stale (existing staleness check), meaning PerkOracle-backed markets silently go uncranked.

A developer standing up a PerkOracle-backed market and pointing the cranker at it will see it silently do nothing, with no indication that oracle price updates are missing.

**Recommendation:** Either:
- Add an `enablePerkOracleUpdates` config option + a price source callback to `CrankerConfig`, so the cranker can push prices before cranking markets, or
- At minimum, add a log warning when a market uses `PerkOracle` source and the oracle is stale: `"Market X uses PerkOracle — ensure oracle prices are being pushed externally"`

---

### [I-01] Unfreeze-pending flag not observable through SDK

**Severity:** Informational  
**Files:** `sdk/src/types.ts`, `freeze_perk_oracle.rs`

The on-chain `FreezePerkOracle` handler repurposes `_reserved[0]` as an `unfreeze_pending` flag. When unfreezing, it:
- Zeros the price and EMA (forcing a fresh update before the oracle is usable)
- Sets `_reserved[0] = 1` to allow one gap-check bypass in `update_perk_oracle`

The SDK's `PerkOracleAccount` TypeScript interface does not expose `_reserved`, so integrators cannot check whether the oracle is in this "unfrozen but needs first update" state. The observable symptom is `price === 0 && isFrozen === false`, which is distinguishable — but not self-documenting.

**Recommendation:** Consider adding a computed/documented helper: `isAwaitingFirstUpdate(): boolean` that checks `price === 0 && !isFrozen && totalUpdates > 0`.

---

### [I-02] No compile-time bounds enforcement for u8/u32 parameters

**Severity:** Informational  
**File:** `sdk/src/types.ts`

`InitPerkOracleParams.minSources` and `UpdatePerkOracleParams.numSources` are typed as `number` in TypeScript but are `u8` on-chain. `maxStalenessSeconds` is `number` but `u32` on-chain. A developer can pass `minSources: 300` and get a Borsh serialization error at runtime rather than a compile-time error.

This is standard behavior for Anchor SDKs and not a bug — but the `openPosition` method shows a pattern of client-side validation (leverage bounds, slippage u16 check) that could be extended here for consistency:

```typescript
if (params.minSources < 1 || params.minSources > 255) throw new Error(...)
if (params.maxStalenessSeconds < MIN_ORACLE_STALENESS_SECONDS || ...) throw new Error(...)
```

---

## Verified Correct

### Account Name Matching (IDL ↔ SDK)

| Instruction | IDL Accounts | SDK `.accounts({})` | Match |
|---|---|---|---|
| `initialize_perk_oracle` | `protocol`, `perk_oracle`, `token_mint`, `oracle_authority`, `admin`, `system_program` | `protocol`, `perkOracle`, `tokenMint`, `oracleAuthority`, `admin`, `systemProgram` | ✅ |
| `update_perk_oracle` | `perk_oracle`, `authority` | `perkOracle`, `authority` | ✅ |
| `freeze_perk_oracle` | `protocol`, `perk_oracle`, `admin` | `protocol`, `perkOracle`, `admin` | ✅ |
| `transfer_oracle_authority` | `protocol`, `perk_oracle`, `signer`, `new_authority` | `protocol`, `perkOracle`, `signer`, `newAuthority` | ✅ |

All camelCase conversions are correct per Anchor TS conventions.

### Parameter Types (Rust ↔ TypeScript)

| Param Struct | Rust | TypeScript | Match |
|---|---|---|---|
| `InitPerkOracleParams.min_sources` | `u8` | `number` | ✅ |
| `InitPerkOracleParams.max_staleness_seconds` | `u32` | `number` | ✅ |
| `UpdatePerkOracleParams.price` | `u64` | `BN` | ✅ |
| `UpdatePerkOracleParams.confidence` | `u64` | `BN` | ✅ |
| `UpdatePerkOracleParams.num_sources` | `u8` | `number` | ✅ |

### PDA Derivation

| PDA | Rust Seeds | SDK Seeds | Match |
|---|---|---|---|
| PerkOracle | `[b"perk_oracle", token_mint.key().as_ref()]` | `[PERK_ORACLE_SEED, tokenMint.toBuffer()]` where `PERK_ORACLE_SEED = Buffer.from("perk_oracle")` | ✅ |

### Account Fetchers

- `fetchPerkOracle` uses `this.accounts.perkOraclePrice` — correct camelCase of Anchor struct name `PerkOraclePrice` ✅
- `fetchPerkOracleNullable` uses `fetchNullable` — correct pattern ✅

### PerkOracleAccount Type vs Rust Struct

All 14 public fields match between `PerkOracleAccount` (TS) and `PerkOraclePrice` (Rust):
`bump`, `tokenMint`, `authority`, `price`, `confidence`, `timestamp`, `numSources`, `minSources`, `lastSlot`, `emaPrice`, `maxStalenessSeconds`, `isFrozen`, `createdAt`, `totalUpdates` ✅

`_reserved` correctly omitted from TS type (internal implementation detail).

### Exports (index.ts)

All PerkOracle-related exports present:
- `findPerkOracleAddress` ✅
- `PerkOracleAccount` (type) ✅
- `InitPerkOracleParams` (type) ✅
- `UpdatePerkOracleParams` (type) ✅
- `PERK_ORACLE_SEED` ✅
- `MIN_ORACLE_STALENESS_SECONDS`, `MAX_ORACLE_STALENESS_SECONDS`, `MAX_MIN_SOURCES`, `MAX_ORACLE_PRICE` ✅
- `OracleSource` enum (includes `PerkOracle` variant) ✅

### Constants Mirror

| Constant | Rust | TypeScript | Match |
|---|---|---|---|
| `MIN_ORACLE_STALENESS_SECONDS` | 5 | 5 | ✅ |
| `MAX_ORACLE_STALENESS_SECONDS` | 300 | 300 | ✅ |
| `MAX_MIN_SOURCES` | 10 | 10 | ✅ |
| `MAX_ORACLE_PRICE` | 1_000_000_000_000 | 1_000_000_000_000 | ✅ |

### OracleSource Enum Serialization

```typescript
const ORACLE_SOURCE_MAP = {
  [OracleSource.PerkOracle]: { perkOracle: {} },
};
```

Matches Anchor enum variant `PerkOracle` serialization. ✅

### IDL Correctness

All four PerkOracle instructions present in IDL with correct discriminators, account lists, and arg types. Account types section includes `PerkOraclePrice` with all fields. Param types `InitPerkOracleParams` and `UpdatePerkOracleParams` present. ✅

---

## Conclusion

**No bugs found.** The SDK correctly mirrors the on-chain program for all PerkOracle operations. The one low-severity finding (cranker blind spot for PerkOracle updates) is an architectural gap rather than a correctness issue — but it will bite the first developer who tries to run a PerkOracle-backed market with only the cranker.
