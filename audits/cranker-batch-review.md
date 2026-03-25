# Cranker Batch Price Feed Refactor — Code Review

**Reviewer:** Kai (automated sub-agent)  
**Date:** 2026-03-25  
**Files reviewed:**
- `cranker/feeds.ts`
- `cranker/loops/oracle.ts`
- `cranker/config.ts`

**Verdict: ✅ PASS — clean implementation with 3 minor findings (0 blockers)**

---

## 1. Jupiter Batch (`fetchJupiterBatch`)

| Check | Status | Notes |
|---|---|---|
| URL format `?ids=mint1,mint2,...` | ✅ | `batch.join(",")` — correct |
| `x-api-key` header when apiKey provided | ✅ | Conditional set, matches single-token fn |
| Response type `data[mint].price` is string → `parseFloat` | ✅ | Parsed and validated (`isFinite`, `> 0`) |
| Handles null/missing per mint | ✅ | `if (!entry \|\| !entry.price) continue` |
| Chunks at 100 | ✅ | `BATCH_CHUNK_SIZE = 100` |
| Chunk processing sequential (not parallel) | ⚠️ **MINOR** | Chunks are awaited serially in a `for` loop. Fine for ≤2 chunks but could `Promise.all` the chunks for throughput. Not a bug — a perf note. |
| Timeout per chunk | ✅ | Uses `fetchWithTimeout` (5s) per chunk request |

## 2. Birdeye Batch (`fetchBirdeyeBatch`)

| Check | Status | Notes |
|---|---|---|
| URL `multi_price?list_address=mint1,mint2,...` | ✅ | Correct endpoint |
| `X-API-KEY` header | ✅ | Present |
| `x-chain: solana` header | ✅ | Present (not in single-token fn — see §5) |
| Response `data[mint].value` is number | ✅ | Parsed as number, validated |
| `success` field checked | ✅ | `if (!json.success \|\| !json.data)` |
| Handles missing mints | ✅ | `if (!entry \|\| entry.value == null) continue` — uses `== null` to catch both null and undefined |
| Chunks at 100 | ✅ | Same `BATCH_CHUNK_SIZE` |

## 3. Batch Aggregation (`fetchPricesBatch`)

| Check | Status | Notes |
|---|---|---|
| Jupiter + Birdeye in parallel (`Promise.all`) | ✅ | Both fetched concurrently |
| Birdeye skipped when no API key | ✅ | Falls back to empty Map |
| Per-mint: collects sources, calls `aggregateSources` | ✅ | Clean loop over `mints` |
| Failed mints logged and omitted | ✅ | `catch` block logs warning, mint not added to result |
| Frozen API detection | ✅ | Same `lastPrices` logic as single-token path |
| `safeScalePrice` applied | ✅ | Called on `finalPriceUsd` |
| Confidence scaled | ✅ | `Math.round(confidenceUsd * PRICE_SCALE)` |
| Empty mints array → early return | ✅ | Returns empty Map immediately |

## 4. Oracle Loop Integration (`oracle.ts`)

| Check | Status | Notes |
|---|---|---|
| Collects unique mints | ✅ | `uniqueMints` Map deduplicates |
| Single `fetchPricesBatch` call | ✅ | One call for all mints |
| Iterates results per mint | ✅ | `for (const [mintStr, tokenMint] of uniqueMints)` |
| Missing price → `continue` (not crash) | ✅ | `if (!aggregated) { log.warn... continue }` |
| Rate limiter checked per TX | ✅ | `limiter.canSend()` before each `updatePerkOracle` |
| Rate limiter TOCTOU: `record()` before send | ✅ | Records before await — correct |
| Circuit breaker error handled | ✅ | `OracleCircuitBreakerTripped` → warn + continue |
| Price banding error handled | ✅ | `PriceBandingExceeded` → warn + continue |
| Dry run works | ✅ | Logs and `continue` — never calls `updatePerkOracle` |
| Consecutive failure tracking | ✅ | Counter resets on success, 60s pause at >10 |
| **Batch-level failure** | ✅ | Outer `try/catch` around `fetchPricesBatch` — increments failures and returns |

