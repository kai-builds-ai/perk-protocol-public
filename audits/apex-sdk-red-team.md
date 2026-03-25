# Apex Red Team — SDK & E2E Tests

Date: 2026-03-25

Auditor: Apex Red Team (adversarial review)
Scope: SDK (`client.ts`, `types.ts`, `constants.ts`), E2E security tests (`e2e-security.test.ts`), on-chain oracle instructions (`update_perk_oracle.rs`, `update_oracle_config.rs`, `initialize_perk_oracle.rs`, `freeze_perk_oracle.rs`, `constants.rs`, `engine/oracle.rs`)

---

## Executive Summary

The oracle security system is well-architected with defense-in-depth (per-update banding, sliding window, circuit breaker, freeze/unfreeze anchoring). Prior audit fixes (H-01, C-01, M-01, M-02, ATK-01, ATK-05, ATK-06) are correctly implemented. However, we identified **3 high**, **4 medium**, and **5 low** severity findings across the SDK, tests, and on-chain code.

The most critical issues: (1) the SDK performs **zero client-side validation** on oracle parameters, relying entirely on on-chain checks that may silently truncate JS numbers; (2) the E2E tests have **false-positive risk** from overly broad error matching; (3) an admin can **legally disable all oracle protection** via `updateOracleConfig`.

---

## [ATK-01] SDK Integer Overflow — JS `number` to Borsh `u16` Silent Truncation

**Target:** SDK
**Severity:** HIGH
**Feasibility:** HIGH — any SDK consumer can trigger this

**Description:**
The SDK types `InitPerkOracleParams` and `UpdateOracleConfigParams` define fields like `circuitBreakerDeviationBps` and `maxPriceChangeBps` as TypeScript `number`. JavaScript `number` supports values up to 2^53, but the on-chain types are `u16` (max 65535). Anchor's Borsh serializer in JavaScript may silently truncate values exceeding u16 range via bitwise masking (e.g., `70000 & 0xFFFF = 4464`).

The SDK has **no client-side validation** for any oracle parameter — contrast with `openPosition()` which validates leverage and slippage ranges before serialization. This asymmetry means:
- `circuitBreakerDeviationBps: 70000` → could serialize as `4464` (within valid range, bypasses on-chain MIN check)
- `circuitBreakerDeviationBps: 65536` → could serialize as `0` (disabled!)
- Negative numbers: `-1` in two's complement u16 → `65535`

**Attack Steps:**
1. Attacker builds SDK call: `initializePerkOracle(mint, authority, { ..., circuitBreakerDeviationBps: 65536 })`
2. Borsh serializes `65536` as u16 → `0` (circuit breaker disabled)
3. On-chain validation sees `0` → valid (disabled is allowed)
4. Oracle created with no circuit breaker despite caller intending 65536 bps

**Recommendation:**
Add client-side validation to `initializePerkOracle()` and `updateOracleConfig()` matching the on-chain bounds, similar to what `openPosition()` already does:
```typescript
if (params.circuitBreakerDeviationBps !== 0) {
  if (params.circuitBreakerDeviationBps < MIN_CIRCUIT_BREAKER_BPS || 
      params.circuitBreakerDeviationBps > MAX_CIRCUIT_BREAKER_BPS) {
    throw new Error(`circuitBreakerDeviationBps must be 0 or [${MIN_CIRCUIT_BREAKER_BPS}, ${MAX_CIRCUIT_BREAKER_BPS}]`);
  }
}
// Also validate integer + non-negative
```
Mirror all on-chain bound constants and check them client-side.

---

## [ATK-02] Admin Can Legally Disable All Oracle Protection

**Target:** On-chain via SDK
**Severity:** HIGH
**Feasibility:** HIGH — requires admin key (single signer)

**Description:**
An admin (or compromised admin key) can completely disable all oracle price protection through a legitimate SDK call sequence:

1. `freezePerkOracle(mint, true)` — freeze oracle
2. `updateOracleConfig(mint, { maxPriceChangeBps: 0, circuitBreakerDeviationBps: 0, minSources: 1, maxStalenessSeconds: null })` — disable banding AND circuit breaker
3. `freezePerkOracle(mint, false)` — unfreeze

