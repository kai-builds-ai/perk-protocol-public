# PerkOracle — Security Specification

## Overview
Custom oracle system for Perk Protocol. Provides price feeds for any SPL token with DEX liquidity, using Jupiter aggregation as the price source. Designed as the primary oracle for tokens without Pyth feeds, and as a fallback for Pyth-covered tokens.

## Architecture

```
Jupiter Price API ──┐
                    ├──▶ Cranker (off-chain) ──▶ update_perk_oracle IX ──▶ PerkOraclePrice (on-chain account)
Birdeye API ────────┘         │                         ▲
                              │                         │
                              └── Divergence-checked ───┘
                                  average (2 sources)
```

## Oracle Tiers (per market)

| Tier | Primary Oracle | Fallback Oracle | Coverage |
|------|---------------|-----------------|----------|
| 1    | PerkOracle    | Pyth (if available) | All markets (current) |
| 2    | Pyth          | PerkOracle      | Major tokens (future, deferred) |

## On-Chain Components

### 1. PerkOraclePrice Account

```rust
pub struct PerkOraclePrice {
    pub bump: u8,
    pub token_mint: Pubkey,          // What token this prices
    pub authority: Pubkey,            // Who can update (multisig or cranker authority)
    pub price: i64,                   // Price in PRICE_SCALE (1e6)
    pub confidence: u64,              // Spread across sources (1e6 scale)
    pub timestamp: i64,               // Unix timestamp of last update
    pub num_sources: u8,              // How many sources contributed to this price
    pub min_sources: u8,              // Minimum sources required for a valid update
    pub last_slot: u64,               // Solana slot of last update
    pub ema_price: i64,               // Exponential moving average (smoothed)
    pub max_staleness_seconds: u32,   // After this, oracle is considered stale
    pub is_frozen: bool,              // Admin emergency freeze
    pub created_at: i64,
    pub total_updates: u64,           // Lifetime update counter
    pub _reserved: [u8; 64],          // Future-proofing (avoid realloc)
}
```

**Seeds:** `[b"perk_oracle", token_mint.as_ref()]` — one oracle per token mint, deterministic.

### 2. OracleSource Enum Update

```rust
pub enum OracleSource {
    Pyth,
    PerkOracle,
    DexPool,       // Reserved, not implemented
}
```

### 3. Market State Additions

```rust
// Added to Market account
pub fallback_oracle_source: OracleSource,
pub fallback_oracle_address: Pubkey,
```

**Note:** Adds 33 bytes. Uses `_reserved` bytes from Market account — no realloc needed.

### 4. Instructions

#### `initialize_perk_oracle`
- **Signer:** Any payer (permissionless since v1.2.0)
- **Creates:** PerkOraclePrice account for a given token mint
- **Params:** min_sources, max_staleness_seconds
- **Security:** Permissionless — anyone can create an oracle by paying rent. Oracle authority is inherited from `Protocol.oracle_authority` (set once by admin via `admin_set_oracle_authority`).

#### `update_perk_oracle`
- **Signer:** Authorized cranker (oracle.authority)
- **Updates:** price, confidence, timestamp, num_sources, ema_price
- **Security checks (ALL must pass):**

| Check | Rule | Rationale |
|-------|------|-----------|
| Authority | `signer == oracle.authority` | Only authorized updater |
| Not frozen | `!oracle.is_frozen` | Emergency freeze respected |
| Staleness | `clock.unix_timestamp - last_update < max_staleness * 2` | Prevent stale→wild jump (gap attack) |
| Min sources | `num_sources >= oracle.min_sources` | No single-source updates |
| Price positive | `price > 0` | No zero/negative prices |
| Rate limit | `clock.slot > oracle.last_slot` | Max one update per slot (~400ms) |

**NOT enforced on-chain (by design):**
- Price banding — memecoins need to move freely
- Max price change — legitimate pumps/dumps must be reported accurately

#### `freeze_perk_oracle`
- **Signer:** Protocol admin only
- **Sets:** `is_frozen = true`
- **Effect:** All trades on markets using this oracle halt immediately
- **Use case:** Emergency response to detected manipulation

#### `unfreeze_perk_oracle`
- **Signer:** Protocol admin only
- **Sets:** `is_frozen = false`

#### `transfer_oracle_authority`
- **Signer:** Current authority
- **Updates:** authority to new pubkey
- **Use case:** Rotate cranker keys, migrate to multisig

### 5. Oracle Reader (oracle.rs)

```rust
fn read_perk_oracle_price(
    account: &AccountInfo,
    clock_timestamp: i64,
) -> Result<OraclePriceResult> {
    // Deserialize
    // Check not frozen
    // Check staleness: clock_timestamp - oracle.timestamp <= max_staleness_seconds
    // Check min sources were met
    // Return price + confidence
}
```

