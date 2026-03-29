# 🔴 Red Team Audit: Batch Price Feed Refactor

**Date:** 2025-03-25  
**Auditor:** Kai (subagent)  
**Scope:** `cranker/feeds.ts` (batch functions), `cranker/loops/oracle.ts` (integration)  
**Verdict:** **PASS with 3 findings (1 medium, 2 low)**

---

## Attack Vector Results

### 1. URL Injection — ⚠️ MEDIUM

**Attack:** A malicious mint address containing `,` or `&` could inject extra mints or URL parameters into the batch URL.

**Example:** If `mint = "abc,EVIL_MINT"` exists in the market list, the URL becomes:
```
https://api.jup.ag/price/v2?ids=LEGIT_MINT,abc,EVIL_MINT
```
This injects `EVIL_MINT` into the query, potentially fetching an attacker-controlled price.

**Code path:**
```ts
// feeds.ts — fetchJupiterBatch
const url = `https://api.jup.ag/price/v2?ids=${batch.join(",")}`;

// feeds.ts — fetchBirdeyeBatch  
const url = `https://public-api.birdeye.so/defi/multi_price?list_address=${batch.join(",")}`;
```

No `encodeURIComponent()` is applied. While Solana base58 addresses can't contain commas in practice (they come from `tokenMint.toBase58()` in `oracle.ts`), the `feeds.ts` API accepts raw `string[]` — any caller could pass unsanitized input.

**Actual risk:** LOW in current deployment (mints come from on-chain `MarketAccount.tokenMint.toBase58()` which is always valid base58). But the API surface is unprotected.

**Recommendation:** Validate mints match base58 regex (`/^[1-9A-HJ-NP-Za-km-z]{32,44}$/`) at the batch entry point, or `encodeURIComponent()` each mint. Defense in depth.

---

### 2. Partial Failure with minSources=2 — ✅ PASS

**Attack:** Jupiter returns 80/100 mints, Birdeye returns 60/100. What happens to the 20 mints that have only 1 source?

**Result:** Correctly handled. In `fetchPricesBatch`:
```ts
for (const mint of mints) {
  const sources: PriceSource[] = [];
  const jup = jupiterPrices.get(mint);
  if (jup) sources.push(jup);
  const bird = birdeyePrices.get(mint);
  if (bird) sources.push(bird);
  try {
    const { ... } = aggregateSources(sources, minSources, ...);
    // ...
  } catch (err) {
    log.warn("Batch price aggregation failed", { mint, error: String(err) });
  }
}
```

`aggregateSources` throws `"Need at least 2 price sources, only got 1"` → caught → that mint is omitted from the result map → `oracle.ts` logs `"No price available for mint"` and `continue`s. **Correct behavior.**

---

### 3. Chunking Off-by-One — ✅ PASS

**Attack:** 101 mints → should produce chunks of [100, 1].

```ts
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
```

- `i=0`: `slice(0, 100)` → 100 items ✅  
- `i=100`: `slice(100, 200)` → 1 item (slice clamps to array length) ✅  
- `i=200`: loop exits (`200 < 101` is false) ✅  
- Edge: `arr.length = 0` → loop never enters → returns `[]` ✅  
- Edge: `arr.length = 100` → single chunk of 100 ✅  
- Edge: `arr.length = 1` → single chunk of 1 ✅  

**No off-by-one.**

---

### 4. Empty Batch — ✅ PASS

**Attack:** What if `mints` is empty?

Both `fetchJupiterBatch` and `fetchBirdeyeBatch` have early returns:
```ts
if (mints.length === 0) return result;
```

And `fetchPricesBatch` also:
```ts
if (mints.length === 0) return result;
```

**No API call made. Returns empty Map.**

---

### 5. Response Key Mismatch — ⚠️ LOW

**Attack:** What if Birdeye or Jupiter returns keys in different case/format than the mint addresses we sent?

**Code path (both batch functions):**
```ts
for (const mint of batch) {
  const entry = json.data[mint];  // exact key lookup
  if (!entry || ...) continue;
}
```

Both functions iterate over `batch` (the mints we sent) and look up `json.data[mint]` by exact string match. They do NOT iterate over the response keys. This means:

- If API returns `data["ABC"]` but we sent `"Abc"` → miss → price omitted → safe (fails closed)
- No risk of processing unexpected keys from the response

**Risk:** If an API changes key format, we silently get no prices (good — fails safe). But we won't know *why* — it'll look like the API returned no data. Already mitigated by the existing `"No price available for mint"` warning in `oracle.ts`.

**No action needed**, but could add a debug log comparing `batch.length` vs `result.size` per chunk.

---

### 6. Timeout on Large Batch — ⚠️ LOW

**Attack:** 100 mints in one request may be slower than single-mint requests. The 5s `FETCH_TIMEOUT_MS` still applies.

**Analysis:**
- Both batch functions use `fetchWithTimeout` with the same 5s timeout
- If a 100-mint request times out, the entire chunk fails (vs. only 1 mint failing in the old per-mint approach)
- The blast radius is larger: 1 timeout = 100 mints get no price from that source

**Mitigating factors:**
- Jupiter's `/price/v2` already supports bulk queries natively — it's not slower per the API design
- Birdeye's `/defi/multi_price` is designed for batch — similar story
- If one chunk times out, other chunks still succeed (sequential chunk processing with `continue` on error)
- If one *source* times out, the other source still provides data (parallel `Promise.all`)

**Recommendation:** Consider increasing `FETCH_TIMEOUT_MS` to 10s for batch requests, or making it configurable. A 429 or slow response on one batch call now affects up to 100 mints instead of 1.

---

### 7. Memory / lastPrices Map — ✅ PASS

**Attack:** Does `lastPrices` grow unbounded?

`lastPrices` is a module-level `Map<string, ...>`. It grows by 1 entry per unique mint ever seen. In practice:
- Perk Protocol has a finite set of markets (tens, not thousands)
- Map entries are tiny (~100 bytes each)
- Even 10,000 mints = ~1MB — negligible

**Not a real concern.** But worth noting: if markets are delisted, their entries persist forever. Could add periodic cleanup, but not worth the complexity.

---

### 8. Race Condition — ✅ PASS (no regression)

**Attack:** `fetchPricesBatch` is called once at the top of `tick()`, then we loop over markets. If markets change mid-loop?

**Analysis:** The market list is captured at the top of `tick()`:
```ts
const perkOracleMarkets = markets.filter(...);
```

This is a snapshot. `markets` is the original array passed to `startOracleLoop` — it's the same reference throughout. The `uniqueMints` map is derived from this snapshot.

Same behavior as before the batch refactor. The batch approach doesn't make this worse — the price map is already fetched before the loop. **No regression.**

---

### 9. API Rate Limit Blast Radius — ✅ PASS (acceptable tradeoff)

**Attack:** Before: 429 on one Jupiter call = 1 mint fails. Now: 429 on batch call = up to 100 mints fail.

**Analysis:**
- **Before:** N mints × 2 sources = 2N API calls per tick
- **After:** ceil(N/100) × 2 sources = ~2 API calls per tick for <100 mints

The tradeoff is correct:
- Far less likely to *trigger* rate limiting (2 calls vs 200)
- If rate limited, the retry happens next tick (~30s later based on `oracleIntervalMs`)
- The `consecutiveFailures` counter in `oracle.ts` only increments if `fetchPricesBatch` itself throws (total failure), not per-mint failures

**One note:** The `try/catch` around `fetchPricesBatch` in `oracle.ts` catches if the function *throws*. But `fetchPricesBatch` is designed to never throw — it catches all per-chunk and per-mint errors internally and returns a partial map. The only way it throws is if `Promise.all` rejects, which can't happen since both inner calls catch their own errors.

**This means `state.consecutiveFailures` in the batch catch block in `oracle.ts` will never increment.** It's dead code. Not a bug — just unreachable. The original per-mint fallback (`fetchPrice`) could throw, but `fetchPricesBatch` swallows all errors.

---

## Summary

| # | Vector | Severity | Status |
|---|--------|----------|--------|
| 1 | URL injection | **MEDIUM** | Needs input validation |
| 2 | Partial failure | — | ✅ Correct |
| 3 | Chunking off-by-one | — | ✅ Correct |
| 4 | Empty batch | — | ✅ Correct |
| 5 | Response key mismatch | **LOW** | Fails safe, could improve logging |
| 6 | Timeout blast radius | **LOW** | Acceptable, consider longer timeout |
| 7 | Memory growth | — | ✅ Negligible |
| 8 | Race condition | — | ✅ No regression |
| 9 | Rate limit blast radius | — | ✅ Net improvement |

## Bonus Finding: Dead Error Handler

The `try/catch` around `fetchPricesBatch` in `oracle.ts` (lines ~50-59) is unreachable — `fetchPricesBatch` never throws. It catches all errors internally and returns a partial `Map`. The `consecutiveFailures++` in that catch block will never execute.

**Recommendation:** Either:
1. Remove the try/catch (it's dead code), or
2. Have `fetchPricesBatch` throw if *all* sources fail for *all* mints (total blackout)

Option 2 is better — you want the 60s pause to trigger if pricing is completely dead.

## Actionable Items

1. **[MEDIUM]** Add base58 validation to `fetchPricesBatch` input:
   ```ts
   const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
   for (const m of mints) {
     if (!BASE58_RE.test(m)) throw new Error(`Invalid mint address: ${m}`);
   }
   ```

2. **[LOW]** Consider bumping `FETCH_TIMEOUT_MS` to 8-10s for batch calls, or make it a separate constant.

3. **[LOW]** Fix the dead error handler in `oracle.ts` — have `fetchPricesBatch` throw on total blackout (0 prices returned for any mint).