### ⚠️ MINOR Finding: Consecutive failure counter shared across batch + per-tx errors

The `consecutiveFailures` counter is incremented both when the entire batch fetch fails (outer catch) and when individual `updatePerkOracle` TXs fail (inner catch). A single batch with 3 TX failures would count as 3 consecutive failures. This matches the old per-token behavior so it's not a regression, but worth noting — a batch of 10 mints where all TX submissions fail would hit the 60s pause quickly.

**Recommendation:** Consider separating batch-fetch failures from TX-submission failures, or resetting on any successful TX (which it already does: `state.consecutiveFailures = 0` on success).

## 5. Backward Compatibility

| Check | Status | Notes |
|---|---|---|
| `fetchPrice()` still exists | ✅ | Unchanged single-token function at bottom of file |
| `fetchPrice()` still works independently | ✅ | Uses its own `fetchJupiterPrice` / `fetchBirdeyePrice` — no shared state issues |
| Exports | ✅ | `fetchPricesBatch`, `fetchJupiterBatch`, `fetchBirdeyeBatch` all exported |

### ⚠️ MINOR Finding: Single-token `fetchBirdeyePrice` missing `x-chain` header

The single-token `fetchBirdeyePrice` function (line ~91) sends only `X-API-KEY`. The batch `fetchBirdeyeBatch` correctly sends both `X-API-KEY` and `x-chain: solana`. This is a pre-existing issue (not introduced by this refactor), but the batch version fixed it — the single-token version should match.

**Recommendation:** Add `"x-chain": "solana"` to the single-token `fetchBirdeyePrice` headers for consistency.

## 6. Edge Cases

| Scenario | Result |
|---|---|
| 0 mints | ✅ `fetchPricesBatch` returns empty Map; oracle loop returns early (`perkOracleMarkets.length === 0`) |
| 1 mint | ✅ Works — batch of 1, comma-join of single element is just the element |
| 200 mints | ✅ `chunk()` splits into 2 batches of 100, processed sequentially per source |
| One source returns 50/100 | ✅ Partial — `aggregateSources` will throw for mints with < `minSources`, caught and omitted |
| All sources fail | ✅ Outer catch in oracle loop handles, increments failure counter |
| `birdeyeApiKey` undefined | ✅ Birdeye skipped, empty Map returned — but `minSources=2` will cause all mints to fail aggregation. This is correct behavior (operator must provide both keys or lower `minPriceSources`). |

## 7. Config Threading

| Check | Status |
|---|---|
| `jupiterApiKey` in `CrankerConfig` interface | ✅ |
| `JUPITER_API_KEY` env var read in `loadConfig()` | ✅ |
| Passed to `fetchPricesBatch` in oracle loop | ✅ (`config.jupiterApiKey`) |
| `birdeyeApiKey` passed | ✅ |
| `minPriceSources` passed | ✅ |
| `maxDivergencePct` passed | ✅ |

## 8. `chunk()` Utility

Clean and correct. Handles edge cases implicitly:
- Empty array → no iterations → returns `[]`
- Array smaller than chunk size → single chunk
- Exact multiple → no leftover
- Non-multiple → last chunk is smaller (correct)

Only used internally (not exported) — fine.

---

## Summary of Findings

| # | Severity | Description | Action |
|---|---|---|---|
| 1 | **Minor/Perf** | Chunks within `fetchJupiterBatch` / `fetchBirdeyeBatch` are fetched sequentially. For >100 mints, could parallelize chunks. | Optional optimization |
| 2 | **Minor** | `consecutiveFailures` counter conflates batch-fetch errors and per-TX errors | Consider separating or documenting |
| 3 | **Minor/Pre-existing** | Single-token `fetchBirdeyePrice` missing `x-chain: solana` header (batch version has it) | Add header for consistency |

**No blockers. No security issues. No data loss risks. Ship it.**