After this sequence, the oracle has:
- No per-update price banding (`maxPriceChangeBps = 0`)
- No sliding window banding (derived from maxPriceChangeBps)
- No circuit breaker (`circuitBreakerDeviationBps = 0`)
- Only `minSources >= 1` check remains

A compromised cranker can then post **any price** in a single update. This is the "kill switch" attack.

**Attack Steps:**
```typescript
await adminClient.freezePerkOracle(mint, true);
await adminClient.updateOracleConfig(mint, {
  maxPriceChangeBps: 0,
  circuitBreakerDeviationBps: 0,
  minSources: null,
  maxStalenessSeconds: null,
});
await adminClient.freezePerkOracle(mint, false);
// Now cranker can post anything
await crankerClient.updatePerkOracle(mint, {
  price: new BN(1), // crash price to 0.000001
  confidence: new BN(0),
  numSources: 3,
});
```

**Recommendation:**
Consider adding a "minimum protection floor" that can never be disabled — e.g., if an oracle was initialized with banding, it can't be reduced below some floor (say 100 bps). Alternatively, require a timelock or multi-sig for protection-reducing config changes. At minimum, emit a prominent event/log when protection is disabled so monitoring can alert.

---

## [ATK-03] E2E Test False Positive Risk — Overly Broad Error Matching

**Target:** Tests
**Severity:** HIGH (test confidence)
**Feasibility:** HIGH — already present in test code

**Description:**
The E2E tests match errors using broad `string.includes()` checks that could match the wrong error, causing tests to pass for the wrong reason:

**Test 1** (Circuit Breaker):
```typescript
err.message.includes("OracleCircuitBreakerTripped") ||
err.message.includes("CircuitBreaker") ||
err.message.includes("circuit")
```
If the transaction fails with `OracleUpdateTooFrequent` (rate limit — same slot), the test falls through to the `else` branch which prints `⚠️ Got error (may be circuit breaker)` — but **does not fail the test**. The test only fails if the update *succeeds*. So a rate limit error is silently accepted as a pass.

**Test 3** (Sliding Window):
```typescript
err.message.includes("OraclePriceInvalid") ||
err.message.includes("PriceInvalid") ||
err.message.includes("price")
```
The string `"price"` matches nearly any oracle error. If per-update banding rejects first (before sliding window is even checked), the test passes but didn't actually test the sliding window.

**Test 5** (Config Update):
```typescript
err.message.includes("InsufficientSources") ||
err.message.includes("OracleInsufficientSources") ||
err.message.includes("insufficient") ||
err.message.includes("sources")
```
The string `"sources"` would match any error message that happens to contain "sources" — including unrelated Solana errors.

**Attack Steps:**
1. Run tests on a slow devnet where slot hasn't advanced between calls
2. Test 1 fails with `OracleUpdateTooFrequent` instead of `OracleCircuitBreakerTripped`
3. Test "passes" via the `⚠️` branch, giving false confidence

**Recommendation:**
1. Match **exact** Anchor error codes (numeric), not string fragments
2. Make the `⚠️` branches fail the test or at minimum flag as inconclusive
3. Add explicit `expect(err.message).toContain("OracleCircuitBreakerTripped")` with no fallback
4. Use Anchor's error code parsing: `err.error?.errorCode?.code === "OracleCircuitBreakerTripped"`

---

## [ATK-04] Confidence Value Poisoning — Write/Read Validation Gap

**Target:** On-chain via SDK
**Severity:** MEDIUM
**Feasibility:** HIGH — any authorized cranker

**Description:**
`update_perk_oracle` does **not validate the confidence value** at write time. It accepts any `u64` for `confidence`. However, `read_perk_oracle_price` (in `oracle.rs`) validates that `confidence <= price * ORACLE_CONFIDENCE_BPS / BPS_DENOMINATOR` (2% of price).

This means a cranker can write a high confidence value (e.g., `confidence = price`) that makes the oracle **unusable** — any instruction that reads the oracle (trading, liquidation, funding) will fail with `OracleConfidenceTooWide`.

This is a denial-of-service vector: a rogue cranker can brick all market operations for the duration of one update cycle (until they post a valid update, or admin freezes/transfers authority).

**Attack Steps:**
```typescript
await crankerClient.updatePerkOracle(mint, {
  price: new BN(100_000),
  confidence: new BN(100_000), // 100% of price, way over 2% limit
  numSources: 3,
});
// Oracle now has valid price but unusable confidence
// All market ops fail with OracleConfidenceTooWide
```

