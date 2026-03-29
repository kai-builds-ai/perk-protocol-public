# PerkOracle System — Final Security Audit

**Auditor:** Pashov  
**Date:** 2026-03-24  
**Scope:** Complete PerkOracle system — on-chain program (Rust), SDK (TypeScript), oracle cranker  
**Severity Classification:** Critical / High / Medium / Low / Informational

---

## Executive Summary

The PerkOracle system is a custom oracle infrastructure for the Perk perpetual futures DEX. It consists of:
1. **On-chain oracle state** (`PerkOraclePrice`) with admin-controlled freeze, authority transfer, config updates, and fallback resolution
2. **Oracle engine** (`engine/oracle.rs`) with dual-path reading (Pyth + PerkOracle) and fallback support
3. **Oracle cranker** (TypeScript) that aggregates prices from Jupiter, Birdeye, and Raydium (stubbed), then posts on-chain via Jito bundles or normal RPC
4. **General cranker** (`cranker.ts`) that resolves fallback oracles for liquidations, funding, trigger orders, and peg updates

**Overall Assessment:** The system is well-designed with multiple layers of defense (staleness, confidence, price banding, freeze/unfreeze flow, fallback). Most critical attack vectors have been addressed through prior audit fixes. However, I have identified **1 Medium**, **3 Low**, and **4 Informational** findings.

---

## Findings

### [M-01] EMA can produce subtly misleading values after unfreeze (saturating math edge case)

**File:** `update_perk_oracle.rs:69-75`  
**Severity:** Medium

On unfreeze, `ema_price` is reset to 0 (`freeze_perk_oracle.rs:42`). On the first post-unfreeze update, since `ema_price == 0`, the handler sets `ema_price = params.price` (line 69). This is correct.

However, if the oracle was frozen for a long time and the new price differs significantly from the pre-freeze price, the EMA immediately jumps to the new price with zero smoothing. This is expected behavior, BUT:

The EMA calculation `price.saturating_add(ema_price.saturating_mul(9))` on line 72 can silently saturate when `ema_price` is very large (approaching `u64::MAX / 9`). For `ema_price > 2,049,638,230,412,172,401` (~2×10¹⁸), the multiply saturates to `u64::MAX`, and dividing by 10 gives `~1.84×10¹⁸` — effectively a stuck EMA that slowly drifts but never corrects.

**Impact:** EMA is documented as "non-critical" and not consumed by any instruction path. The comment in `update_perk_oracle.rs` explicitly states "EMA is non-critical... overflow must NOT brick the oracle by reverting the update." So this is by-design tolerance. However, if EMA is ever surfaced to users or used in future logic, it would be silently wrong.

**Recommendation:** Add a comment noting the saturation ceiling, or cap `ema_price` to `MAX_ORACLE_PRICE` (1×10¹²) which is well below the saturation threshold. Alternatively, use `checked_mul` and reset EMA to `params.price` on overflow.

---

### [L-01] Price banding division can produce zero `change_bps` for small price changes on large reference prices

**File:** `update_perk_oracle.rs:58-64`  
**Severity:** Low

The banding check computes:
```rust
let change_bps = diff.checked_mul(BPS_DENOMINATOR).ok_or(...)? / reference_price;
```

This is integer division. For a reference price of 1,000,000,000,000 (MAX_ORACLE_PRICE) and a diff of 99,999,999, the result is `99,999,999 × 10,000 / 1,000,000,000,000 = 0`, meaning a ~0.01% change rounds to 0 bps. This is conservative (allows the update), which is the safe direction — it only means the band is slightly looser than intended for high-price assets.

**Impact:** Negligible. The band is slightly wider than configured, not tighter. No exploitation path.

**Recommendation:** Acceptable as-is. Document the rounding behavior.

---

### [L-02] `_reserved` layout lacks formal documentation / magic bytes

**File:** `perk_oracle.rs`, `initialize_perk_oracle.rs`, `update_perk_oracle.rs`, `freeze_perk_oracle.rs`  
**Severity:** Low

The `_reserved[64]` field is used as follows:
- `[0]`: unfreeze_pending flag (0 or 1)
- `[1..3]`: max_price_change_bps (u16 little-endian)
- `[3..11]`: pre-freeze price (u64 little-endian)
- `[11..64]`: unused

**Verified:** No collisions exist. The layout is consistent across all instruction handlers:
- `initialize_perk_oracle.rs` writes `[1..3]` for banding bps, zeros the rest
- `update_perk_oracle.rs` reads `[0]` for unfreeze flag, reads `[1..3]` for banding, reads `[3..11]` for pre-freeze price
- `freeze_perk_oracle.rs` writes `[3..11]` for pre-freeze price, writes `[0]` for unfreeze flag
- `update_oracle_config.rs` writes `[1..3]` for banding bps