### 6. Fallback Logic (oracle.rs)

```rust
fn read_oracle_price_with_fallback(
    primary_source: OracleSource,
    primary_account: &AccountInfo,
    fallback_source: OracleSource,
    fallback_account: &AccountInfo,
    clock_timestamp: i64,
) -> Result<OraclePriceResult> {
    match read_oracle_price(primary_source, primary_account, clock_timestamp) {
        Ok(result) => Ok(result),
        Err(_) => {
            // Primary failed (stale, frozen, etc.) — try fallback
            // If fallback_source is default/unset, return the original error
            read_oracle_price(fallback_source, fallback_account, clock_timestamp)
        }
    }
}
```

## Off-Chain Cranker

### Price Aggregation Pipeline

```
1. Fetch prices from 2 independent sources:
   - Jupiter Price API v2 (https://api.jup.ag/price/v2)
   - Birdeye Token Price API

2. Validate:
   - Both sources returned a price
   - Sources do not diverge beyond MAX_DIVERGENCE_PCT (5%)
   - If divergence exceeded → skip update (fail-closed)

3. Aggregate:
   - Average of both sources (with divergence check as guard)
   - Confidence = |price_a - price_b| (spread between sources)

4. Post on-chain:
   - Call update_perk_oracle with: averaged price, confidence, source count
   - Update cycle: ~10s per oracle, 1.5s between oracles (configurable)
```

### Cranker Security

| Threat | Defense |
|--------|---------|
| Cranker key compromise | Rotate via transfer_oracle_authority. Freeze affected oracles immediately. |
| API source manipulation | 2 independent sources + divergence check. Attacker must compromise both simultaneously. |
| Cranker goes offline | On-chain staleness check freezes trading automatically. No stale price exploitation. |
| Flash loan DEX manipulation | Jupiter aggregates across all DEXes. Manipulating one pool doesn't move the aggregate significantly. Birdeye cross-validates independently. |
| Denial of service | Multiple cranker instances can run. Any authorized cranker can post. |
| Sandwich attack on oracle tx | Oracle updates don't move money. Nothing to sandwich. |

### Cranker Redundancy

- Run 2+ cranker instances (different machines/regions)
- First to land the update wins (rate limit = 1 per slot)
- If primary cranker is down, backup takes over seamlessly
- No coordination needed — they all post the same price independently

## Emergency Procedures

1. **Suspected manipulation detected:**
   - Admin calls `freeze_perk_oracle` for affected token
   - All markets using that oracle halt (trades, liquidations, everything)
   - Investigate, fix, unfreeze

2. **Cranker compromise:**
   - Admin freezes all PerkOracle-dependent oracles
   - Rotate cranker authority via `transfer_oracle_authority`
   - Deploy new cranker with new keys
   - Unfreeze

