# SDK & E2E Security Tests — Pashov Review

**Date:** 2026-03-25  
**Auditor:** Kai (Pashov-style solo review)  
**Scope:** SDK types, client, constants, index exports; E2E security test suite; on-chain instructions (initialize_perk_oracle, update_oracle_config, update_perk_oracle, freeze_perk_oracle); constants.rs  
**Commit:** HEAD (pre-deploy review)

---

## Executive Summary

The SDK and security E2E tests are **well-constructed** overall. Constants are synchronized, Borsh serialization is correct through Anchor's IDL-based approach, and the E2E test math is sound. I found **0 Critical**, **0 High**, **2 Medium**, **3 Low**, and **4 Informational** issues.

The most significant findings are: (1) the `PerkOracleAccount` TS type cannot expose `_reserved`-stored security parameters (maxPriceChangeBps, circuitBreakerDeviationBps, windowRefPrice, preFreezePrice), meaning SDK consumers cannot verify active security configurations; and (2) the E2E tests have no coverage for downward price movements, boundary-exact values, or repeated freeze/unfreeze cycles.

---

## [P-01] PerkOracleAccount TS Type Missing Security Fields Stored in `_reserved`

**Severity:** Medium

**Description:**  
The on-chain `PerkOraclePrice` account stores critical security parameters in the `_reserved: [u8; 64]` field at manually-managed byte offsets:

| Offset | Field | Type |
|--------|-------|------|
| `[1..3]` | `max_price_change_bps` | u16 LE |
| `[3..11]` | `pre_freeze_price` | u64 LE |
| `[11..19]` | `window_ref_price` | u64 LE |
| `[19..27]` | `window_ref_slot` | u64 LE |
| `[27..29]` | `circuit_breaker_deviation_bps` | u16 LE |

The SDK's `PerkOracleAccount` interface in `types.ts` does not expose any of these fields. SDK consumers (dashboards, monitoring tools, the cranker itself) **cannot determine what banding or circuit breaker settings are active** on an oracle without manually parsing raw account bytes.

**Proof:**  
```typescript
// types.ts — PerkOracleAccount has no maxPriceChangeBps, circuitBreakerDeviationBps, etc.
export interface PerkOracleAccount {
  bump: number;
  tokenMint: PublicKey;
  authority: PublicKey;
  price: BN;
  confidence: BN;
  timestamp: BN;
  numSources: number;
  minSources: number;
  lastSlot: BN;
  emaPrice: BN;
  maxStalenessSeconds: number;
  isFrozen: boolean;
  createdAt: BN;
  totalUpdates: BN;
  // _reserved fields are NOT exposed
}
```

Test 5 (`Oracle Config Update`) verifies `minSources` and `maxStalenessSeconds` after config change (these are real struct fields), but **cannot verify** that `circuitBreakerDeviationBps` was actually updated to 2000 because it's hidden in `_reserved`.

**Recommendation:**  
Add a helper method to `PerkClient` that parses the raw `_reserved` bytes and returns the full security config:
```typescript
interface PerkOracleSecurityConfig {
  maxPriceChangeBps: number;
  circuitBreakerDeviationBps: number;
  preFreezePrice: BN;
  windowRefPrice: BN;
  windowRefSlot: BN;
  unfreezePending: boolean;
}

async fetchPerkOracleSecurityConfig(tokenMint: PublicKey): Promise<PerkOracleSecurityConfig> {
  // fetch raw account, parse _reserved bytes at known offsets
}
```

---

## [P-02] E2E Tests Lack Downward Price Movement Coverage

**Severity:** Medium

**Description:**  
All six security E2E tests exclusively use **upward** price movements. The on-chain code computes absolute deviation using conditional subtraction:

```rust
let diff = if params.price > reference_price {
    params.price - reference_price
} else {
    reference_price - params.price  // ← this path is never tested
};
```

This pattern appears in three places: per-update banding, circuit breaker, and sliding window. A bug in the downward branch (e.g., reversed operand order causing underflow in a future refactor) would be undetected by the current test suite.