**Issue:** The layout is documented only in scattered comments. No single source of truth. Future developers could accidentally collide.

**Recommendation:** Add a block comment in `perk_oracle.rs` documenting the complete `_reserved` layout, or better, define named constants for the offsets:
```rust
const RESERVED_UNFREEZE_PENDING: usize = 0;
const RESERVED_BANDING_BPS: Range<usize> = 1..3;
const RESERVED_PRE_FREEZE_PRICE: Range<usize> = 3..11;
```

---

### [L-03] Cranker `minSources` default is 1 — single-source manipulation risk

**File:** `oracle-cranker.ts:36`  
**Severity:** Low

The default `minSources` is 1, and Raydium is stubbed (`fetchRaydiumPrices` returns empty). This means in practice, if Birdeye API key is not configured, the cranker operates on a single Jupiter source.

A single compromised or manipulated Jupiter API response would be posted directly on-chain without cross-validation. The on-chain `min_sources` check enforces what the cranker reports — but the cranker itself sets `numSources` from the aggregation result, and a single source passes.

**Impact:** Depends on deployment configuration. If `birdeyeApiKey` is set and `minSources >= 2`, this is mitigated. With defaults, it's a single-source dependency.

**Recommendation:** Strongly document that production deployments MUST set `birdeyeApiKey` and `minSources >= 2`. Consider making `minSources: 2` the default once Raydium is implemented.

---

### [I-01] Fallback oracle address validation is sound

**File:** `engine/oracle.rs:158-171`  
**Severity:** Informational (Positive Finding)

The fallback oracle flow is correctly secured:
1. `read_oracle_price_with_fallback` requires `expected_fallback_address` from the Market account
2. The passed `fallback_account.key` is validated against this address before use
3. `Pubkey::default()` means "no fallback configured" and short-circuits to the primary error
4. `admin_set_fallback_oracle.rs` validates:
   - Account key matches params address
   - Fallback != primary oracle
   - Oracle deserializes correctly
   - For PerkOracle: token_mint matches market
5. SDK's `resolveFallbackOracle()` in cranker.ts correctly passes `SystemProgram.programId` as sentinel when no fallback is configured

**No bypass found.** An attacker cannot inject a fake oracle as fallback because the address is stored in the Market account (admin-only write) and validated on every read.

---

### [I-02] Pyth price scaling is correct but has a subtle precision loss path

**File:** `engine/oracle.rs:93-110`  
**Severity:** Informational

`scale_pyth_price` handles both upscaling (shift ≥ 0) and downscaling (shift < 0) with checked arithmetic. The downscaling path uses `checked_div`, which truncates. For extremely small prices (e.g., price=1, expo=-10 → shift=-4 → 1/10000 = 0), the function returns 0, which is caught by the `require!(price_scaled > 0)` check.

This means tokens with prices below ~$0.000001 (1e-6) will be rejected by the Pyth path. This is intentional and documented by the PRICE_SCALE design.

---

### [I-03] No state where both oracles are unusable but trading continues

**File:** `open_position.rs:61-68`, `liquidate.rs:51-58`  
**Severity:** Informational (Positive Finding)

Both `open_position` and `liquidate` call `read_oracle_price_with_fallback` before any state mutations. If both primary and fallback oracles fail (stale, frozen, confidence too wide, etc.), the instruction reverts with `OracleStale`, `OracleFrozen`, or `OracleFallbackFailed`.

**Trading cannot continue with an unusable oracle.** The call is at the top of the handler, before any AMM or position state changes.

Verified paths:
- `open_position.rs:61` — reads oracle before accrue
- `liquidate.rs:51` — reads oracle before accrue
- Both crank_funding and update_amm (per grep) also read oracle

---

### [I-04] SDK correctly passes fallback_oracle in all instruction methods

**File:** `client.ts`, `cranker.ts`  
**Severity:** Informational (Positive Finding)

Every instruction method that requires oracle reads passes `fallbackOracle`:
- `openPosition` — `fallbackOracle: fallbackOracle ?? SystemProgram.programId`
- `closePosition` — same pattern
- `liquidate` — same pattern
- `crankFunding` — same pattern
- `updateAmm` — same pattern
- `executeTriggerOrder` — same pattern
- `addCollateral`, `withdrawCollateral` — same pattern
- `reclaimEmptyAccount` — same pattern