**Recommendation:**
Validate confidence in `update_perk_oracle` at write time:
```rust
let max_conf = params.price
    .checked_mul(ORACLE_CONFIDENCE_BPS as u64)
    .ok_or(PerkError::MathOverflow)?
    / BPS_DENOMINATOR;
require!(params.confidence <= max_conf, PerkError::OracleConfidenceTooWide);
```

---

## [ATK-05] Undefined vs Null Serialization Ambiguity in Option Fields

**Target:** SDK
**Severity:** MEDIUM
**Feasibility:** MEDIUM — depends on SDK consumer patterns

**Description:**
`UpdateOracleConfigParams` defines fields as `number | null`. In TypeScript, `undefined` and `null` are different values. Anchor's Borsh serializer for `Option<T>` should serialize `null` as `None`, but behavior for `undefined` is **implementation-dependent** — it may serialize as `None`, throw an error, or serialize as `Some(0)`.

The SDK passes params directly to Anchor methods without normalizing `undefined` to `null`:
```typescript
.updateOracleConfig({
  maxPriceChangeBps: params.maxPriceChangeBps,  // could be undefined
  minSources: params.minSources,
  ...
})
```

If a consumer creates a partial object:
```typescript
const params: UpdateOracleConfigParams = { circuitBreakerDeviationBps: 2000 };
// maxPriceChangeBps is undefined, not null
```

TypeScript won't catch this (it's structurally valid if the type isn't strict). The Borsh serializer behavior is the unknown.

**Attack Steps:**
1. SDK consumer creates config with some fields as `undefined` (common JS pattern)
2. Borsh serializer interprets `undefined` as `Some(0)` for a u16 field
3. `maxPriceChangeBps` gets set to `0`, disabling banding

**Recommendation:**
Normalize all Option fields in the SDK before serialization:
```typescript
async updateOracleConfig(tokenMint: PublicKey, params: UpdateOracleConfigParams) {
  return this.program.methods.updateOracleConfig({
    maxPriceChangeBps: params.maxPriceChangeBps ?? null,
    minSources: params.minSources ?? null,
    maxStalenessSeconds: params.maxStalenessSeconds ?? null,
    circuitBreakerDeviationBps: params.circuitBreakerDeviationBps ?? null,
  })
  ...
```

---

## [ATK-06] Oracle Liveness Deadlock Under Volatile Markets

**Target:** On-chain via SDK
**Severity:** MEDIUM
**Feasibility:** MEDIUM — requires volatile market conditions

**Description:**
When the real market price jumps beyond the circuit breaker threshold (e.g., 10%), every `updatePerkOracle` call is rejected. The oracle becomes stuck at the old price. As time passes, it becomes stale (`age > max_staleness_seconds`), causing `read_perk_oracle_price` to fail with `OracleStale`. This bricks all market operations (trading, liquidation, funding).

The recovery path is: admin freezes → updates config → unfreezes. But:
1. This requires manual admin intervention (no automated path)
2. During the stale period, **liquidations are blocked** — underwater positions can't be liquidated, potentially causing bad debt
3. After unfreeze, the first update is banded against pre-freeze price, so if the market moved 50%, the cranker still can't post the real price without multiple stepped updates

If circuit breaker is 500 bps (5% — the minimum) and the market dumps 80%, recovery requires: freeze, widen CB to 9999, unfreeze, post real price, freeze, restore CB to 500, unfreeze. That's **6 admin transactions** while the market burns.

**Attack Steps:**
1. Real market price jumps 30% (flash crash or pump)
2. All cranker updates rejected by circuit breaker
3. Oracle goes stale after `max_staleness_seconds`
4. All market operations halt — no trading, no liquidation
5. Admin must manually intervene with multiple freeze/config/unfreeze cycles

**Recommendation:**
Consider an "emergency update" path where admin can post a price directly (bypassing CB/banding) during freeze. Or add an auto-widening mechanism: if N consecutive updates are rejected, temporarily widen the band. Or allow cranker to post a "capped" price (clamped to max allowed deviation) so the oracle at least moves toward the real price.

---

## [ATK-07] Test State Isolation is Incomplete — Devnet Persistence