**Recommendation:**  
Add a Test 7: "Downward Price Movement — All Checks" that:
1. Posts initial price 100,000
2. Attempts -20% (80,000) with 10% CB → should reject
3. Attempts -8% (92,000) → should pass
4. Attempts -6% (86,480) with 5% banding → should reject per-update
5. Verifies window also catches cumulative downward walk

---

## [P-03] Test 3 Sliding Window — Per-Update Banding Passes by 1 BPS Margin

**Severity:** Low

**Description:**  
In Test 3 (Sliding Window), step 3 posts 115,762. The per-update banding check against the previous price (110,250) passes with only 1 bps margin:

```
diff = 115,762 - 110,250 = 5,512
change_bps = 5,512 * 10,000 / 110,250 = 499  (integer division)
max_change_bps = 500
499 <= 500 → PASS (margin: 1 bps)
```

If Rust's integer division truncated differently (it doesn't — Rust floors), or if the test price was off by a few units, the test would fail at per-update banding instead of the intended sliding window check. The test is **correct** but **fragile** to price value changes.

Additionally, both per-update banding and window rejection emit the same error code (`OraclePriceInvalid`), so the test cannot verify *which* check caught the violation.

**Proof/Math:**  
```
Per-update: 5,512 * 10,000 / 110,250 = 499.977... → 499 ≤ 500 ✅
Window:     15,762 * 10,000 / 100,000 = 1,576.2  → 1,576 > 1,500 ✅ (rejected)
```

**Recommendation:**  
1. Add a comment documenting the tight margin: `// 115,762 chosen so per-update = 499 bps (< 500) but window = 1,576 bps (> 1,500)`
2. Consider using distinct error codes for per-update vs window rejection on-chain, enabling tests to verify which check triggered.

---

## [P-04] Error Message Matching Is Overly Broad

**Severity:** Low

**Description:**  
The E2E tests match error messages using broad substring checks:

```typescript
// Test 1
err.message.includes("OracleCircuitBreakerTripped") ||
err.message.includes("CircuitBreaker") ||
err.message.includes("circuit")
```

The substring `"circuit"` would match any error containing that word, including hypothetical future errors like `"CircuitBoardFailure"`. More critically, several tests have a fallback `⚠️ Got error` path that logs a warning but **counts the test as passed**:

```typescript
} else {
  console.log(`  ⚠️ Got error (may be circuit breaker): ${err.message?.slice(0, 150)}`);
  // No throw — test continues and passes!
}
```

This means if the error name changes across Anchor versions, or if a completely unrelated error occurs, the test silently "passes" with a warning. Only the `"Should have failed!"` sentinel prevents false positives from *successful* transactions.

**Recommendation:**  
1. Tighten error matching to exact Anchor error names (e.g., `err.error?.errorCode?.code === "OracleCircuitBreakerTripped"`)
2. Make the `⚠️` fallback a hard failure or at minimum track it separately in the summary
3. Use Anchor's structured error parsing instead of string matching

---

## [P-05] No Test Coverage for Boundary-Exact Values

**Severity:** Low

**Description:**  
No test verifies behavior when a price change is **exactly at** a limit boundary:

| Check | Exact Boundary | Tested Below | Tested Above |
|-------|---------------|-------------|-------------|
| Circuit breaker (10%) | 55,000 from 50,000 (1,000 bps) | 54,000 (8%) | 60,000 (20%) |
| Per-update banding (5%) | 105,000 from 100,000 (500 bps) | 104,000 (4%) | 110,000 (10%) |
| Sliding window (15%) | window_max_bps = 1,500 | Not tested | 115,762 (1,576 bps) |

The on-chain code uses `<=` for all checks (`require!(change_bps <= max_change_bps ...)`), so exact boundary values should pass. But this is unverified.

**Recommendation:**  
Add boundary tests:
- CB: post exactly 55,000 from EMA 50,000 (1,000 bps) → should PASS
- CB: post exactly 55,001 (1,000.02 bps) → should FAIL
- Banding: post exactly 105,000 from 100,000 (500 bps) → should PASS
- Banding: post exactly 105,001 → should FAIL

