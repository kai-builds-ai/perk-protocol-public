# PerkOracle Cranker — Security Audit v2

**Auditor:** Pashov  
**Date:** March 24, 2026  
**Scope:** Re-audit of `oracle-cranker.ts`, `update_perk_oracle.rs`, `oracle.rs` after fixes to M-01/M-02/M-03  
**Commit:** Post-fix (v2)

---

## Previous Findings — Fix Verification

### M-01: Two-Source Deadlock ✅ FIXED

**Original:** `minSources` defaulted to 2, but Raydium was stubbed → only Jupiter + Birdeye available. If either API was down, no prices posted.

**Fix applied:** `minSources` default changed from `2` to `1`.

**Verification:**
- `oracle-cranker.ts` line: `const minSources = this.config.minSources ?? 1;` ✅
- Config interface documents rationale: *"since Raydium is stubbed, requiring 2 would deadlock when one API is down"* ✅
- `aggregatePrice()` correctly checks `valid.length < minSources` and `accepted.length < minSources` ✅

**Status:** Fix is correct and properly implemented.

---

### M-02: No Fetch Timeouts ✅ FIXED

**Original:** `fetch()` calls had no timeout. A hung API connection would freeze the entire cranker indefinitely.

**Fix applied:** `fetchWithTimeout()` helper using `AbortController` with configurable timeout (default 5000ms).

**Verification:**
- `fetchWithTimeout()` creates `AbortController`, sets `setTimeout(() => controller.abort(), opts.timeoutMs)` ✅
- `clearTimeout(timer)` in `finally` block prevents timer leak ✅
- Used in `fetchJupiterPrices()` ✅
- Used in `fetchBirdeyePrices()` ✅
- Default: `const fetchTimeout = this.config.fetchTimeoutMs ?? 5000;` ✅
- `fetchRaydiumPrices()` is a stub returning empty map — no fetch to timeout ✅

**Status:** Fix is correct and properly implemented.

---

### M-03: Timestamp Blindness ✅ PARTIALLY FIXED

**Original:** Birdeye prices were accepted regardless of age. A cached/stale Birdeye response could post an outdated price.

**Fix applied:** Birdeye source rejects prices with `updateUnixTime` older than 60 seconds.

**Verification:**
- Birdeye fetcher: `if (now - ts > 60) continue;` ✅
- Handles missing timestamp: `const ts = entry.updateUnixTime ?? now;` — falls back to `now` if field absent ✅

**Residual concern (see NEW-03):** Jupiter source still fabricates timestamps with `timestamp: now`. This was acknowledged in the original audit but remains a risk vector, especially now that `minSources=1` allows Jupiter-only updates.

**Status:** Birdeye fix is correct. Jupiter timestamp gap remains (tracked as NEW-03).

---

## New Findings

### NEW-01: Spec Drift — Security Properties Contradict Implementation

**Severity:** Informational / Governance Risk

**Location:** `PERK-ORACLE-SPEC.md` §Security Properties, §Price Aggregation Pipeline

The spec contains multiple statements that no longer match the code:

| Spec Claim | Actual Code |
|---|---|
| "No single entity can unilaterally move the oracle price. Min 2 sources required." (Property #3) | `minSources` defaults to `1`. A single Jupiter response can set the on-chain price. |
| "No source deviates >10% from the median (outlier rejection)" | `maxSourceDeviationPct` defaults to `0.02` (2%) |
| "All 3 sources returned a price" (Pipeline step 2) | Raydium is stubbed. Only 1–2 sources ever return. |
| "Jupiter shows >$1000 liquidity (dust filter)" (Pipeline step 2) | No liquidity filter exists in the code. |

**Impact:** Auditors, integrators, or future contributors relying on the spec will have incorrect assumptions about the system's trust model. Security Property #3 is formally violated.

**Recommendation:** Update the spec to reflect the current design decisions. Clearly document that single-source operation is intentional and accepted for the current deployment stage.

---

### NEW-02: Single-Source Operation Eliminates Cross-Validation

**Severity:** Medium

**Location:** `oracle-cranker.ts` — `aggregatePrice()`, default config

With `minSources=1` and Raydium stubbed:
- **Without Birdeye API key:** Jupiter is the *only* source. Every update is single-source.
- **With Birdeye API key:** If Birdeye is down or returns a stale price (filtered by M-03 fix), Jupiter alone posts.

When a single source posts:
- `confidence = max_price - min_price = 0` (single element, min=max)
- Zero confidence is posted on-chain, signaling "perfect certainty" when in reality there is *no cross-validation at all*
- On-chain confidence check passes trivially (`0 <= max_conf`)

**Impact:** The on-chain confidence value becomes meaningless for single-source updates. Any downstream consumer interpreting confidence as a quality signal will be misled. If Jupiter returns a manipulated or cached price, there is no second source to detect it.

**Recommendation:**
1. When `numSources == 1`, set a minimum floor confidence (e.g., 0.5% of price) to signal reduced certainty to on-chain consumers.
2. Alternatively, emit a distinct metric/log when posting single-source so operators can monitor the frequency.
3. Long-term: prioritize Raydium on-chain reads to restore genuine multi-source operation.

---

### NEW-03: Jupiter Timestamp Fabrication Enables Stale Price Posting

**Severity:** Medium

**Location:** `oracle-cranker.ts` — `fetchJupiterPrices()`, line: `timestamp: now`

Jupiter Price API v2 does not return a timestamp. The cranker fabricates one:

```ts
timestamp: now, // Jupiter doesn't provide timestamps — known limitation (M-03)
```

Combined with `minSources=1`, a stale Jupiter response (e.g., due to Jupiter caching, CDN issues, or API degradation) will:
1. Pass the cranker's validation (fabricated timestamp is always fresh)
2. Post on-chain with a current `clock.unix_timestamp`
3. Pass on-chain staleness checks
4. Be consumed by the protocol as a valid, fresh price

**Impact:** The M-03 fix only protects against Birdeye staleness. Jupiter staleness is invisible to the entire system. Since Jupiter is the *primary* and often *only* source, this is the more dangerous vector.

**Recommendation:**
1. Track the last-known Jupiter price per mint. If the price is identical across N consecutive fetches (e.g., 5+), flag it as potentially stale and log a warning.
2. Compare Jupiter's returned price against the previous on-chain price. If unchanged for an unusual duration, reduce confidence or skip the update.
3. Consider adding Birdeye as a mandatory cross-check (not just optional) — even if it can't be a required source, use it as a staleness canary.

---

### NEW-04: 2% Deviation Threshold Creates On-Chain Rejection Boundary

**Severity:** Low

**Location:** `oracle-cranker.ts` — `maxSourceDeviationPct` default `0.02`; `oracle.rs` — `ORACLE_CONFIDENCE_BPS`

The cranker's outlier rejection threshold (`maxSourceDeviationPct = 0.02`) is aligned with the on-chain confidence rejection (`ORACLE_CONFIDENCE_BPS = 2%`). The config comment confirms this is intentional:

> *"Aligned with on-chain ORACLE_CONFIDENCE_BPS (2%) to prevent dead-zone posts."*

However, the alignment is exact, which creates an edge case:

- Two sources at median ± 1.99% both pass outlier rejection
- `confidence = max_price - min_price ≈ 3.98% of median`
- On-chain check: `confidence <= price * 200 / 10000 = 2% of price` → **REJECTED**

The cranker allows source pairs that produce confidence values the on-chain program will reject.

**Impact:** Legitimate price updates get silently dropped on-chain. The cranker logs a successful post but the transaction reverts. If metrics don't track tx failures, this creates a silent staleness window.

**Recommendation:**
1. Set `maxSourceDeviationPct` to `0.01` (1%) — half the on-chain bound — to guarantee that any accepted source pair produces confidence within on-chain limits.
2. Or: compute the expected on-chain confidence *before* posting and skip if it would exceed the bound.

---

### NEW-05: EMA Overflow Causes Oracle Freeze

**Severity:** Low

**Location:** `update_perk_oracle.rs` — EMA calculation

```rust
oracle.ema_price = params.price
    .checked_add(
        oracle.ema_price.checked_mul(9).ok_or(PerkError::MathOverflow)?
    )
    .ok_or(PerkError::MathOverflow)?
    .checked_div(10)
    .ok_or(PerkError::MathOverflow)?;
```

If `ema_price > u64::MAX / 9` (~2.05e18), `checked_mul(9)` returns `None` and the instruction reverts with `MathOverflow`. Since `PRICE_SCALE = 1e6` and `MAX_ORACLE_PRICE` is likely well below this, this is unlikely for real tokens. But:

- A token priced at $2,000,000,000,000 (2 trillion) scaled by 1e6 = 2e18 → overflow
- Once the EMA enters overflow territory, *every subsequent update fails*, effectively freezing the oracle permanently (not via `is_frozen`, so `unfreeze` won't help)

**Impact:** Extremely low probability for real tokens. Could theoretically be triggered by a compromised cranker posting `MAX_ORACLE_PRICE` repeatedly to poison the EMA.

**Recommendation:** Add a comment documenting the EMA's safe operating range. Optionally cap EMA at `MAX_ORACLE_PRICE` to prevent accumulation beyond bounds.

---

### NEW-06: Schema Validation Improvements Are Solid

**Severity:** Informational (Positive)

**Location:** `oracle-cranker.ts` — Jupiter and Birdeye fetchers

Both fetchers now validate the response schema:

```ts
// Jupiter
if (!json.data || typeof json.data !== "object") {
  throw new Error("Jupiter API returned unexpected schema (missing data)");
}

// Birdeye
if (!json.data || typeof json.data !== "object") {
  throw new Error("Birdeye API returned unexpected schema (missing data)");
}
```

Individual price entries are also validated:
- Jupiter: `if (!entry?.price || typeof entry.price !== "string") continue;`
- Birdeye: `if (!entry?.value || typeof entry.value !== "number") continue;`
- Both: `if (!isFinite(price) || price <= 0) continue;`

**Status:** Good defensive coding. Prevents type confusion from API changes.

---

## Circuit Breaker Removal — Design Review

The spec explicitly states:
> *"No price banding — memecoins move freely. 1000% pump in an hour is valid."*

This is a deliberate design choice, not an oversight. For memecoin perps, price banding would create:
- False rejections during legitimate pumps/dumps
- Delayed price tracking causing liquidation failures
- Arbitrage opportunities between the banded oracle and real market price

**Assessment:** The removal is architecturally consistent. The risk is accepted and documented. The on-chain `freeze_perk_oracle` instruction serves as the manual circuit breaker for manipulation scenarios.

---

## Summary

| ID | Title | Severity | Status |
|---|---|---|---|
| M-01 | Two-source deadlock | — | ✅ Fixed |
| M-02 | No fetch timeouts | — | ✅ Fixed |
| M-03 | Timestamp blindness (Birdeye) | — | ✅ Fixed |
| NEW-01 | Spec drift contradicts implementation | Info | 🟡 Open |
| NEW-02 | Single-source eliminates cross-validation | Medium | 🟡 Open |
| NEW-03 | Jupiter timestamp fabrication | Medium | 🟡 Open |
| NEW-04 | 2% deviation ↔ on-chain confidence boundary | Low | 🟡 Open |
| NEW-05 | EMA overflow causes permanent freeze | Low | 🟡 Open |
| NEW-06 | Schema validation improvements | Info+ | ✅ Good |

**Overall assessment:** The three previous findings (M-01, M-02, M-03) are properly fixed. The `minSources=1` change, while necessary to prevent deadlocks, has introduced a degraded trust model that should be clearly documented and compensated for (NEW-02, NEW-03). The confidence boundary edge case (NEW-04) should be addressed before mainnet to prevent silent update failures.

---

*Pashov — Independent Security Researcher*  
*March 24, 2026*