**Target:** Tests
**Severity:** MEDIUM
**Feasibility:** MEDIUM — affects CI reliability

**Description:**
Each test creates a fresh mint for PDA isolation — this is good. However:

1. **Protocol initialization** is a singleton — if a previous test run initialized the protocol with a different admin, subsequent runs fail silently (caught by the `"already in use"` check, but if the admin key differs, admin operations would fail with `has_one` constraint violations).

2. **Cranker funding** uses a hardcoded 0.05 SOL threshold. If devnet faucet is down or admin has insufficient SOL, all tests fail with an unhelpful transfer error.

3. **No cleanup** — PerkOracle PDAs from previous runs persist on devnet. While they don't interfere (different mints), they accumulate. More importantly, if a test fails mid-way, the oracle may be left frozen, and re-running with the same mint would fail at `init` (but fresh mints prevent this — good).

4. **Devnet rate limits** — the tests make ~30+ RPC calls. Devnet throttles at ~25 req/s. The 2-second delays help but aren't guaranteed sufficient under load.

5. **No distinction between security rejection and network failure** — if a devnet transaction times out, the catch block may interpret the timeout error as a security rejection (the string `"price"` could match in a timeout URL or error trace).

**Recommendation:**
- Parse Anchor error codes, not string fragments
- Add explicit retry logic for network errors (distinguish `SendTransactionError` from `AnchorError`)
- Consider using a local validator (`solana-test-validator`) for deterministic tests
- Add timeout/network error detection before checking security error codes

---

## [ATK-08] Missing E2E Test: Unauthorized Cranker Access Control

**Target:** Tests (missing coverage)
**Severity:** LOW
**Feasibility:** N/A — gap in test coverage

**Description:**
No test verifies that an unauthorized signer (not the oracle authority) is rejected when calling `updatePerkOracle`. The `has_one = authority` constraint on the `UpdatePerkOracle` accounts struct should enforce this, but it's never tested.

This is the most fundamental security property of the oracle and it has zero test coverage.

**Recommendation:**
Add test:
```typescript
// Create oracle with cranker as authority
await adminClient.initializePerkOracle(mint, cranker.publicKey, params);
// Try updating as admin (not the authority) — should fail
try {
  await adminClient.updatePerkOracle(mint, { price: new BN(50000), ... });
  throw new Error("Should have failed!");
} catch (err) {
  expect(err.error.errorCode.code).toBe("ConstraintHasOne");
}
```

---

## [ATK-09] Missing E2E Test: Update Frozen Oracle

**Target:** Tests (missing coverage)
**Severity:** LOW
**Feasibility:** N/A — gap in test coverage

**Description:**
No test verifies that `updatePerkOracle` rejects updates when the oracle is frozen. The on-chain code checks `require!(!oracle.is_frozen, PerkError::OracleFrozen)`, but this is never tested end-to-end.

Test 4 freezes/unfreezes but only tests post-unfreeze behavior, not the frozen-state rejection.

**Recommendation:**
After freezing in Test 4, add an update attempt that should fail with `OracleFrozen`.

---

## [ATK-10] Missing E2E Test: Circuit Breaker Exact Boundary

**Target:** Tests (missing coverage)
**Severity:** LOW
**Feasibility:** N/A — gap in test coverage

**Description:**
No test verifies behavior at the exact circuit breaker boundary. The on-chain code uses `<=`:
```rust
require!(deviation_bps <= cb_bps as u64, PerkError::OracleCircuitBreakerTripped);
```

So a price exactly at the CB threshold (e.g., +10.00% with CB=1000bps) should **pass**. This boundary behavior is untested. An off-by-one error would only be caught by an exact-boundary test.

**Recommendation:**
Add test with CB=1000bps, base price 100000:
- Price 110000 (exactly +10%) → should PASS (<=)
- Price 110001 (just over +10%) → should FAIL

---

## [ATK-11] Missing E2E Test: Config Update on Non-Frozen Oracle

**Target:** Tests (missing coverage)
**Severity:** LOW
**Feasibility:** N/A — gap in test coverage

**Description:**
The M-02 fix requires `oracle.is_frozen == true` before config changes:
```rust
require!(ctx.accounts.perk_oracle.is_frozen, PerkError::OracleNotFrozen);
```

