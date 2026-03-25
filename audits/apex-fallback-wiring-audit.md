# Apex Fallback Oracle Wiring Audit

**Auditor:** Kai (Apex-tier automated audit)
**Date:** 2026-03-24
**Scope:** Fallback oracle wiring across oracle engine, 9 instructions, admin instruction, and SDK
**Severity Scale:** CRITICAL / HIGH / MEDIUM / LOW / INFO

---

## Executive Summary

The fallback oracle implementation is **well-designed and secure**. The core security invariant — that a fallback oracle account must match the on-chain `market.fallback_oracle_address` — is correctly enforced at the engine level and consistently wired through all 9 instructions. The admin instruction has proper access control and oracle validation.

**No critical or high-severity issues found.**

3 medium findings, 2 low findings, and 4 informational notes are documented below.

---

## Architecture Review

### Data Flow
```
Market account stores:
  - fallback_oracle_source: OracleSource
  - fallback_oracle_address: Pubkey

Admin sets via: admin_set_fallback_oracle
  → validates oracle account, prevents cross-token attacks, prevents primary==fallback

Engine reads via: read_oracle_price_with_fallback()
  → tries primary, on failure checks expected_fallback_address != default && source != primary
  → validates fallback_account.key == expected_fallback_address
  → reads fallback oracle

All 9 instructions:
  → pass &market.fallback_oracle_address as expected_fallback_address
  → have fallback_oracle: UncheckedAccount<'info> in accounts struct
```

### Files Reviewed
| File | Status |
|------|--------|
| `engine/oracle.rs` | ✅ Reviewed |
| `instructions/admin_set_fallback_oracle.rs` | ✅ Reviewed |
| `instructions/open_position.rs` | ✅ Reviewed |
| `instructions/liquidate.rs` | ✅ Reviewed |
| `instructions/close_position.rs` | ✅ Reviewed |
| `instructions/deposit.rs` | ✅ Reviewed |
| `instructions/withdraw.rs` | ✅ Reviewed |
| `instructions/execute_trigger_order.rs` | ✅ Reviewed |
| `instructions/crank_funding.rs` | ✅ Reviewed |
| `instructions/update_amm.rs` | ✅ Reviewed |
| `instructions/reclaim_empty_account.rs` | ✅ Reviewed |
| `sdk/src/client.ts` | ✅ Reviewed |
| `sdk/src/cranker.ts` | ✅ Reviewed |
| `sdk/src/types.ts` | ✅ Reviewed |

---

## Findings

### M-01: `OracleSource` enum equality check can silently skip legitimate fallbacks

**Severity:** MEDIUM
**Location:** `engine/oracle.rs` → `read_oracle_price_with_fallback()`

```rust
if *expected_fallback_address == Pubkey::default()
    || fallback_source == primary_source
{
    return Err(primary_err);
}
```

The `fallback_source == primary_source` check skips fallback when both sources are the same enum variant (e.g., both `OracleSource::Pyth`). This is intentional to prevent "same source" fallbacks, but creates a **silent degradation path**:

**Scenario:** Admin sets a Pyth fallback for a Pyth primary market (different Pyth feed accounts, e.g., Pyth TWAP vs Pyth spot). The engine silently skips the fallback because both are `OracleSource::Pyth`, even though the accounts are different and the fallback could provide a valid price.

**Impact:** Legitimate same-source-different-account fallback configurations are silently ignored. The admin instruction does NOT prevent this configuration (it only checks `fallback_address != primary_address`, not source equality). So an admin can set a seemingly valid fallback that will never actually be used.

**Recommendation:** Either:
1. Add the `fallback_source == primary_source` check to `admin_set_fallback_oracle` as well (reject at config time), or
2. Remove the source equality check from the engine and rely solely on address validation (the more flexible option — allows Pyth→Pyth fallback with different feeds)

Option 2 is preferred. The address check already prevents same-account loops.

---

### M-02: Admin can set fallback oracle, then primary oracle gets changed to same source — fallback becomes dead

**Severity:** MEDIUM
**Location:** `engine/oracle.rs` + admin update flow

**Scenario:**
1. Market has primary = Pyth (feed A), fallback = PerkOracle (feed B)
2. Admin calls `admin_update_market` and changes primary oracle source to PerkOracle (feed C)
3. Now both primary and fallback are `OracleSource::PerkOracle`
4. The engine's `fallback_source == primary_source` check silently disables the fallback

**Impact:** An admin action on the primary oracle can silently break the fallback without any warning. The market continues operating with no effective fallback, even though `fallback_oracle_address != Pubkey::default()`.

**Recommendation:** When `admin_update_market` changes the oracle source, either:
1. Emit a warning log if the new primary source matches the fallback source, or
2. Auto-clear the fallback (set to default) when primary source changes to match fallback source, or
3. Remove the source equality check per M-01 recommendation

---

