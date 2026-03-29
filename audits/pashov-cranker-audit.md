# PerkOracle Cranker — Security Audit

**Auditor:** Pashov-style solo review
**Date:** 2026-03-24
**Scope:** `sdk/src/oracle-cranker.ts`, on-chain `update_perk_oracle.rs`, `engine/oracle.rs`, `constants.ts`
**Commit:** HEAD (pre-mainnet)

---

## Executive Summary

The PerkOracle cranker fetches prices from Jupiter + Birdeye, computes a median with outlier rejection, and posts to on-chain `PerkOraclePrice` accounts. The on-chain validation is solid — rate limiting, staleness, gap attack prevention, confidence band checks, and fail-closed semantics. The off-chain cranker has several issues ranging from medium severity (availability DoS with 2 sources) to low/informational (missing timeouts, timestamp blindness).

**Overall:** On-chain is well-defended. Off-chain cranker needs hardening before mainnet.

| Severity | Count |
|----------|-------|
| High     | 0     |
| Medium   | 3     |
| Low      | 4     |
| Info     | 3     |

---

## Findings

### [M-01] Two-Source Deadlock — Outlier Rejection Rejects Both Sources When They Disagree >22%

**Severity:** Medium | **Likelihood:** High | **Impact:** Medium (availability)

**Location:** `oracle-cranker.ts` — `aggregatePrice()`

Raydium is stubbed (`fetchRaydiumPrices` returns empty map). With only Jupiter + Birdeye active and `minSources` defaulting to 2, the outlier rejection creates a deadlock zone.

For 2 sources `[a, b]` where `a < b`, the median is `(a+b)/2`. Both sources have identical deviation from median:

```
deviation = (b - a) / (a + b)
```

At `maxDeviationPct = 0.10` (10%), both sources are rejected when `b/a > 1.222` — i.e., a ~22% price disagreement. After rejection, `accepted.length < minSources` → no price posted.

**Impact:** During volatile markets or when one API lags, the oracle stops updating entirely. On-chain staleness kicks in and halts trading. This is technically fail-safe but creates unnecessary downtime.

**Proof of concept:**
- Jupiter returns SOL at $150.00
- Birdeye returns SOL at $185.00 (stale by 10 seconds during a pump)
- Median = $167.50, deviation = 35/335 = 10.4% — both rejected
- Oracle goes stale, all markets using this oracle halt

