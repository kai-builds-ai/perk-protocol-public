# 🩸 Predator Audit — PerkOracle Cranker

**Auditor:** Predator (adversarial smart contract auditor)
**Date:** March 24, 2026
**Scope:** Oracle cranker (`oracle-cranker.ts`), on-chain oracle instructions, oracle engine, and downstream consumers (open/close/liquidate)
**Methodology:** Attacker-first. Every finding answers: "Can I steal money or break things?"

---

## Executive Summary

The PerkOracle cranker is a **single off-chain process that is the sole price authority** for Tier 2 markets (any token without Pyth). The on-chain program intentionally enforces **zero price banding** — meaning the cranker can post ANY price between 1 and 1,000,000,000,000 (1e12) and the program will accept it. The entire security model rests on the cranker posting honest prices. This is a massive attack surface.

**Critical findings: 3 | High: 3 | Medium: 4 | Low: 2**

The most dangerous combination: `minSources=1` (default) + Raydium stubbed (always empty) + no on-chain price banding = **a single API compromise gives you full oracle control**.

---

## CRITICAL-01: Single API Poisoning → Full Oracle Control

**Difficulty:** Medium
**Cost to attacker:** $0–$5,000 (API key compromise or MITM)
**Profit potential:** Unbounded (drain all positions on affected market)

### The Setup

The cranker defaults to `minSources = 1`. Raydium is stubbed (returns empty map always). So the cranker operates on at most 2 sources: Jupiter and Birdeye. If one is down, the other alone is sufficient.

### Attack Scenario

