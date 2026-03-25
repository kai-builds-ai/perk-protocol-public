# SDK & Security E2E Review — Round 1

**Date:** 2026-03-25  
**Reviewer:** Kai (automated code review)  
**Scope:** SDK types/client changes + `e2e-security.test.ts`  
**Verdict:** ✅ PASS — No bugs found. Code is clean, tests are well-structured.

---

## SDK Types (`types.ts`)

| Checklist Item | Status | Notes |
|---|---|---|
| `InitPerkOracleParams.circuitBreakerDeviationBps` matches on-chain `u16` | ✅ PASS | SDK `number` → Anchor Borsh `u16`. Safe (max 65535 < 2^53). |
| `UpdateOracleConfigParams` fields match on-chain `Option<T>` → `T \| null` | ✅ PASS | All 4 fields: `Option<u16>`, `Option<u8>`, `Option<u32>`, `Option<u16>` → `number \| null` |
| Anchor Borsh `Option<u16>` ↔ `number \| null` | ✅ PASS | Standard Anchor TS convention. `null` serializes as Borsh `None`. |
| No type mismatches between SDK and on-chain | ✅ PASS | Field names, types, and ordering all match. |

---

## SDK Client (`client.ts`)

| Checklist Item | Status | Notes |
|---|---|---|
| `initializePerkOracle` passes `circuitBreakerDeviationBps` | ✅ PASS | All 4 params passed explicitly: `minSources`, `maxStalenessSeconds`, `maxPriceChangeBps`, `circuitBreakerDeviationBps` |
| `updateOracleConfig` passes all 4 fields including nulls | ✅ PASS | Passes `maxPriceChangeBps`, `minSources`, `maxStalenessSeconds`, `circuitBreakerDeviationBps` — nulls become `None` |
| Anchor TS handles `null` → `None` correctly | ✅ PASS | Confirmed Anchor convention. |

---

## E2E Security Tests (`e2e-security.test.ts`)

### Test 1: Circuit Breaker Rejects Wild Price Jump

| Check | Status | Notes |
|---|---|---|
| Setup correct | ✅ PASS | CB=1000 bps (10%), banding=0 (off). Isolates CB. |
| Fresh mint | ✅ PASS | `createFreshMint()` |
| Initial price 50,000 → EMA = 50,000 | ✅ PASS | First update sets `ema_price = price` directly (on-chain: `if oracle.ema_price == 0`) |
| 60,000 (+20%) rejected | ✅ PASS | deviation = 10,000/50,000 × 10,000 = 2,000 bps > 1,000. `OracleCircuitBreakerTripped`. |
| 54,000 (+8%) accepted | ✅ PASS | deviation = 4,000/50,000 × 10,000 = 800 bps ≤ 1,000. |
| Error matching | ✅ PASS | Checks `OracleCircuitBreakerTripped`, `CircuitBreaker`, `circuit` — covers Anchor's error message format. |
| Sleep sufficient | ✅ PASS | 2000ms between updates ≈ 5 devnet slots. Rate limit is 1-per-slot. |

### Test 2: Circuit Breaker Allows When Disabled

| Check | Status | Notes |
|---|---|---|
| Setup correct | ✅ PASS | CB=0, banding=0. Both disabled. |
| 100,000 (+100%) accepted | ✅ PASS | No protection enabled. On-chain: `if cb_bps > 0` — skipped. |

### Test 3: Sliding Window Rejects Cumulative Walk

| Check | Status | Notes |
|---|---|---|
| Setup correct | ✅ PASS | banding=500 (5%/update), CB=0. Isolates sliding window. |
| Walk prices correct | ✅ PASS | Each step is ~+5% (within per-update band), but cumulative exceeds window. |
| Window multiplier | ✅ PASS | `WINDOW_BAND_MULTIPLIER = 3`, so window limit = 500 × 3 = 1,500 bps. |
| Expected failure point | ✅ PASS | At 115,762: cumulative = 15,762/100,000 × 10,000 = 1,576 bps > 1,500. Per-update band for this step: 5,512/110,250 × 10,000 ≈ 499 bps ≤ 500. So window check catches it while per-update passes. |
| Error: `OraclePriceInvalid` | ✅ PASS | Matches on-chain `PerkError::OraclePriceInvalid`. |
| Loop structure | ✅ PASS | Resilient — doesn't hardcode which step fails, just expects *some* step to fail. |
| Window not expired | ✅ PASS | `CIRCUIT_BREAKER_WINDOW_SLOTS = 50`. At 2s/update ≈ 5 slots each. 4 updates = ~20 slots < 50. Window stays active. |

**Detailed walk trace:**
1. Post 100,000: First update → window_ref = 100,000. ✅ accepted
2. Post 105,000: per-update = 500 bps ≤ 500 ✅; window = 500 bps ≤ 1500 ✅
3. Post 110,250: per-update ≈ 500 bps ≤ 500 ✅; window = 1,025 bps ≤ 1500 ✅
4. Post 115,762: per-update ≈ 499 bps ≤ 500 ✅; window = 1,576 bps > 1500 ❌ → **rejected**

### Test 4: Unfreeze Anchoring — EMA Preserved