### M-03: `admin_set_fallback_oracle` does not validate Pyth feed ID matches the market's token

**Severity:** MEDIUM
**Location:** `instructions/admin_set_fallback_oracle.rs`

For `PerkOracle` fallbacks, the code correctly validates `token_mint` matches market:
```rust
if params.fallback_oracle_source == OracleSource::PerkOracle {
    oracle::validate_perk_oracle_mint(
        &ctx.accounts.fallback_oracle.to_account_info(),
        &market.token_mint,
    )?;
}
```

However, for `Pyth` fallbacks, `validate_oracle()` only checks that the account deserializes as a valid `PriceUpdateV2`. It does **not** validate that the Pyth feed ID corresponds to the correct token. An admin could accidentally (or maliciously, if admin key is compromised) set a BTC Pyth feed as fallback for an ETH market.

**Impact:** If admin key is compromised, attacker could set a wrong-token Pyth feed as fallback, then wait for primary to go stale, causing the market to use an incorrect price for all operations. This would enable profitable manipulation of positions.

**Mitigating factor:** Requires admin key compromise AND primary oracle failure simultaneously. The admin key is a trusted role.

**Recommendation:** Consider storing the expected Pyth feed ID on the market and validating it during `validate_oracle()` for Pyth sources. Alternatively, document this as a known trust assumption on the admin role.

---

### L-01: `fallback_oracle: UncheckedAccount` has no constraint — any account accepted without fallback configured

**Severity:** LOW
**Location:** All 9 instructions

When no fallback is configured (`market.fallback_oracle_address == Pubkey::default()`), the `fallback_oracle` account is passed but never validated. The SDK defaults to `SystemProgram.programId`:

```typescript
fallbackOracle: fallbackOracle ?? SystemProgram.programId,
```

The on-chain code short-circuits before touching `fallback_account` when `expected_fallback_address == Pubkey::default()`, so this is safe. However, a malicious caller could pass any account as `fallback_oracle` (even a large account) and the runtime would still load it into memory, potentially wasting compute units.

**Impact:** Negligible. CU waste only, no security impact. The engine correctly skips fallback logic.

**Recommendation:** No action needed. This is by design — adding a constraint would require the SDK to know whether a fallback is configured before building the transaction, adding complexity.

---

### L-02: SDK `adminSetFallbackOracle` passes `params.fallbackOracleAddress` as both instruction arg and account

**Severity:** LOW
**Location:** `sdk/src/client.ts` → `adminSetFallbackOracle()`

```typescript
.accounts({
    protocol,
    market,
    fallbackOracle: params.fallbackOracleAddress,  // ← account
    admin: this.wallet.publicKey,
})
```

When removing a fallback (`fallbackOracleAddress = Pubkey.default`), this passes `11111111111111111111111111111111` (all zeros) as an account. The Solana runtime will resolve this to the system program (address 0x0...0), which is a valid account. The on-chain code short-circuits on the default address check before trying to read this account, so it works.

However, this is slightly fragile — if the on-chain removal path ever changes to validate the account first, it would break.

**Impact:** Currently safe. Mild fragility.

**Recommendation:** For removal, consider explicitly passing `SystemProgram.programId` as the fallback oracle account (consistent with how other instructions handle "no fallback"), though the current approach also works since the handler returns early.

---

### I-01: Account ordering — `fallback_oracle` after `oracle` is correct

**Severity:** INFO

All 9 instructions place `fallback_oracle: UncheckedAccount<'info>` immediately after the `oracle` account in their Accounts struct. This is consistent and won't break IDL ordering because:
- Anchor serializes accounts in struct declaration order
- Adding a new account at the end of the struct would be a breaking change, but `fallback_oracle` is placed mid-struct (after `oracle`)
- This means the IDL for these instructions has changed — **the program must be redeployed and all SDK consumers must upgrade simultaneously**
- The cranker and client SDK are already updated to include `fallbackOracle` in every call

**Action needed:** Ensure the IDL JSON (`sdk/src/idl.json`) is regenerated after `anchor build` and that no external consumers are using the old account layout.

---

### I-02: `resolveFallbackOracle()` helper in cranker is correct

**Severity:** INFO

```typescript
function resolveFallbackOracle(market: MarketAccount): PublicKey {
  const addr = market.fallbackOracleAddress;
  if (addr.equals(PublicKey.default)) return SystemProgram.programId;
  return addr;
}
```

This correctly maps `Pubkey::default()` (no fallback) to `SystemProgram.programId` as the sentinel value. The helper is used consistently across all cranker methods: `crankFunding`, `updatePeg`, `scanLiquidations`, `scanTriggerOrders`, `scanReclaims`.

---

### I-03: `ORACLE_SOURCE_MAP` serialization is correct for `adminSetFallbackOracle`

**Severity:** INFO