---

## [P-06] `MAX_FUNDING_ITERATIONS` in SDK Has No On-Chain Counterpart in constants.rs

**Severity:** Informational

**Description:**  
The SDK exports `MAX_FUNDING_ITERATIONS = 50` from `constants.ts`. This constant does not appear in `constants.rs`. It's likely defined in the funding instruction handler or is a client-side iteration limit. The discrepancy makes it unclear whether this is an on-chain constraint or a client-side safety bound.

**Recommendation:**  
Add a comment in `constants.ts` clarifying the source: `// Client-side limit, not in constants.rs — defined in crank_funding handler`

---

## [P-07] Borsh Serialization Correctness — Verified Clean

**Severity:** Informational

**Description:**  
Both parameter structs were verified for correctness:

**`InitPerkOracleParams`:**
| # | Rust Field (snake_case) | Rust Type | TS Field (camelCase) | TS Type |
|---|------------------------|-----------|---------------------|---------|
| 1 | `min_sources` | `u8` | `minSources` | `number` |
| 2 | `max_staleness_seconds` | `u32` | `maxStalenessSeconds` | `number` |
| 3 | `max_price_change_bps` | `u16` | `maxPriceChangeBps` | `number` |
| 4 | `circuit_breaker_deviation_bps` | `u16` | `circuitBreakerDeviationBps` | `number` |

**`UpdateOracleConfigParams`:**
| # | Rust Field | Rust Type | TS Field | TS Type |
|---|-----------|-----------|----------|---------|
| 1 | `max_price_change_bps` | `Option<u16>` | `maxPriceChangeBps` | `number \| null` |
| 2 | `min_sources` | `Option<u8>` | `minSources` | `number \| null` |
| 3 | `max_staleness_seconds` | `Option<u32>` | `maxStalenessSeconds` | `number \| null` |
| 4 | `circuit_breaker_deviation_bps` | `Option<u16>` | `circuitBreakerDeviationBps` | `number \| null` |

Anchor serializes based on the IDL field order (derived from Rust struct definition order), not JS object key order. Field names after camelCase conversion match exactly. `null` maps to `None`, `number` maps to `Some(value)`. **No serialization mismatch found.**

The client code in `client.ts` explicitly constructs param objects with matching field names for both `initializePerkOracle` and `updateOracleConfig`, passing them directly to `this.program.methods.*()`. ✅

---

## [P-08] Constants Sync — Verified Clean (All 10 New Constants Match)

**Severity:** Informational

**Description:**  
Full comparison of all oracle security constants between `sdk/src/constants.ts` and `programs/.../constants.rs`:

| Constant | SDK (TS) | On-Chain (Rust) | Match |
|----------|----------|-----------------|-------|
| `MIN_ORACLE_STALENESS_SECONDS` | 5 | 5 (u32) | ✅ |
| `MAX_ORACLE_STALENESS_SECONDS` | 300 | 300 (u32) | ✅ |
| `MAX_MIN_SOURCES` | 10 | 10 (u8) | ✅ |
| `MAX_ORACLE_PRICE` | 1,000,000,000,000 | 1,000,000,000,000 (u64) | ✅ |
| `MIN_PRICE_CHANGE_BPS` | 100 | 100 (u16) | ✅ |
| `MAX_PRICE_CHANGE_BPS` | 9,999 | 9,999 (u16) | ✅ |
| `MIN_CIRCUIT_BREAKER_BPS` | 500 | 500 (u16) | ✅ |
| `MAX_CIRCUIT_BREAKER_BPS` | 9,999 | 9,999 (u16) | ✅ |
| `CIRCUIT_BREAKER_WINDOW_SLOTS` | 50 | 50 (u64) | ✅ |
| `WINDOW_BAND_MULTIPLIER` | 3 | 3 (u64) | ✅ |
| `BPS_DENOMINATOR` | 10,000 | 10,000 (u64) | ✅ |
| `PERK_ORACLE_SEED` | `"perk_oracle"` | `b"perk_oracle"` | ✅ |