3. **All API sources down:**
   - Cranker stops posting (can't meet min_sources requirement)
   - On-chain staleness kicks in automatically
   - Markets pause — no action needed

## What We Explicitly Do NOT Do

- **No price banding by default** — memecoins move freely. 1000% pump in an hour is valid. Optional per-oracle banding available for stablecoins/majors.
- **No liquidity-based leverage caps** — fully permissionless. Market creator sets leverage.
- **No whitelist of supported tokens** — any SPL token with any DEX liquidity.
- **No governance over market parameters** — creator decides, protocol enforces.

## Security Properties (Invariants)

1. **No trade executes on a stale price.** If oracle is stale → instruction reverts.
2. **No trade executes on a frozen oracle.** Admin freeze = immediate halt.
3. **No single entity can unilaterally move the oracle price.** Min 2 sources required.
4. **Cranker compromise cannot steal funds.** Cranker only writes prices, never touches vaults.
5. **Oracle failure mode is always "halt", never "use bad price".** Fail-closed, not fail-open.
6. **Fallback only activates when primary fails.** No mixing of sources.
7. **Protocol remains solvent regardless of oracle behavior.** Percolator ADL handles any scenario.

## Price Banding Configuration

Per-oracle configurable rate-of-change limits. Stored in `_reserved[1..3]` as LE u16.
Pre-freeze reference price stored in `_reserved[3..11]` for post-unfreeze banding.
Minimum band: 100 bps (1%) when enabled. 0 = disabled.

### Recommended Settings by Market Tier

| Market Type | `max_price_change_bps` | Rationale |
|-------------|----------------------|-----------|
| **Memecoins / new tokens** | `0` (disabled) | Wild price action is the product. ADL handles insolvency. |
| **Major tokens** (SOL, BTC, ETH) | `500` (5% per update) | Covers extreme volatility. Limits compromised cranker to ~41%/3s worst case. |
| **Stablecoins** (USDC, USDT) | `100` (1% per update) | Should never move >1%. Halts oracle if depeg detected. |

### Operational Notes
- Admin can change banding on live oracles via `update_oracle_config`
- For extreme market events (LUNA-style), admin temporarily sets banding to 0
- After unfreeze, first update is banded against the pre-freeze price (C-01 fix)
- True first-ever update (no reference price) is unbanded

## Key Management (Mainnet)

### Wallet Separation

| Wallet | Purpose | Holds | Security | Who Controls |
|--------|---------|-------|----------|-------------|
| **Admin** | Protocol governance (pause, freeze, update markets) | Minimal SOL for tx fees | Hardware wallet (Ledger) | Protocol team |
| **Oracle Authority** | Posts PerkOracle price updates | ~0.5 SOL (auto-topped up) | Dedicated server, env var, never on disk | Cranker infra |
| **Liquidation Cranker** | Executes liquidations, funding cranks, trigger orders | ~1 SOL (auto-topped up) | Separate server, env var | Cranker infra |
| **Fee Collection** | Receives protocol fees | Accumulates fees | Hardware wallet (Ledger) | Protocol team |
| **Funding Wallet** | Tops up cranker wallets when SOL runs low | ~5 SOL reserve | Hot wallet, monitored | Protocol team |

### Key Isolation Rules

1. **No wallet serves two purposes.** Oracle authority ≠ liquidation cranker ≠ admin. Compromise of one does not compromise others.
2. **Admin key is NEVER on a server.** Always hardware wallet, always requires physical confirmation.
3. **Oracle authority can ONLY write prices.** It has no admin privileges, no vault access, no fee claims. If compromised, attacker can post bad prices but cannot steal funds.
4. **Liquidation cranker can ONLY execute liquidations/cranks.** It earns rewards but has no admin or oracle authority.
5. **Cranker wallets hold minimal SOL.** Auto-funded by a separate funding wallet. Max exposure if compromised: transaction fees (~0.5 SOL).

### Key Rotation

- **Oracle authority:** Rotate monthly via `transfer_oracle_authority`. Old key is deauthorized immediately.
- **Liquidation cranker:** Rotate quarterly. No on-chain authority to transfer — just deploy new cranker with new wallet.
- **Admin:** Only rotate if compromised. Hardware wallet makes routine rotation unnecessary.

### Compromise Response Playbook

| Scenario | Immediate Action | Recovery |
|----------|-----------------|----------|
| Oracle key compromised | Admin calls `freeze_perk_oracle` on all oracles | Rotate authority, deploy new cranker, unfreeze |
| Liquidation cranker compromised | No protocol action needed — can't manipulate prices or steal vault funds | Deploy new cranker with new wallet |
| Admin key compromised | Transfer admin via `admin_transfer` to new Ledger (if attacker hasn't already) | If attacker transferred admin: protocol is compromised — emergency disclosure, migrate to new deployment |
| Funding wallet compromised | Stop auto-funding, replace wallet | Attacker gets ~5 SOL max |
| Server breach (no key theft) | Rotate all server-hosted keys preemptively | Redeploy crankers on new infrastructure |

### Devnet vs Mainnet

| | Devnet | Mainnet |
|---|--------|---------|
| Admin key | File on disk (`wallets/admin.json`) | Ledger hardware wallet |
| Oracle authority | Same as admin (convenience) | Dedicated isolated wallet |
| Liquidation cranker | File on disk (`wallets/cranker.json`) | Env var on dedicated server |
| Fee wallet | File on disk | Ledger hardware wallet |
| Key rotation | Never | Monthly (oracle), quarterly (cranker) |

## Build Status

All PerkOracle components are **built, audited, and deployed to mainnet.**

| Component | Status |
|-----------|--------|
| PerkOraclePrice account state | ✅ Deployed |
| OracleSource::PerkOracle enum | ✅ Deployed |
| initialize_perk_oracle IX (permissionless) | ✅ Deployed |
| update_perk_oracle IX (6 security checks) | ✅ Deployed |
| freeze/unfreeze IX | ✅ Deployed |
| transfer_oracle_authority IX | ✅ Deployed |
| admin_set_oracle_authority IX | ✅ Deployed |
| update_oracle_config IX | ✅ Deployed |
| Oracle reader + fallback logic | ✅ Deployed |
| Market fallback fields | ✅ Deployed |
| SDK methods | ✅ Deployed |
| Oracle cranker (Jupiter+Birdeye) | ✅ Live on Railway |
| OtterSec verified build | ✅ Verified |
| 6 independent audit rounds | ✅ Complete |