The SDK serializes the enum correctly:
```typescript
const ORACLE_SOURCE_MAP = {
  [OracleSource.Pyth]: { pyth: {} },
  [OracleSource.PerkOracle]: { perkOracle: {} },
  [OracleSource.DexPool]: { dexPool: {} },
};
```

And uses it in the instruction:
```typescript
.adminSetFallbackOracle({
    fallbackOracleSource: ORACLE_SOURCE_MAP[params.fallbackOracleSource],
    fallbackOracleAddress: params.fallbackOracleAddress,
})
```

This matches Anchor's enum serialization format. The `SetFallbackOracleParams` struct on-chain uses `OracleSource` which Anchor deserializes from this format. ✅

---

### I-04: `types.ts` correctly includes fallback fields on `MarketAccount`

**Severity:** INFO

```typescript
export interface MarketAccount {
  // ...
  fallbackOracleSource: OracleSource;
  fallbackOracleAddress: PublicKey;
}
```

And `SetFallbackOracleParams` is properly defined:
```typescript
export interface SetFallbackOracleParams {
  fallbackOracleSource: OracleSource;
  fallbackOracleAddress: PublicKey;
}
```

---

## Security Invariant Verification

### 1. Address validation in `read_oracle_price_with_fallback` — Is it sufficient?

**✅ YES.** The check `*fallback_account.key == *expected_fallback_address` is sufficient. The `expected_fallback_address` comes from `market.fallback_oracle_address`, which is stored in a PDA-derived Market account that only the admin can modify. An attacker cannot:
- Pass a different fallback account (key mismatch → `InvalidOracleSource`)
- Modify the market's stored address (requires admin signer)
- Bypass the check (it runs before `read_oracle_price`)

**No bypass possible.**

### 2. Is `admin_set_fallback_oracle` secure against non-admin callers?

**✅ YES.** The `AdminSetFallbackOracle` accounts struct uses:
```rust
#[account(
    seeds = [b"protocol"],
    bump = protocol.bump,
    has_one = admin,
)]
pub protocol: Box<Account<'info, Protocol>>,
pub admin: Signer<'info>,
```

The `has_one = admin` constraint requires `protocol.admin == admin.key()`, and `admin` must be a `Signer`. A non-admin cannot call this instruction.

### 3. Can it be used to set a malicious oracle?

**Partially mitigated.** The instruction validates the oracle via `validate_oracle()`, which checks:
- **Pyth:** Account is owned by the Pyth receiver program and deserializes as `PriceUpdateV2`
- **PerkOracle:** Account is owned by the Perk program and deserializes as `PerkOraclePrice`, plus `token_mint` matches market

An attacker with admin access could set a valid-but-wrong Pyth feed (see M-03). For PerkOracle, the `token_mint` check prevents cross-token attacks.

### 4. Account ordering — does adding `fallback_oracle` break anything?

**Yes — it's a breaking IDL change** (see I-01). The instruction account layout has changed. Old clients that don't pass `fallbackOracle` will fail. This is expected and handled by the SDK update.

### 5. `OracleSource` enum comparison skipping legitimate fallback?

**Yes — see M-01 and M-02.** Same-source fallbacks are silently skipped. This is a design limitation, not a vulnerability.

### 6. SDK correctness?

**✅ Correct.** The `ORACLE_SOURCE_MAP` properly serializes Anchor enums. All 9 methods default `fallbackOracle` to `SystemProgram.programId`. The cranker's `resolveFallbackOracle()` helper correctly reads the market's configured address.

---

## Consistency Matrix

All 9 instructions verified for consistent fallback wiring:

| Instruction | `fallback_oracle` in Accounts | Calls `read_oracle_price_with_fallback` | Passes `&market.fallback_oracle_address` | SDK updated |
|---|---|---|---|---|
| `open_position` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `close_position` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `deposit` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `withdraw` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `liquidate` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `execute_trigger_order` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `crank_funding` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `update_amm` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |
| `reclaim_empty_account` | ✅ `UncheckedAccount` | ✅ | ✅ | ✅ |

**All 9/9 instructions are consistently wired. No gaps.**

---

## Summary

| Severity | Count | IDs |
|----------|-------|-----|
| CRITICAL | 0 | — |
| HIGH | 0 | — |
| MEDIUM | 3 | M-01, M-02, M-03 |
| LOW | 2 | L-01, L-02 |
| INFO | 4 | I-01, I-02, I-03, I-04 |

The fallback oracle implementation is production-ready. The medium findings are design considerations that should be addressed before deployment but do not represent exploitable vulnerabilities under normal operational assumptions (trusted admin key).

**Recommended priority:**
1. **M-01** — Remove the `fallback_source == primary_source` check from the engine (allows Pyth→Pyth fallback with different feeds, most flexible fix, also resolves M-02)
2. **M-03** — Document Pyth feed ID as an admin trust assumption, or add feed ID validation
3. **I-01** — Verify IDL is regenerated and all consumers updated before deployment