The cranker (`cranker.ts`) uses `resolveFallbackOracle(market)` which reads `market.fallbackOracleAddress` and returns `SystemProgram.programId` if it's `Pubkey.default`. This sentinel is correct — on-chain checks `expected_fallback_address == Pubkey::default()` and short-circuits before reading the sentinel account.

---

## Detailed Review by Checklist Item

### ✅ Oracle reading paths validated (staleness, frozen, confidence, price bounds, authority)

| Check | PerkOracle | Pyth | Status |
|-------|-----------|------|--------|
| Staleness | `age <= max_staleness_seconds` | `age <= MAX_STALENESS (15s)` | ✅ |
| Frozen | `!oracle.is_frozen` | N/A (Pyth manages) | ✅ |
| Confidence | `conf <= price * 200bps / 10000` | Same formula | ✅ |
| Price bounds | `price > 0 && price <= MAX_ORACLE_PRICE` | `price > 0` (Pyth) + `price_scaled > 0` | ✅ |
| Authority | `has_one = authority` on update | N/A (Pyth writes) | ✅ |
| Future timestamps | `age >= 0` | `age >= 0` | ✅ |
| Min sources | `num_sources >= min_sources` | N/A | ✅ |
| Program ownership | `oracle_account.owner == crate::ID` | `owner == pyth_solana_receiver_sdk::ID` | ✅ |

### ✅ Fallback oracle address validation cannot be bypassed

- Address stored in `Market.fallback_oracle_address` (admin-only write via `admin_set_fallback_oracle`)
- At read time: `fallback_account.key == expected_fallback_address` (from Market)
- At set time: account key matches params, oracle deserializes, token_mint matches (PerkOracle)
- Cannot be bypassed by passing a different account — Anchor constraint validation + explicit key check

### ✅ Price banding math is overflow-safe with checked_mul

`update_perk_oracle.rs:60`:
```rust
let change_bps = diff.checked_mul(BPS_DENOMINATOR).ok_or(PerkError::MathOverflow)? / reference_price;
```

- `diff` is at most `MAX_ORACLE_PRICE` (1×10¹²)
- `BPS_DENOMINATOR` is 10,000
- Product: 1×10¹⁶ — well within `u64::MAX` (1.8×10¹⁹)
- ✅ No overflow possible for valid oracle prices

Confidence check in `oracle.rs:52`:
```rust
let max_conf = oracle.price.checked_mul(ORACLE_CONFIDENCE_BPS as u64).ok_or(...)?.checked_div(BPS_DENOMINATOR).ok_or(...)?;
```
- `MAX_ORACLE_PRICE * 200 = 2×10¹⁴` — within u64 range
- ✅ Safe

### ✅ Pre-freeze price storage in _reserved[3..11] is consistent

| Handler | Operation | Bytes |
|---------|-----------|-------|
| `freeze_perk_oracle` (unfreeze path) | Write `oracle.price.to_le_bytes()` | `[3..11]` |
| `update_perk_oracle` | Read `u64::from_le_bytes(_reserved[3..11])` | `[3..11]` |
| `initialize_perk_oracle` | Zero-init all `_reserved` | `[0..64]` |

✅ Consistent. Write and read use identical byte ranges and endianness.

### ✅ EMA saturating math doesn't produce garbage values (with caveat)

See [M-01] above. Saturating math prevents reverts but can produce a stuck EMA for extremely high prices. Since EMA is not consumed by any instruction, this is acceptable but should be documented.

### ✅ Unfreeze flow is correct

1. Admin calls `freeze_perk_oracle(frozen=false)`:
   - Stores current `oracle.price` in `_reserved[3..11]`
   - Sets `oracle.price = 0`
   - Sets `oracle.ema_price = 0`
   - Sets `_reserved[0] = 1` (unfreeze_pending)

2. Any instruction trying to read the oracle now fails: `require!(oracle.price > 0)` → `OraclePriceInvalid`

3. Cranker calls `update_perk_oracle`:
   - `!oracle.is_frozen` → passes (unfrozen)
   - `unfreeze_pending = true` → bypasses gap check
   - Banding: `oracle.price == 0`, so reference_price = pre-freeze from `_reserved[3..11]`
   - New price is banded against pre-freeze price → prevents arbitrary jump
   - `_reserved[0] = 0` → clears unfreeze flag (one-time bypass)

4. Next read succeeds with fresh price

✅ Correct. No window where stale price is readable. No unbounded price jump on unfreeze.

### ✅ Cranker: outlier rejection, source validation, Jito bundles, timeout handling