**Recommendation:**
1. With exactly 2 sources, skip outlier rejection (can't identify "the outlier" with only 2 data points). Use the median directly.
2. Or: fall back to the source closest to the last posted price when both are rejected.
3. Or: lower `minSources` to 1 until Raydium is implemented, but accept the single-source risk.

---

### [M-02] No Fetch Timeouts — Hung API Stalls Entire Cranker

**Severity:** Medium | **Likelihood:** Medium | **Impact:** Medium (availability)

**Location:** `oracle-cranker.ts` — `fetchJupiterPrices()`, `fetchBirdeyePrices()`

Neither `fetch()` call uses an `AbortController` or timeout. If Jupiter or Birdeye's TCP connection hangs (not a DNS failure or HTTP error — a connection that opens but never responds), the cranker blocks indefinitely.

The `tickInProgress` guard prevents overlapping ticks, so the entire cranker is frozen until the hung connection eventually times out at the OS TCP level (typically 60-120 seconds on Linux, longer on Windows).

```typescript
// Current: no timeout
const res = await fetch(url);

// Fix:
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000);
const res = await fetch(url, { signal: controller.signal });
clearTimeout(timeout);
```

**Impact:** During the hang, all token oracles stop updating. With a 15-second `max_staleness_seconds`, one 20-second API hang freezes all markets.

**Recommendation:** Add 5-second `AbortController` timeouts to all fetch calls. This keeps the total tick duration under 10 seconds even in degraded conditions.

---

### [M-03] Timestamp Blindness — Cranker Cannot Detect Stale API Responses

**Severity:** Medium | **Likelihood:** Low | **Impact:** High (price accuracy)

**Location:** `oracle-cranker.ts` — `fetchJupiterPrices()`, timestamp handling

Jupiter Price API v2 does not return a timestamp in its response. The cranker assigns `Date.now()` as the timestamp:

```typescript
const now = Math.floor(Date.now() / 1000);
// ...
results.set(key, {
  name: "jupiter",
  price,
  confidence: 0,
  timestamp: now, // ← This is the cranker's clock, NOT Jupiter's data freshness
});
```

If Jupiter's API serves a cached/stale price (CDN cache, API degradation, rate limiting with cached response), the cranker has no way to detect this. It will post the stale price with a fresh timestamp to the on-chain oracle, which trusts the cranker's claimed timestamp.

**Impact:** A degraded Jupiter API returning prices from 60 seconds ago during a crash would be posted as fresh. The on-chain staleness check only compares `clock.unix_timestamp` against the oracle's `timestamp` field — which the cranker just set to "now". This is a trust boundary violation.

**Birdeye partially mitigates this:** It uses `entry.updateUnixTime` from the API response, but falls back to `Date.now()` if missing.

**Note:** The `timestamp` field from `PriceSource` is never actually used in the aggregation logic — it's stored but not checked. The cranker should validate that Birdeye's `updateUnixTime` is within the last N seconds and reject stale API data.

**Recommendation:**
1. For Birdeye: reject prices where `updateUnixTime` is older than `max_staleness_seconds`.
2. For Jupiter: use the `v2?ids=...&showExtraInfo=true` parameter to get `lastSwappedPrice` metadata, or compare against the previous tick's price + time to detect staleness heuristically.
3. Never post a price if the newest API source timestamp is older than the on-chain oracle's current timestamp.

---

### [L-01] `Math.round(price * PRICE_SCALE)` Rounds Sub-Micro-Dollar Tokens to Zero

**Severity:** Low | **Likelihood:** Medium | **Impact:** Low (functionality)

**Location:** `oracle-cranker.ts` — tick inner loop

```typescript
const scaledPrice = Math.round(result.price * PRICE_SCALE);
```

With `PRICE_SCALE = 1_000_000`, a token priced at `$0.0000004` maps to `0.0000004 * 1_000_000 = 0.4`, which rounds to `0`. On-chain rejects `price == 0` (`PerkError::OraclePriceInvalid`), so the tx fails silently.

For tokens at `$0.000001`, the scaled price is `1` — one unit of precision, with zero sub-decimal granularity. A 50% price move from `$0.0000008` to `$0.0000012` maps to `1 → 1` (no change detected).

**Impact:** Memecoin/microcap tokens with very low dollar prices cannot be priced accurately. The spec says "any SPL token with DEX liquidity" — this constrains that promise.

**Recommendation:**
1. Add a pre-check: if `scaledPrice === 0`, log a warning and skip (already handled by on-chain, but wastes a tx + fees).
2. Document the minimum representable price ($0.0000005) in the spec.
3. Consider a per-oracle `price_scale` field for tokens that need more decimal places (breaking change).

---

### [L-02] No Client-Side `MAX_ORACLE_PRICE` Validation

**Severity:** Low | **Likelihood:** Low | **Impact:** Low (wasted fees)

**Location:** `oracle-cranker.ts` — tick inner loop

The cranker doesn't check `scaledPrice <= MAX_ORACLE_PRICE` before posting. If an API returns an absurd price (bug, data corruption), the cranker sends the tx, which on-chain rejects with `OraclePriceInvalid`. The tx fails but the cranker still pays priority fees + base fee.

```typescript
const scaledPrice = Math.round(result.price * PRICE_SCALE);
// Missing: if (scaledPrice > MAX_ORACLE_PRICE || scaledPrice <= 0) { skip; }
```

`MAX_ORACLE_PRICE = 1_000_000_000_000` (1e12) = $1,000,000 in USD. This is well within `Number.MAX_SAFE_INTEGER` (9e15), so no overflow risk here.

**Recommendation:** Add client-side bounds check to avoid wasting SOL on guaranteed-to-fail transactions.

---

### [L-03] Confidence Metric Is Absolute, Not Relative

**Severity:** Low | **Likelihood:** N/A (design) | **Impact:** Low

**Location:** `oracle-cranker.ts` — `aggregatePrice()`

```typescript
const confidence = maxPrice - minPrice;
```

Confidence is computed as the absolute spread between sources. A $0.01 spread on a $100 token (0.01%) and a $0.01 spread on a $0.10 token (10%) produce the same confidence value after scaling.

**Mitigated on-chain:** The `oracle.rs` reader validates `confidence <= price * ORACLE_CONFIDENCE_BPS / BPS_DENOMINATOR` (relative check, 2% default). So the on-chain side correctly treats confidence as relative.

**Remaining risk:** With only 2 sources that are very close, confidence ≈ 0. This passes the on-chain check but doesn't represent real uncertainty — it just means the 2 APIs agreed. With 2 agreeing sources, true uncertainty could still be high (both APIs could be wrong in the same direction, e.g., both reading from the same upstream aggregator).

**Recommendation:** Informational. The on-chain relative check is the real guardrail. Consider documenting that low confidence doesn't mean high certainty — it means low source disagreement.

---

### [L-04] `setInterval` Drift Under Load

**Severity:** Low | **Likelihood:** Medium | **Impact:** Low

**Location:** `oracle-cranker.ts` — `start()`

```typescript
this.intervalId = setInterval(() => this.tick(), interval);
```

`setInterval` fires every N ms regardless of tick duration. The `tickInProgress` guard prevents overlapping, but if a tick takes 4 seconds with a 3-second interval, the next tick fires immediately (was already queued). Under sustained API slowness:

- Tick 1: starts at T=0, finishes at T=4
- Tick 2: fires at T=3 (queued), starts at T=4, finishes at T=8
- Tick 3: fires at T=6 (queued), starts at T=8 — now 2 intervals behind

This creates bursty behavior after recovery. Not a security issue but can cause unnecessary API hammering after a period of degradation.

**Recommendation:** Replace `setInterval` with recursive `setTimeout` after tick completion:

```typescript
const scheduleNext = () => {
  this.intervalId = setTimeout(async () => {
    await this.tick();
    if (this.running) scheduleNext();
  }, interval);
};
```

---

### [I-01] Jupiter Confidence Always Zero

**Severity:** Informational

**Location:** `oracle-cranker.ts` — `fetchJupiterPrices()`

```typescript
results.set(key, {
  name: "jupiter",
  price,
  confidence: 0, // Always zero
  timestamp: now,
});
```

Jupiter API v2 doesn't return a confidence/spread value. Birdeye similarly sets `confidence: 0`. The aggregation computes confidence from source spread (max-min), so per-source confidence isn't used. But if a future source provides real confidence data, the aggregation logic would ignore it.

---

### [I-02] Raydium Stub Creates False Sense of 3-Source Security

**Severity:** Informational

**Location:** `oracle-cranker.ts` — `fetchRaydiumPrices()`

The spec describes a 3-source system (Jupiter + Birdeye + Raydium). In practice, Raydium always returns an empty map. This means:

- Security model degrades from "attacker must compromise 2 of 3" to "attacker must compromise 1 of 2"
- The outlier rejection (designed for 3+ sources) becomes pathological with 2 (see M-01)
- The `minSources` default of 2 is the theoretical maximum, not a safety margin

**Recommendation:** Either implement Raydium reads or adjust `minSources` default to 1 with appropriate documentation of the reduced security model.

---

### [I-03] No Response Size Limits on API Fetches

**Severity:** Informational

**Location:** `oracle-cranker.ts` — `fetchJupiterPrices()`, `fetchBirdeyePrices()`

The `fetch()` calls read the entire response body via `res.json()` with no size limit. A compromised CDN or MITM could serve a multi-gigabyte JSON response, causing OOM on the cranker machine.

**Recommendation:** Use streaming JSON parsing with a size cap, or at minimum check `Content-Length` header before reading the body.

---

## Positive Observations

1. **On-chain rate limit (1 per slot):** Prevents rapid-fire price manipulation even with a compromised cranker key. Attacker can only update every ~400ms.

2. **Gap attack protection:** The `max_staleness * 2` gap check prevents a stale oracle from jumping to a wildly different price. The `unfreeze_pending` flag correctly handles the admin recovery flow.

3. **EMA with checked math:** The on-chain EMA uses `checked_mul`/`checked_add`/`checked_div` throughout. No overflow paths.

4. **Fail-closed design:** Every failure mode (stale oracle, frozen oracle, insufficient sources, API down) results in halted trading, not bad trades. This is the correct design for a perp protocol.

5. **`tickInProgress` guard:** Prevents concurrent ticks, which would cause nonce/sequence issues and duplicate transactions.

6. **Parallel source fetching:** `Promise.all` with individual `.catch` handlers means one source failure doesn't block others.

7. **Authority separation:** Oracle cranker wallet can only write prices. No vault access, no admin privileges. Compromise ceiling is bounded.

---

## Comparison Against Known Oracle Exploits

| Exploit | Perk Status |
|---------|-------------|
| **Mango Markets (2022)** — attacker manipulated thin Pyth oracle to inflate position value | **Mitigated.** PerkOracle uses multi-source median. Single-source manipulation is filtered. But with only 2 sources active (M-01), security is weaker than designed. |
| **BonqDAO (2023)** — oracle update with no rate limit allowed single-tx price manipulation | **Mitigated.** On-chain rate limit of 1 update per slot. |
| **Synthetix (2019)** — stale oracle price exploited during API downtime | **Mitigated.** On-chain staleness check halts trading. Fail-closed. |
| **Venus Protocol (2021)** — price feed returned wrong price, protocol didn't validate bounds | **Partially mitigated.** On-chain has `MAX_ORACLE_PRICE` check. Cranker should also validate (L-02). |
| **Cream Finance (2021)** — flash loan oracle manipulation via thin pool | **Partially mitigated.** Jupiter aggregates across DEXes. Raydium stub (when implemented) will use TWAP. But current 2-source model is thin. |

---

## Recommendations Summary

| ID | Action | Priority |
|----|--------|----------|
| M-01 | Fix 2-source outlier rejection deadlock | **Before mainnet** |
| M-02 | Add 5s fetch timeouts with AbortController | **Before mainnet** |
| M-03 | Validate API response timestamps, reject stale data | **Before mainnet** |
| L-01 | Add pre-check for zero scaled price | Nice to have |
| L-02 | Add client-side MAX_ORACLE_PRICE check | Nice to have |
| L-03 | Document confidence semantics | Nice to have |
| L-04 | Replace setInterval with recursive setTimeout | Nice to have |
| I-02 | Implement Raydium or adjust security assumptions | Before mainnet |

---

*End of audit.*
