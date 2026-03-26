# PerkOracle

PerkOracle is Perk's custom oracle system. It provides on-chain price feeds for any SPL token with DEX liquidity — covering the long tail of tokens that Pyth doesn't support.

---

## Why PerkOracle Exists

Perk is permissionless — anyone can create a market for any token. But most tokens don't have Pyth price feeds. Without a price oracle, there's no way to calculate funding rates, trigger liquidations, or anchor the vAMM.

PerkOracle solves this by aggregating prices from multiple off-chain sources, posting them on-chain, and enforcing strict safety checks. If the oracle can't provide a reliable price, trading halts. It never uses a bad price.

---

## Oracle Tiers

| Tier | Primary Oracle | Fallback | Coverage |
|---|---|---|---|
| 1 | Pyth | PerkOracle | SOL, BTC, ETH, major tokens |
| 2 | PerkOracle | None | Any token with DEX liquidity |

Tier 1 markets use Pyth as the primary source with PerkOracle as a fallback. If Pyth goes stale or becomes unavailable, the market automatically falls back to PerkOracle rather than halting entirely.

Tier 2 markets rely solely on PerkOracle.

---

## Architecture

```
Jupiter Price API v3 ──┐
                       ├── Cranker (off-chain) ── median + validation ──▶ on-chain PerkOraclePrice
Birdeye API ───────────┘
```

### Price Aggregation Pipeline

1. **Fetch prices** from currently two active sources (Jupiter, Birdeye):
   - Jupiter Price API v3 (`api.jup.ag/price/v3`)
   - Birdeye Token Price API

2. **Validate** each source:
   - Price must be positive
   - Jupiter must show sufficient liquidity (dust filter)
   - No source can deviate more than the configured outlier threshold from the median (default: 1%)

3. **Aggregate:**
   - Take the **median** of valid sources (not the mean — resistant to one compromised source)
   - Confidence = spread across sources (max - min)

4. **Post on-chain:**
   - Call `update_perk_oracle` with: median price, confidence, source count
   - Update frequency: every 2–5 seconds per market

---

## On-Chain Account

Each token has a single `PerkOraclePrice` PDA, shared across all markets for that token. If multiple markets exist for the same token (created by different creators), they all read from the same oracle account. There is one price feed per token, not per market.

Seeds: `[b"perk_oracle", token_mint]`

```
Field                   Type    Description
─────────────────────────────────────────────────────────
token_mint              Pubkey  Token this oracle prices
authority               Pubkey  Authorized updater (cranker)
price                   u64     Current price (1e6 scale)
confidence              u64     Spread across sources (1e6 scale)
timestamp               i64     Unix timestamp of last update
num_sources             u8      Sources used in this update
min_sources             u8      Minimum required for valid update
last_slot               u64     Solana slot of last update
ema_price               u64     Exponential moving average
max_staleness_seconds   u32     Staleness threshold
is_frozen               bool    Admin emergency freeze
total_updates           u64     Lifetime update counter
```

---

## Security Checks

Every `update_perk_oracle` call must pass all of these:

| Check | Rule | Rationale |
|---|---|---|
| Authority | Signer must be `oracle.authority` | Only authorized updater |
| Not frozen | `is_frozen == false` | Emergency freeze respected |
| Gap protection | Time since last update < `max_staleness × 2` | Prevents stale→wild price jumps |
| Source minimum | `num_sources >= min_sources` | No single-source updates |
| Price positive | `price > 0` | No zero or negative prices |
| Rate limit | `current_slot > last_slot` | Max one update per slot (~400ms) |

### What's NOT Enforced On-Chain

**Price banding** is configurable per oracle but can be disabled (set to 0). Memecoins need to move freely — a 1000% pump in an hour is valid. Banding is recommended for stablecoins and majors:

| Market Type | Recommended Band | Rationale |
|---|---|---|
| Memecoins | 0 (disabled) | Wild price action is the product |
| Major tokens | 500 bps (5%) | Covers extreme volatility |
| Stablecoins | 100 bps (1%) | Should never move more than 1% |

---

## EMA Tracking

The oracle maintains an exponential moving average (`ema_price`) alongside the spot price. This provides:

- A smoothed reference for circuit breaker comparisons
- Resistance to short-term price spikes
- A baseline for detecting abnormal price movement

---

## Circuit Breaker

When enabled, the circuit breaker monitors price deviation from the EMA over a sliding window (50 slots ≈ 20 seconds):

- If the current price deviates beyond the configured threshold from the EMA, the oracle rejects the update
- The sliding window uses a multiplier (3x the per-update band) to allow gradual large moves while blocking sudden jumps
- After an unfreeze, the first update is banded against the pre-freeze price to prevent post-freeze manipulation

---

## Staleness

Every instruction that reads the oracle checks staleness:

```
if (clock.unix_timestamp - oracle.timestamp > max_staleness_seconds) {
    return Err(OracleStale);
}
```

Default staleness: 15 seconds. Configurable per oracle (5–300 seconds).

If the oracle goes stale, the market effectively pauses — no trades, no liquidations, no position changes. This is by design. A halted market is better than a market trading on bad data.

---

## Fail-Closed Design

PerkOracle is fail-closed, not fail-open:

- **Cranker goes offline** → oracle goes stale → market pauses automatically
- **API sources return conflicting data** → outlier rejection removes bad source → if fewer than `min_sources` remain, update fails → stale → pause
- **All API sources go down** → cranker can't meet `min_sources` → no updates → stale → pause
- **Admin freezes oracle** → all markets using it halt immediately
- **Oracle is frozen, then unfrozen** → first update is banded against pre-freeze price

At no point does the system fall back to guessing, interpolating, or using a known-bad price.

---

## Cranker Redundancy

- Multiple cranker instances can run simultaneously (different machines, different regions)
- Rate limit (1 update per slot) means only one wins per slot — no conflict
- If the primary cranker goes down, backup takes over seamlessly
- Crankers are independent — they all fetch prices and post independently, no coordination needed

---

## Fallback Logic

For Tier 1 markets (Pyth primary + PerkOracle fallback):

```
1. Try reading the primary oracle (Pyth)
2. If primary fails (stale, unavailable) → try fallback (PerkOracle)
3. If fallback also fails → instruction reverts, market pauses
```

Fallback only activates when the primary fails. Sources are never mixed or averaged together.

---

## Emergency Procedures

### Suspected Manipulation

1. Admin calls `freezePerkOracle()` for the affected token
2. All markets using that oracle halt (trades, liquidations, everything)
3. Investigate and resolve
4. Admin calls `unfreezePerkOracle()` to resume

### Cranker Key Compromise

1. Admin freezes all PerkOracle-dependent oracles
2. Transfer oracle authority via `transferOracleAuthority()` to a new key
3. Deploy new cranker with new key
4. Unfreeze

### Key Isolation

The oracle cranker key can **only write prices**. It has no admin privileges, no vault access, no ability to move funds. If compromised, an attacker can post bad prices but cannot steal anything. The freeze mechanism shuts this down immediately.

---

## Security Invariants

1. No trade executes on a stale price
2. No trade executes on a frozen oracle
3. No single entity can unilaterally move the oracle price (min 2 sources required)
4. Cranker compromise cannot steal funds (cranker only writes prices)
5. Oracle failure mode is always halt, never use-bad-price
6. Fallback only activates when primary fails (no source mixing)
7. Protocol remains solvent regardless of oracle behavior (Percolator handles worst case)