| Check | Status | Notes |
|---|---|---|
| EMA established | ✅ PASS | 3 updates (100,000 → 100,100 → 100,200). EMA ≈ 100,029 after 3 rounds. |
| Freeze/unfreeze cycle | ✅ PASS | Freeze then unfreeze. Price zeroed, EMA preserved. |
| 130,000 rejected by CB | ✅ PASS | Per-update banding: ref = pre_freeze_price ≈ 100,200. diff ≈ 29,800. change_bps ≈ 2,974 ≤ 3,000. **Passes banding.** CB: deviation from EMA ≈ 29,971/100,029 × 10,000 ≈ 2,996 bps > 1,000. **Fails CB.** ✅ |
| 108,000 accepted | ✅ PASS | Banding: ~7,800/100,200 ≈ 778 bps ≤ 3,000. CB: ~7,971/100,029 ≈ 796 bps ≤ 1,000. Both pass. |
| Failed tx doesn't persist EMA change | ✅ PASS | Solana rolls back all state on instruction failure. EMA stays ~100,029 for the 108,000 attempt. |

### Test 5: Oracle Config Update (All Fields)

| Check | Status | Notes |
|---|---|---|
| Freeze before config update | ✅ PASS | On-chain requires `is_frozen` (M-02 fix). Test freezes first. |
| `null` fields preserved | ✅ PASS | `maxStalenessSeconds: null` → `None` → unchanged (60s). |
| `minSources` updated to 3 | ✅ PASS | Directly verified via `oracle.minSources`. |
| numSources=2 rejected | ✅ PASS | `2 < 3` → `OracleInsufficientSources`. Sources check is early in handler (before EMA/banding). |
| numSources=3 accepted | ✅ PASS | Post-unfreeze price=100,000 with 3 sources. Banding ref = pre_freeze_price = 100,000. deviation=0. All checks pass. |
| Error matching | ✅ PASS | Checks `InsufficientSources`, `OracleInsufficientSources`, `insufficient`, `sources`. |

**Note:** Test verifies `minSources` and `maxStalenessSeconds` directly but cannot directly verify `circuitBreakerDeviationBps` was updated to 2000 — this field lives in `_reserved` and `PerkOracleAccount` doesn't expose it. The behavioral test (that CB still works) is implicit. Consider adding a `circuitBreakerDeviationBps` getter to the SDK `PerkOracleAccount` type in a future pass.

### Test 6: Per-Update Banding Rejects Single Large Move

| Check | Status | Notes |
|---|---|---|
| Setup correct | ✅ PASS | banding=500 (5%), CB=0. Isolates per-update banding. |
| 110,000 (+10%) rejected | ✅ PASS | change_bps = 10,000/100,000 × 10,000 = 1,000 > 500. `OraclePriceInvalid`. |
| 104,000 (+4%) accepted | ✅ PASS | change_bps = 4,000/100,000 × 10,000 = 400 ≤ 500. |

---

## Cross-Cutting Checks

| Check | Status | Notes |
|---|---|---|
| Protocol init handled | ✅ PASS | try/catch on "already in use" — matches pattern from `e2e-oracle.test.ts`. |
| Fresh mints per test | ✅ PASS | `createFreshMint()` called for each of 6 tests. No cross-contamination. |
| Admin funded | ✅ PASS | Implicitly — admin is payer for `createMint`. Test would fail early if underfunded. |
| Cranker funded | ✅ PASS | Explicit check + fund if < 0.05 SOL. |
| Sleep durations | ✅ PASS | 2000ms standard delay. 1000ms after mint creation. Sufficient for devnet confirmation. |
| Rate limiting (1 update/slot) | ✅ PASS | 2000ms between updates ≈ 5 devnet slots. No risk of `OracleUpdateTooFrequent`. |
| Error matching resilient | ✅ PASS | Multiple string checks per error (e.g., both `OracleCircuitBreakerTripped` and `CircuitBreaker`). Handles Anchor's verbose error format. |
| Test isolation | ✅ PASS | Each test has its own mint → own PerkOracle PDA. Independent state. |
| Pattern consistency with e2e-oracle.test.ts | ✅ PASS | Same helper patterns (`loadKeypair`, `sleep`, `makeClient`), same wallet loading, same error handling style. |

---

## Bugs Found

**None.**

---

## Observations & Recommendations

### Minor (Non-Blocking)

1. **`PerkOracleAccount` doesn't expose `_reserved` fields.** The SDK type doesn't have `maxPriceChangeBps`, `circuitBreakerDeviationBps`, `windowRefPrice`, or `preFreezePrice` as readable properties. Test 5 can verify `minSources` directly but must rely on behavioral testing for banding/CB config changes. **Recommendation:** Add computed getters or extend the type to expose these fields (deserializing from `_reserved` bytes).

2. **Test 3 walk prices are hardcoded, not computed.** The values `105_000, 110_250, 115_762, 121_550` are pre-calculated +5% steps. If the banding limit changed, these would need manual recalculation. Low risk since the test structure is resilient (loop + break on error), but a comment explaining the derivation would help maintainability.

3. **Test summary counters.** Using `testsPassed`/`testsFailed` globals with try/catch is pragmatic for a script-style test, but consider migrating to a proper test framework (Mocha/Jest) if the suite grows. The existing `e2e-oracle.test.ts` also uses this pattern, so it's consistent.

4. **Devnet rate limits.** The test creates 7+ mints and runs dozens of transactions sequentially. On a congested devnet day, 429s or dropped transactions could cause flaky failures. The 2000ms delays help, but a retry wrapper (like the existing tests use) would improve reliability.

---

## Conclusion

The SDK changes and E2E security tests are **correct, well-structured, and ready to ship**. Type mappings between TS and Rust are accurate, Anchor serialization conventions are followed properly, test math checks out against on-chain logic, and error variants match. Each test isolates the feature it's testing and uses fresh state. No bugs, no logic errors, no type mismatches.