All 41 exported constants in `constants.ts` were verified. **No value mismatches found.**

Notable: `RESERVED_OFFSET_*` constants are intentionally SDK-excluded (internal to on-chain byte layout). This is acceptable but creates the gap described in P-01.

---

## [P-09] E2E Test Math — Verified Correct (All 6 Tests)

**Severity:** Informational

**Description:**  
Re-derivation of expected behavior for each test from on-chain code:

### Test 1: Circuit Breaker Rejects +20%
```
Init: CB = 1000 bps, banding = 0
Post 50,000 → EMA = 50,000 (first update: EMA = price)

Attempt 60,000:
  old_ema = 50,000
  deviation = |60,000 - 50,000| = 10,000
  deviation_bps = 10,000 × 10,000 / 50,000 = 2,000
  2,000 > 1,000 → REJECT ✅

Attempt 54,000:
  old_ema = 50,000 (60k reverted, EMA unchanged)
  deviation_bps = 4,000 × 10,000 / 50,000 = 800
  800 ≤ 1,000 → PASS ✅
```

### Test 2: CB Disabled Allows +100%
```
Init: CB = 0, banding = 0
Post 50,000 → 100,000: no checks active → PASS ✅
```

### Test 3: Sliding Window Rejects Cumulative Walk
```
Init: banding = 500 bps, CB = 0
Post 100,000 → window_ref = 100,000

Step 1 (105,000):
  Per-update: |105,000 - 100,000| × 10,000 / 100,000 = 500 ≤ 500 → PASS
  Window: 500 ≤ 1,500 → PASS ✅

Step 2 (110,250):
  Per-update: |110,250 - 105,000| × 10,000 / 105,000 = 500 ≤ 500 → PASS
  Window: |110,250 - 100,000| × 10,000 / 100,000 = 1,025 ≤ 1,500 → PASS ✅

Step 3 (115,762):
  Per-update: |115,762 - 110,250| × 10,000 / 110,250 = 499 ≤ 500 → PASS
  Window: |115,762 - 100,000| × 10,000 / 100,000 = 1,576 > 1,500 → REJECT ✅
```

### Test 4: Unfreeze Anchoring
```
Init: banding = 3000 bps, CB = 1000 bps
Posts: 100,000 → 100,100 → 100,200
  EMA after 3 updates: ~100,029

Freeze → Unfreeze:
  pre_freeze_price = 100,200
  ema_price = 100,200 (anchored to pre-freeze)
  price = 0, window_ref = 100,200

Attempt 130,000:
  Banding ref = pre_freeze_price (100,200, since oracle.price = 0)
  change_bps = 29,800 × 10,000 / 100,200 = 2,974 ≤ 3,000 → PASS
  CB: deviation_bps = 29,800 × 10,000 / 100,200 = 2,974 > 1,000 → REJECT ✅

Attempt 108,000:
  Banding: 7,800 × 10,000 / 100,200 = 778 ≤ 3,000 → PASS
  CB: 778 ≤ 1,000 → PASS ✅
```

### Test 5: Config Update — Verified structurally correct
### Test 6: Per-Update Banding — Trivially correct (+10% > 5% band)

**All test math is sound. No arithmetic errors found.**

---

## Summary

| ID | Severity | Title |
|----|----------|-------|
| P-01 | Medium | PerkOracleAccount TS type missing `_reserved` security fields |
| P-02 | Medium | No downward price movement test coverage |
| P-03 | Low | Test 3 sliding window passes per-update by 1 bps margin (fragile) |
| P-04 | Low | Error message matching is overly broad with silent pass-on-warn |
| P-05 | Low | No boundary-exact value tests |
| P-06 | Informational | `MAX_FUNDING_ITERATIONS` has no on-chain counterpart in constants.rs |
| P-07 | Informational | Borsh serialization — verified clean |
| P-08 | Informational | Constants sync — verified clean (all match) |
| P-09 | Informational | E2E test math — verified correct (all 6 tests) |