1. **Take down one API.** DDoS Jupiter's `api.jup.ag` endpoint, or simply wait for natural downtime/rate-limiting. The cranker catches the error and continues with remaining sources.
2. **Poison the surviving API.** Multiple vectors:
   - **DNS hijack** on the API domain (BGP hijack, DNS cache poisoning)
   - **Compromise the API provider's CDN** or edge node
   - **Man-in-the-middle** if the cranker is on a compromised network (cloud provider, VPS)
   - **API key compromise** for Birdeye (key is passed in config — if leaked from env/logs, attacker can manipulate the account's response cache)
3. **Return a crafted price.** For a token trading at $1.00, return $0.50. The cranker has only 1 source, which passes `minSources >= 1`. No outlier rejection possible with 1 source. Median of 1 value = that value.
4. **Cranker posts $0.50 on-chain.** On-chain checks pass: price > 0 ✅, price <= MAX_ORACLE_PRICE ✅, num_sources >= min_sources (1 >= 1) ✅, not frozen ✅, gap check passes ✅.
5. **Exploit the mispricing:**
   - Open a massive long at the depressed price
   - Wait for next honest update (or poison the price back up)
   - Close at the real price for guaranteed profit
   - OR: Liquidate every short position that was healthy at the real price

### What Stops It

Nothing, if `minSources = 1` and one API is unavailable.

### Recommended Defense

- **[CRITICAL] Set `minSources = 2` as the immutable default.** Never allow 1.
- **[CRITICAL] Set on-chain `min_sources = 2`** in the PerkOraclePrice account. The on-chain check `params.num_sources >= oracle.min_sources` is the last line of defense.
- Implement Raydium on-chain reads ASAP to have a 3rd independent source.
- Add certificate pinning or hash verification for API responses.

---

## CRITICAL-02: Cranker Key Theft → Arbitrary Price Posting

**Difficulty:** Medium (key is in env var on a server)
**Cost to attacker:** $0 (if server is compromised) to $10,000+ (targeted attack)
**Profit potential:** Unbounded — drain every market using PerkOracle

### The Setup

The cranker wallet private key is the **sole authority** for posting prices. There is no multisig, no threshold signature, no secondary verification. The on-chain program's only auth check is `has_one = authority` — if you have the key, you ARE the oracle.

### Attack Scenario

1. **Steal the cranker private key.** Vectors:
   - Server compromise (SSH, unpatched CVE, supply chain attack on dependencies)
   - Cloud provider insider threat
   - Memory dump of the running process
   - Env var leaked in logs, error reporting, or crash dumps
   - Dependency in `node_modules` exfiltrates env vars (supply chain)
2. **Run your own cranker with the stolen key.** Post prices for any PerkOracle-enabled token.
3. **For each market:** Post a price 50% below real → open massive longs → post price back to real → close for profit. Repeat for shorts.
4. **The rate limit is 1 update per slot (~400ms).** At 3-second intervals, you get ~7 price posts per cycle. Each one can move the price arbitrarily.
5. **No on-chain banding** means you can jump from $100 to $0.01 in a single update. Legitimate.

### Maximum Damage Calculation

For a market with $1M in total collateral:
- Post price at 50% of real → all longs with leverage > 2x are liquidatable
- Liquidate them (permissionless) → collect liquidation rewards
- Post price at 200% of real → all shorts with leverage > 2x are liquidatable
- Repeat until the vault is drained
- **Total damage: 100% of vault TVL across ALL PerkOracle markets**

### What Stops It

Admin can call `freeze_perk_oracle`, but this is reactive and requires:
- Detecting the attack (monitoring)
- Admin being online with their Ledger
- Submitting and landing the freeze transaction

**Realistic response time: 5–30 minutes.** At 1 update per slot, the attacker has posted ~750–4,500 malicious prices by then.

### Recommended Defense

- **[CRITICAL] Implement multisig or threshold oracle authority.** Require 2-of-3 cranker signatures to post a price.
- Add on-chain price banding for non-memecoin markets (configurable per market).
- Implement automated monitoring that freezes oracles if price moves > X% in < Y seconds.
- Use a hardware security module (HSM) for the cranker key, not an env var.
- Run the cranker in a TEE (Trusted Execution Environment) so even server compromise doesn't leak the key.

---

## CRITICAL-03: No On-Chain Price Banding = Infinite Attack Surface

**Difficulty:** N/A (architectural issue)
**Cost to attacker:** N/A
**Profit potential:** N/A (amplifier for all other attacks)

### The Problem

The spec explicitly states: *"No price banding — memecoins need to move freely."* This means:

```
Update 1: price = $1,000,000 (1e12 at PRICE_SCALE)
Update 2: price = $1          (1e6 at PRICE_SCALE)
```

Both are valid. The on-chain program accepts any price in range `[1, 1_000_000_000_000]`. This is a **1,000,000,000,000x range** with zero rate-of-change enforcement.

Every other attack in this report is amplified by this design choice. A compromised source doesn't need to be subtle — it can post an extreme price in a single update.

### The Tradeoff

The spec's reasoning is valid — memecoins DO pump 1000% in an hour. But the defense should be **configurable per market**, not globally absent.

### Recommended Defense

- Add an optional `max_price_change_bps` field to PerkOraclePrice. Default 0 = no banding (memecoins). Set to e.g., 1000 (10%) for major tokens.
- Even for memecoins, a per-slot rate limit of 50% would be reasonable. A legitimate 1000% pump over an hour is ~0.3% per slot.

---

## HIGH-01: Dual-Source Coordinated Poisoning Within Confidence Band

**Difficulty:** Hard
**Cost to attacker:** $10,000–$100,000
**Profit potential:** High (proportional to market TVL × leverage)

### The Setup

Even with `minSources = 2`, if both Jupiter and Birdeye return prices within the `maxSourceDeviationPct` (default 2%) of each other, both are accepted. The median of two values within 2% of each other can still be 2% off from the real price.

### Attack Scenario

1. **Influence both APIs simultaneously.** This is harder but not impossible:
   - Jupiter aggregates across DEXes. Wash-trade on low-liquidity DEXes that Jupiter includes in its aggregation. This shifts Jupiter's reported price.
   - Birdeye uses a similar aggregation model. Same wash-trading works.
   - For low-cap tokens, manipulating the actual on-chain liquidity pools to shift the real price is cheap.
2. **Shift both sources by 1.5% in the same direction.** Both within the 2% deviation threshold. Median = 1.5% off.
3. **On a 20x leveraged position, 1.5% price manipulation = 30% PnL swing.** That's the difference between profitable and liquidated.
4. **Execute trades at the manipulated price.** Open positions → restore real price → close at profit.

### What Stops It

- The 2% deviation check catches divergence between sources, not coordinated bias
- On-chain confidence check (2% max) catches wide spreads but not tight coordinated errors
- For major tokens (Tier 1), Pyth is primary and PerkOracle is fallback only

### Recommended Defense

- Implement Raydium on-chain reads (3rd source makes coordinated manipulation 10x harder)
- Add TWAP comparison: reject if current price deviates significantly from the EMA
- For high-value markets, require 3 sources minimum

---

## HIGH-02: Cranker DoS → Oracle Staleness → Trading Freeze (Griefing)

**Difficulty:** Easy
**Cost to attacker:** $50–$500/day (botnet rental for DDoS)
**Profit potential:** $0 direct, but devastating for protocol reputation + enables secondary exploits

### Attack Scenario

1. **DDoS the cranker's server.** If there's a single cranker instance (the current architecture for Tier 2 tokens), take it offline.
2. **OR DDoS both Jupiter and Birdeye simultaneously.** The cranker can't fetch prices, stops posting.
3. **Oracle goes stale after `max_staleness_seconds` (default 15s).** That's FAST.
4. **All markets using this oracle freeze.** No opens, no closes, no liquidations.
5. **Positions accumulate funding payments but can't be closed.** Users trapped.

### Secondary Exploit: Staleness → Unfreeze → Gap Attack

The gap attack check requires `gap <= max_staleness * 2`. If the oracle is down for > 30 seconds (2 × 15s), the cranker can't resume — it hits `OracleGapTooLarge`. Admin must unfreeze manually. But the unfreeze sets `price = 0` and `_reserved[0] = 1` (bypass flag), and the NEXT update bypasses the gap check.

This creates a window: the first post-unfreeze price update has NO gap check. If the attacker times it right:
1. DoS the cranker for 31 seconds → gap too large
2. Wait for admin to unfreeze → price zeroed, bypass flag set
3. Post a manipulated price as the first update → gap check bypassed
4. Profit from the manipulated price

### What Stops It

- Running multiple cranker instances (spec mentions this but it's not enforced)
- The gap attack defense catches natural staleness

### Recommended Defense

- **[HIGH] Mandate minimum 2 cranker instances in different regions/providers.**
- Add on-chain circuit breaker: if oracle was stale, first N updates must be within X% of EMA.
- Increase `max_staleness_seconds` to 30–60s to be more resilient to brief outages.
- After unfreeze, require first update to be within 5% of the pre-freeze EMA (stored on-chain).

---

## HIGH-03: Front-Running Oracle Transactions

**Difficulty:** Medium
**Cost to attacker:** Priority fee costs (~$0.01–$1 per trade)
**Profit potential:** Consistent small profits per oracle update (MEV extraction)

### The Setup

The cranker posts oracle updates as normal Solana transactions. These are visible in the mempool (or via RPC websocket subscriptions) before they land on-chain.

### Attack Scenario

1. **Monitor the cranker's transactions.** Watch for `updatePerkOracle` instructions via RPC.
2. **Decode the pending price from the transaction data.** The price is in the instruction params — it's not encrypted.
3. **If the new price is higher than current on-chain price:** Open a long BEFORE the oracle update lands, close AFTER.
4. **If lower:** Open a short BEFORE, close AFTER.
5. **Use Jito bundles** to guarantee your trade lands in the same slot as (or just before) the oracle update.

### Profit Calculation

- Average oracle price change per update: ~0.1–0.5% (volatile tokens more)
- At 20x leverage: 2–10% per trade
- Trading fee: 0.03% × 2 (open + close) = 0.06%
- Net per trade: ~1.9–9.9%
- Updates every 3 seconds = ~28,800/day
- Even if only 10% are exploitable: ~2,880 profitable trades/day

### What Stops It

- The 1-slot minimum holding period (`last_activity_slot` check) prevents atomic same-slot open+close
- But the attacker can open in slot N (before oracle update) and close in slot N+1 (after oracle update) — holding period satisfied

### Recommended Defense

- **[HIGH] Use Jito bundles for oracle updates** to minimize mempool exposure time.
- Submit oracle updates via private RPC/validator relationships.
- Add a random delay (1–3 slots) before oracle prices become effective.
- Consider commit-reveal scheme: commit hash of price, reveal in next slot.

---

## MEDIUM-01: Raydium Stub Creates False Sense of Security

**Difficulty:** N/A (design issue)
**Cost to attacker:** $0
**Profit potential:** Amplifies CRITICAL-01

### The Problem

The spec claims "3 independent sources + median + outlier rejection" but Raydium is stubbed:

```typescript
async function fetchRaydiumPrices(...): Promise<Map<string, PriceSource>> {
  // TODO: Implement on-chain Raydium pool reads.
  return new Map();
}
```

This means the system operates with at most **2 sources**, not 3. The spec's security claims about "attacker must compromise 2/3 simultaneously" are false — it's 1/2 or even 1/1 (with `minSources=1`).

### Recommended Defense

- Update the spec to reflect reality: 2 sources, not 3.
- Prioritize Raydium implementation.
- Until Raydium is live, explicitly set `minSources = 2` and require BOTH Jupiter AND Birdeye to agree.

---

## MEDIUM-02: Jupiter Timestamps Are Fabricated

**Difficulty:** N/A (design issue)
**Cost to attacker:** $0
**Profit potential:** Enables stale price replay

### The Problem

```typescript
// Jupiter doesn't provide timestamps — known limitation (M-03)
results.set(key, {
  name: "jupiter",
  price,
  confidence: 0,
  timestamp: now, // ← FABRICATED
});
```

The cranker stamps Jupiter prices with `Date.now()`. If Jupiter's API caches a stale price (known to happen during high load), the cranker treats it as fresh. Birdeye has actual timestamps and the cranker rejects prices older than 60 seconds — but Jupiter gets no such protection.

### Attack Scenario

1. Jupiter caches a price from 5 minutes ago during high load.
2. Cranker fetches it, stamps it as "now", treats it as fresh.
3. With `minSources=1` and Birdeye down, this stale price is posted on-chain.
4. Attacker trades against the known-stale price.

### Recommended Defense

- Add a secondary staleness check: compare Jupiter price against the last posted on-chain price. If it hasn't changed in N updates, flag it as potentially stale.
- When Jupiter is the sole source, require additional validation.

---

## MEDIUM-03: Confidence Always Zero from Jupiter

**Difficulty:** Easy to exploit
**Cost to attacker:** $0
**Profit potential:** Indirect (weakens safety checks)

### The Problem

```typescript
results.set(key, {
  name: "jupiter",
  confidence: 0, // ← Always zero
  ...
});
```

Birdeye also returns `confidence: 0`. The aggregated confidence = `max_price - min_price` across sources. With 1 source, confidence = 0. With 2 sources within 2%, confidence is small but nonzero.

On-chain, the confidence check requires `confidence <= price * 200 / 10000` (2% of price). A confidence of 0 always passes.

This means the on-chain confidence check is **effectively disabled** for PerkOracle. It provides no signal about price uncertainty.

### Recommended Defense

- Compute meaningful confidence from source spread, bid-ask if available, or recent volatility.
- If confidence cannot be meaningfully computed, set a minimum floor (e.g., 0.1% of price).

---

## MEDIUM-04: Tick Overlap / Reentrant Tick Silently Drops Updates

**Difficulty:** Easy (natural under load)
**Cost to attacker:** $0 (happens naturally)
**Profit potential:** Contributes to staleness

### The Problem

```typescript
private async tick() {
  if (!this.running || this.tickInProgress) return; // ← Silently skips
  this.tickInProgress = true;
  ...
}
```

If a tick takes longer than the 3-second interval (e.g., RPC is slow, API response delayed up to 5s timeout), the next tick is silently skipped. Under sustained load, the cranker could miss multiple updates, approaching staleness.

With `ORACLE_STALENESS_SECONDS = 15` and a 3-second interval, the cranker can miss at most 4 consecutive ticks before the oracle goes stale. That's a 12-second window — very tight.

### Recommended Defense

- Log when ticks are skipped (currently silent).
- If N consecutive ticks are skipped, raise an alert.
- Consider making the tick interval adaptive based on actual tick duration.

---

## LOW-01: Priority Fee is Insufficient for Guaranteed Inclusion

**Difficulty:** Easy
**Cost to attacker:** $0
**Profit potential:** Indirect (enables front-running)

### The Problem

Default priority fee is 50,000 microlamports per CU. During Solana congestion, this may be insufficient for timely inclusion. An attacker front-running oracle updates can bid higher priority fees to ensure their trade lands first.

### Recommended Defense

- Use dynamic priority fees based on recent block fee statistics.
- Consider Jito tip for guaranteed next-slot inclusion.

---

## LOW-02: No Cranker Health Monitoring On-Chain

**Difficulty:** N/A
**Cost to attacker:** $0
**Profit potential:** Indirect

### The Problem

There is no on-chain mechanism to detect that the cranker is unhealthy (posting but with degraded sources, or posting increasingly stale data). The `total_updates` counter increments but there's no quality metric.

### Recommended Defense

- Add an on-chain field for "consecutive single-source updates". If this exceeds a threshold, auto-freeze or emit a log that monitoring can catch.
- Track source diversity in the oracle account.

---

## Attack Chain: The Nuclear Scenario

Combining findings for maximum damage:

1. **Compromise the cranker server** (CRITICAL-02) via supply chain attack on a Node.js dependency
2. **Extract the private key** from the process environment
3. **Run a shadow cranker** posting manipulated prices for all PerkOracle tokens
4. **No price banding** (CRITICAL-03) means you can post $0.01 for a token worth $100
5. **For each market:**
   - Post price at 1/100th of real → liquidate all longs (permissionless) → collect rewards
   - Post price at 100x real → liquidate all shorts → collect rewards
   - Open positions at manipulated prices, restore real prices, close for profit
6. **Total time needed:** ~2 minutes (limited by slot rate)
7. **Detection window:** Admin must notice, get Ledger, sign freeze transaction
8. **Total damage:** 100% of TVL across all Tier 2 markets

**This is a protocol-ending event for Tier 2 markets.**

---

## Summary Table

| ID | Severity | Finding | Fix Complexity |
|----|----------|---------|----------------|
| CRITICAL-01 | 🔴 Critical | Single API poisoning with minSources=1 | Easy (config change + on-chain enforcement) |
| CRITICAL-02 | 🔴 Critical | Cranker key theft = full oracle control | Hard (requires multisig/TEE) |
| CRITICAL-03 | 🔴 Critical | No on-chain price banding | Medium (add optional per-market banding) |
| HIGH-01 | 🟠 High | Dual-source coordinated poisoning | Medium (add 3rd source) |
| HIGH-02 | 🟠 High | Cranker DoS → trading freeze + gap exploit | Medium (redundancy + circuit breaker) |
| HIGH-03 | 🟠 High | Front-running oracle transactions | Medium (private submission + delay) |
| MEDIUM-01 | 🟡 Medium | Raydium stub = false 3-source claim | Easy (update spec, implement Raydium) |
| MEDIUM-02 | 🟡 Medium | Jupiter timestamps fabricated | Easy (secondary staleness check) |
| MEDIUM-03 | 🟡 Medium | Confidence always zero | Easy (compute meaningful confidence) |
| MEDIUM-04 | 🟡 Medium | Silent tick drops under load | Easy (logging + adaptive interval) |
| LOW-01 | 🔵 Low | Static priority fee | Easy (dynamic fees) |
| LOW-02 | 🔵 Low | No on-chain cranker health signal | Medium (add quality metrics) |

---

## Top 3 Immediate Actions

1. **Set `minSources = 2` everywhere** — both in cranker config default AND in on-chain `PerkOraclePrice.min_sources`. This single change blocks CRITICAL-01.
2. **Add EMA-based circuit breaker**: If posted price deviates > 20% from on-chain EMA, reject (on-chain or in cranker). This limits damage from CRITICAL-02 and CRITICAL-03.
3. **Submit oracle updates via Jito bundles with private transaction submission.** This blocks HIGH-03 front-running.

---

*Predator out. Your cranker is the keys to the kingdom and it's guarded by a single env var on a Node.js server. Fix it before mainnet or someone will fix your TVL to zero.*