| Feature | Implementation | Status |
|---------|---------------|--------|
| Outlier rejection | Median-based, configurable `maxSourceDeviationPct` (default 1%) | ✅ |
| Re-check after rejection | Recomputes median with remaining sources, checks `minSources` | ✅ |
| Jito bundles | Full implementation with tip rotation, fallback to RPC | ✅ |
| `jitoOnly` mode | Prevents mempool leakage when Jito fails | ✅ |
| Fetch timeout | `AbortController`-based, configurable (default 5000ms) | ✅ |
| Tick guard | `tickInProgress` flag prevents concurrent ticks | ✅ |
| Graceful stop | Waits for current tick to finish (configurable timeout) | ✅ |
| Source validation | `isFinite(price) && price > 0`, schema validation on API responses | ✅ |
| Birdeye staleness | Rejects prices with timestamps > 60s old | ✅ |

### ✅ SDK passes fallback_oracle correctly in all methods

See [I-04] above. All 9+ instruction methods pass `fallbackOracle ?? SystemProgram.programId`.

### ✅ No state where both oracles unusable but trading continues

See [I-03] above. Oracle read is the first operation in every trading/liquidation handler.

### ✅ _reserved byte layout has no collisions

| Range | Purpose | Written By | Read By |
|-------|---------|-----------|---------|
| `[0]` | unfreeze_pending | freeze_perk_oracle, update_perk_oracle | update_perk_oracle |
| `[1..3]` | max_price_change_bps (u16 LE) | initialize_perk_oracle, update_oracle_config | update_perk_oracle |
| `[3..11]` | pre-freeze price (u64 LE) | freeze_perk_oracle | update_perk_oracle |
| `[11..64]` | unused | — | — |

✅ No overlaps.

---

## Additional Observations

### Oracle Authority Transfer — Admin Recovery

`transfer_oracle_authority.rs` correctly allows EITHER the current authority OR the protocol admin to transfer. This is critical for operational recovery (e.g., compromised cranker key). The zero-address check prevents bricking.

### Oracle Rate Limiting

One update per slot (`clock.slot > oracle.last_slot`) prevents spam and ensures at most ~2.5 updates/second. Combined with the gap attack check (2× staleness window), this creates a safe operating envelope.

### Gap Attack Protection

If the oracle hasn't been updated for 2× `max_staleness_seconds`, the `update_perk_oracle` handler rejects updates (unless `unfreeze_pending`). This prevents a scenario where an attacker waits for the oracle to go stale, then posts an extreme price. Admin must explicitly freeze then unfreeze to reset the gap timer.

### Confidence as max-min spread

The cranker computes confidence as `maxPrice - minPrice` across accepted sources, not as a percentage. This gets scaled by `PRICE_SCALE` and checked on-chain as `conf <= price * 2%`. For 2 sources at ±0.5% deviation, confidence = ~1% of price, which passes the 2% on-chain check. The `maxSourceDeviationPct` (1% default) correctly ensures max confidence is ~2% of median, matching the on-chain bound.

### Missing: Pyth feed ID validation

When setting a Pyth oracle on a market, the system validates the account deserializes as `PriceUpdateV2` but does NOT validate that the Pyth feed ID corresponds to the correct token. This is admin-only, so the trust assumption is reasonable, but for PerkOracle the system correctly validates `token_mint`. This asymmetry is worth noting.

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| M-01 | Medium | EMA saturating math can produce stuck values at extreme prices | Open |
| L-01 | Low | Price banding integer division rounds to zero for small changes on high prices | Accepted |
| L-02 | Low | `_reserved` layout lacks formal documentation / named constants | Open |
| L-03 | Low | Cranker `minSources` defaults to 1 — single-source risk | Open |
| I-01 | Info | Fallback oracle validation is sound — no bypass found | ✅ |
| I-02 | Info | Pyth scaling precision loss for sub-$0.000001 tokens — by design | ✅ |
| I-03 | Info | No trading-while-oracle-unusable state exists | ✅ |
| I-04 | Info | SDK correctly passes fallback_oracle everywhere | ✅ |

---

## Conclusion

The PerkOracle system is well-engineered for a mainnet launch. The critical security properties — fallback validation, freeze/unfreeze atomicity, price banding, staleness enforcement — are all correctly implemented. Prior audit fixes (H-01, C-01, M-02, M-04) are verified as correctly integrated.

The Medium finding (M-01, EMA saturation) is low-risk given EMA is not consumed by any instruction, but should be addressed before any future use of EMA in protocol logic. The Low findings are primarily operational hardening and documentation improvements.

**Recommendation:** Address M-01 and L-02 before mainnet. L-03 should be part of deployment documentation. System is otherwise ready for launch.

---

*Pashov — Solo DeFi Auditor*  
*2026-03-24*