No test verifies this. Test 5 does freeze before updating config, but it never tests that updating config on a live (unfrozen) oracle is rejected.

**Recommendation:**
Add test attempting `updateOracleConfig` without freezing first — should fail with `OracleNotFrozen`.

---

## [ATK-12] Per-Update Banding Uses Current Price as Reference — Drift Accumulation

**Target:** On-chain via SDK
**Severity:** LOW (by design, but worth documenting)
**Feasibility:** HIGH

**Description:**
Per-update banding compares the new price against `oracle.price` (the current stored price). After each successful update, the stored price advances. This means a cranker can walk the price indefinitely in one direction by staying within the per-update band:

```
T=0: price=100000 (base)
T=1: price=104999 (+4.999%, within 5% band) ← reference becomes 104999
T=2: price=110248 (+4.999% from 104999) ← reference becomes 110248
T=3: price=115759 (+4.999% from 110248)
...
```

The **sliding window** catches this within a 50-slot window (3x band = 15% max cumulative). But once the window expires (~20 seconds), a new window starts from the current price. So the cranker can:

1. Walk +14.99% in 20 seconds (3 updates within window)
2. Wait 20 seconds for window to expire
3. Walk another +14.99%
4. Repeat: ~45% drift per minute

The circuit breaker (EMA-based) provides additional protection, but EMA tracks the manipulated price with a lag factor of 10, so it drifts too.

**With both banding (5%) and CB (10%) enabled:** the effective manipulation rate is bounded by the tighter of the two constraints. The CB against EMA provides the real long-term cap. After several updates, the EMA catches up and the CB prevents further deviation. Effective max sustained drift: ~5-8% per minute depending on update frequency.

**Recommendation:**
This is largely working as designed — the combined banding + CB + sliding window provides good protection. Document the expected maximum manipulation rate so operators can set parameters appropriately. Consider adding a "max cumulative change per hour" parameter for high-value oracles.

---

## Solid Design Decisions (What's Working)

1. **Fresh mint per test** — eliminates PDA collision between tests. Well done.
2. **M-02 freeze requirement for config changes** — prevents silent live config manipulation.
3. **Unfreeze anchoring (H-01, C-01, ATK-01, ATK-06)** — comprehensive: price zeroed, EMA preserved, window reset, pre-freeze price stored for banding, one-shot gap bypass. This is thorough.
4. **`has_one = authority` on UpdatePerkOracle** — Anchor's constraint system cleanly enforces cranker authorization.
5. **PDA seeds include `token_mint`** — prevents cross-mint oracle confusion.
6. **EMA capping to MAX_ORACLE_PRICE (M-01)** — prevents saturating arithmetic from corrupting EMA.
7. **Rate limit (one update per slot)** — prevents flash manipulation within a single block.
8. **Gap attack detection** — staleness > 2x max_staleness requires freeze/unfreeze cycle.
9. **`init` constraint on PDA** — Anchor prevents double-initialization by design.
10. **Pre-freeze price stored on unfreeze** — banding reference survives the price=0 reset.

---

## Summary Table

| ID | Target | Severity | Finding |
|----|--------|----------|---------|
| ATK-01 | SDK | HIGH | JS number → u16 silent truncation, no client validation |
| ATK-02 | On-chain | HIGH | Admin can disable all oracle protection legally |
| ATK-03 | Tests | HIGH | False positive risk from broad error string matching |
| ATK-04 | On-chain | MEDIUM | Confidence not validated at write time (DoS vector) |
| ATK-05 | SDK | MEDIUM | undefined vs null serialization ambiguity |
| ATK-06 | On-chain | MEDIUM | Oracle liveness deadlock under volatile markets |
| ATK-07 | Tests | MEDIUM | Devnet unreliability + no network vs security error distinction |
| ATK-08 | Tests | LOW | Missing: unauthorized cranker test |
| ATK-09 | Tests | LOW | Missing: frozen oracle update rejection test |
| ATK-10 | Tests | LOW | Missing: exact CB boundary test |
| ATK-11 | Tests | LOW | Missing: config update on unfrozen oracle test |
| ATK-12 | On-chain | LOW | Cumulative price drift via repeated small moves (by design) |

**Critical action items:** ATK-01 (add SDK validation), ATK-03 (fix test error matching), ATK-04 (validate confidence at write).
