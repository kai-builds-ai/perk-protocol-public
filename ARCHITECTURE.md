# Perk — Architecture

> **perk.fund** — Permissionless perpetual futures on Solana. Any token. Any leverage. No permission.
> Full port of [aeyakovenko/percolator](https://github.com/aeyakovenko/percolator) risk engine.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Core Design Principles](#2-core-design-principles)
3. [On-Chain Program (Rust/Anchor)](#3-on-chain-program)
4. [Account Layout](#4-account-layout)
5. [Instructions](#5-instructions)
6. [vAMM Engine](#6-vamm-engine)
7. [Risk Engine](#7-risk-engine)
8. [Fee System](#8-fee-system)
9. [Oracle Integration](#9-oracle-integration)
10. [Trigger Orders (Limit/Stop)](#10-trigger-orders)
11. [Safety Rails](#11-safety-rails)
12. [TypeScript SDK](#12-typescript-sdk)
13. [Cranker Bots](#13-cranker-bots)
14. [Frontend](#14-frontend)
15. [Deployment](#15-deployment)

---

## 1. Overview

### What Is Perk?
A **permissionless** perpetual futures protocol on Solana. Anyone can launch a leveraged trading market for any SPL token in under a minute. Market creators earn **10% of all trading fees** on their market. Forever.

### Stack
- **On-chain:** Rust (Anchor framework) — vAMM, risk engine, vault, fees
- **SDK:** TypeScript (`@Perk/sdk`) — wraps all instructions
- **Crankers:** TypeScript — funding rate, trigger order execution, backup liquidation
- **Frontend:** Next.js + TradingView Advanced Charts (full charting_library)
- **Oracle:** PerkOracle (Jupiter + Birdeye aggregation, cranker-maintained)
- **Collateral:** USDC, USDT, PYUSD (6-decimal stablecoins)
- **RPC:** Helius
- **Hosting:** Vercel (frontend), Railway (cranker)

### Launch Scope
- **Permissionless market creation** — anyone can create a market for any SPL token
- **vAMM execution** — virtual AMM for price discovery, no order book needed
- **Trigger orders** — limit and stop orders that execute when price crosses
- **Leverage:** 1x–20x (configurable per market)
- **Stablecoin-margined** — all markets use stablecoin collateral (USDC, USDT, or PYUSD). Same model as Hyperliquid/dYdX.
- **10% creator fee** — market creators earn forever

### Roadmap (Post-Launch)
- Mobile optimization
- Analytics/leaderboards
- Referral system
- $PERK token
- Cross-margin (isolated only at launch)
- Governance

---

## 2. Core Design Principles

### Permissionless
- No admin approval to create markets
- No whitelist for tokens
- Anyone can create, anyone can trade, anyone can liquidate
- Markets self-heal via Percolator's H/A/K mechanism — no governance votes needed

### Decentralized
- All logic on-chain — no off-chain matching, no centralized sequencer
- Crankers are permissionless — anyone can run them for incentives
- Protocol admin only controls: global pause (emergency), protocol fee rate, minimum parameters
- Individual market creators have NO admin control after creation — markets are autonomous

### Sustainable
- Market creators earn 10% of fees → incentivizes market bootstrapping
- Protocol earns 90% of fees → sustainable without a token
- Liquidators earn incentive fees → keeps the system healthy
- Insurance fund per market → absorbs bad debt

---

## 3. On-Chain Program (Rust/Anchor)

### Program Structure

```
programs/Perk/
├── src/
│   ├── lib.rs                    # Anchor entrypoint, instruction dispatch
│   ├── state/
│   │   ├── mod.rs
│   │   ├── protocol.rs           # Global protocol config (admin, fee rates)
│   │   ├── market.rs             # Per-market state (vAMM, risk, params)
│   │   ├── user_position.rs      # Per-user per-market position
│   │   ├── trigger_order.rs      # Limit/stop orders
│   │   └── insurance_fund.rs     # Per-market insurance
│   ├── instructions/
│   │   ├── mod.rs
│   │   ├── initialize_protocol.rs
│   │   ├── create_market.rs      # Permissionless — anyone can call
│   │   ├── deposit.rs
│   │   ├── withdraw.rs
│   │   ├── open_position.rs      # Market order via vAMM
│   │   ├── close_position.rs
│   │   ├── place_trigger_order.rs
│   │   ├── execute_trigger_order.rs  # Permissionless cranker
│   │   ├── cancel_trigger_order.rs
│   │   ├── liquidate.rs          # Permissionless
│   │   ├── crank_funding.rs      # Permissionless
│   │   ├── update_amm.rs         # Oracle peg update
│   │   ├── admin_pause.rs        # Emergency only
│   │   └── admin_update_protocol.rs
│   ├── engine/
│   │   ├── mod.rs
│   │   ├── vamm.rs               # Virtual AMM (x * y = k)
│   │   ├── risk.rs               # H (haircut) + A/K (overhang) from Percolator
│   │   ├── funding.rs            # Funding rate calculation
│   │   ├── margin.rs             # Margin requirements
│   │   ├── liquidation.rs        # Liquidation logic
│   │   ├── oracle.rs             # Pyth + DEX oracle abstraction
│   │   └── warmup.rs             # PnL warmup window
│   ├── errors.rs
│   └── constants.rs
```

---

## 4. Account Layout

### Protocol (PDA, singleton)

```rust
#[account]
pub struct Protocol {
    pub admin: Pubkey,                 // Global admin (emergency pause only)
    pub paused: bool,                  // Global kill switch
    pub market_count: u64,             // Total markets created
    pub protocol_fee_vault: Pubkey,    // Protocol's fee collection (USDC)

    // Protocol fee config
    pub creator_fee_share_bps: u16,    // 1000 = 10% of fees to creator
    pub min_trading_fee_bps: u16,      // Minimum fee a creator can set (3 bps)
    pub max_trading_fee_bps: u16,      // Maximum fee a creator can set (100 bps)
    pub min_initial_liquidity: u64,    // Minimum k for market creation

    // Global stats
    pub total_volume: u128,
    pub total_fees_collected: u128,

    pub bump: u8,
}
```

### Market (PDA, 1 per market)

Seeds: `[b"market", token_mint.as_ref(), creator.as_ref()]`

```rust
#[account]
pub struct Market {
    // Identity
    pub market_index: u64,             // Auto-incrementing ID
    pub token_mint: Pubkey,            // The SPL token this market trades (for PDA + oracle)
    pub collateral_mint: Pubkey,       // Stablecoin (USDC/USDT/PYUSD, must be 6 decimals)
    pub creator: Pubkey,               // Market creator (earns 10% of fees)

    // Vault
    pub vault: Pubkey,                 // Stablecoin vault (holds collateral_mint tokens)
    pub vault_bump: u8,

    // vAMM State
    pub base_reserve: u128,            // Virtual base asset reserve
    pub quote_reserve: u128,           // Virtual quote asset reserve
    pub k: u128,                       // Invariant (base * quote), adjustable
    pub peg_multiplier: u128,          // Oracle peg (scales quote reserve)
    pub total_long_position: u128,     // Total long base size
    pub total_short_position: u128,    // Total short base size

    // Market parameters (set at creation, immutable)
    pub max_leverage: u32,             // e.g., 2000 = 20x
    pub trading_fee_bps: u16,          // e.g., 10 = 0.1%
    pub liquidation_fee_bps: u16,      // e.g., 100 = 1%
    pub maintenance_margin_bps: u16,   // e.g., 500 = 5%

    // Oracle
    pub oracle_source: OracleSource,   // Pyth or DEX
    pub oracle_address: Pubkey,        // Pyth feed or DEX pool address

    // Risk engine state (from Percolator)
    pub insurance_fund_balance: u64,
    pub haircut_numerator: u128,       // H ratio
    pub haircut_denominator: u128,
    pub long_a: u128,                  // A/K long side
    pub long_k_index: i128,
    pub short_a: u128,                 // A/K short side
    pub short_k_index: i128,
    pub long_epoch: u64,
    pub short_epoch: u64,
    pub long_state: SideState,         // Normal / DrainOnly / ResetPending
    pub short_state: SideState,

    // Funding
    pub last_funding_time: i64,
    pub cumulative_long_funding: i128,
    pub cumulative_short_funding: i128,
    pub funding_period_seconds: u32,   // 3600 = 1 hour
    pub funding_rate_cap_bps: u16,     // 10 = 0.1% per period

    // Warmup
    pub warmup_period_slots: u64,

    // Fee tracking
    pub creator_fees_earned: u64,      // Total fees paid to creator
    pub protocol_fees_earned: u64,     // Total fees paid to protocol
    pub total_volume: u128,

    // State
    pub active: bool,                  // Can be set to false if oracle dies
    pub total_users: u32,
    pub total_positions: u32,

    pub bump: u8,
    pub created_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum OracleSource {
    Pyth,          // Pyth price feed (v2, deferred)
    PerkOracle,    // Custom oracle (Jupiter+Birdeye aggregation)
    DexPool,       // PumpSwap / Raydium pool price (deferred)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum SideState {
    Normal,
    DrainOnly,
    ResetPending,
}
```

### UserPosition (PDA, 1 per user per market)

Seeds: `[b"position", market.key().as_ref(), user.key().as_ref()]`

```rust
#[account]
pub struct UserPosition {
    pub authority: Pubkey,             // User's wallet
    pub market: Pubkey,                // Market account

    // Collateral
    pub deposited_collateral: u64,     // Token amount deposited
    pub available_margin: i64,         // Free margin after positions

    // Position (0 = flat)
    pub base_size: i64,                // Positive = long, negative = short, 0 = flat
    pub quote_entry_amount: u128,      // Quote amount at entry (for PnL calc)
    pub last_cumulative_funding: i128, // Funding index at last settlement

    // Risk engine per-account state (from Percolator)
    pub pnl: i64,
    pub reserved_pnl: u64,            // Warming up profit
    pub fee_credits: i64,
    pub warmup_started_at_slot: u64,
    pub warmup_slope: u64,
    pub basis: i64,                    // A/K basis
    pub a_snapshot: u128,
    pub k_snapshot: i128,
    pub epoch_snapshot: u64,

    // Trigger orders
    pub open_trigger_orders: u8,       // Count of active trigger orders
    pub max_trigger_orders: u8,        // 8 per user per market

    pub bump: u8,
}
```

### TriggerOrder (PDA, per order)

Seeds: `[b"trigger", market.key().as_ref(), user.key().as_ref(), order_id.to_le_bytes()]`

```rust
#[account]
pub struct TriggerOrder {
    pub authority: Pubkey,
    pub market: Pubkey,
    pub order_id: u64,

    pub order_type: TriggerOrderType,
    pub side: Side,                    // Long or Short
    pub size: u64,                     // Base size
    pub trigger_price: u64,           // Price at which to execute
    pub leverage: u32,

    // For limit buys/sells
    pub reduce_only: bool,             // True = can only reduce existing position

    pub created_at: i64,
    pub expiry: i64,                   // 0 = GTC

    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum TriggerOrderType {
    Limit,         // Execute when price reaches trigger_price
    StopLoss,      // Close position when price goes against you
    TakeProfit,    // Close position when price hits target
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq)]
pub enum Side {
    Long,
    Short,
}
```

---

## 5. Instructions

### Protocol Admin (one-time setup)

#### `initialize_protocol`
- Creates Protocol singleton PDA
- Sets admin, fee config, minimum parameters
- Called once
- **Signer:** Protocol admin

#### `admin_pause(paused: bool)`
- Global emergency pause
- When paused: no new positions, no deposits. Withdrawals + closes still work.
- **Signer:** Protocol admin

#### `admin_update_protocol(params)`
- Update fee splits, min/max fee bounds
- **Signer:** Protocol admin

### Market Creation (Permissionless)

#### `create_market(params: CreateMarketParams)`
**Anyone can call this.** This is the core of the permissionless model.

```rust
pub struct CreateMarketParams {
    pub oracle_source: OracleSource,  // PerkOracle
    pub max_leverage: u32,            // 1x-20x (100-2000)
    pub trading_fee_bps: u16,         // Within protocol min/max bounds
    pub initial_k: u128,              // Initial vAMM depth (min enforced)
}

// Accounts:
//   token_mint: Any SPL token (the base asset being traded)
//   collateral_mint: 6-decimal stablecoin (USDC/USDT/PYUSD)
//   oracle: PerkOracle PDA for this token
```

Steps:
1. Validate params (leverage bounds, fee bounds, k minimum)
2. Validate collateral_mint has exactly 6 decimals (Percolator math compatibility)
3. Reject mints with TransferFeeConfig extension (both base and collateral)
4. Verify PerkOracle exists for this token
5. Create Market PDA (seeds: `[b"market", token_mint, creator]`)
6. Create vault token account (holds collateral_mint tokens)
7. Initialize vAMM with initial_k and oracle peg price
8. Set `market.creator = signer` (earns 10% of all fees forever)
9. Market is immediately live for trading

**One market per token mint per creator.** Multiple creators can create markets for the same token with different parameters.

### User — Deposits/Withdrawals

#### `deposit(amount: u64)`
1. Check protocol not paused, market active
2. Transfer stablecoin collateral from user ATA → vault (transfer_checked for Token-2022 compat)
3. Accrue market, settle side effects, advance warmup
4. Update `user_position.deposited_collateral += amount`
5. Conservation invariant check

#### `withdraw(amount: u64)`
1. Accrue market, settle side effects, advance warmup
2. Check initial margin maintained after withdrawal (stricter than maintenance)
3. Transfer stablecoin collateral from vault → user ATA (market PDA as signer)
4. Update balances, conservation invariant check

### User — Trading

#### `open_position(side: Side, base_size: u64, leverage: u32, max_slippage_bps: u16)`
Market order execution via vAMM:

1. Check protocol not paused, market active
2. Settle user (funding, lazy liquidation check)
3. Validate leverage (1x to market's max)
4. Calculate required margin: `notional / leverage`
5. Check sufficient available margin
6. **Execute against vAMM:**
   - Going long: "swap" quote → base in virtual reserves
     - `new_base = base_reserve - base_size`
     - `new_quote = k / new_base`
     - `quote_spent = new_quote - quote_reserve`
   - Going short: swap base → quote
     - `new_base = base_reserve + base_size`
     - `new_quote = k / new_base`
     - `quote_received = quote_reserve - new_quote`
   - Update reserves
7. Check slippage: `|execution_price - oracle_price| / oracle_price <= max_slippage_bps`
8. Calculate trading fee: `notional * trading_fee_bps / 10000`
9. Split fee: 10% → creator fee account, 90% → protocol fee vault
10. Update position: base_size, quote_entry_amount, leverage
11. Update market: total_long/short_position, volume
12. Update A/K snapshots

#### `close_position` / `close_position_partial(base_size: u64)`
1. Settle user
2. Execute reverse trade against vAMM
3. Calculate PnL from entry vs exit quote amounts
4. Apply warmup rules + haircut (H) to profit
5. Apply trading fee on closing notional
6. Update position (reduce or zero)
7. Update market OI, A/K
8. Return freed margin to available

### Trigger Orders

#### `place_trigger_order(params: TriggerOrderParams)`
1. Validate: user has position (for stop/TP) or margin (for limit)
2. Check `open_trigger_orders < max_trigger_orders`
3. Reserve margin for limit orders
4. Create TriggerOrder PDA
5. Increment order counter

#### `cancel_trigger_order(order_id: u64)`
1. Verify owner
2. Release reserved margin
3. Close TriggerOrder account (rent back to user)
4. Decrement counter

#### `execute_trigger_order(order_id: u64)`
**Permissionless — anyone can call (cranker incentive)**
1. Read current oracle/vAMM price
2. Check trigger condition met:
   - Limit Long: price <= trigger_price
   - Limit Short: price >= trigger_price
   - Stop Loss Long: price <= trigger_price
   - Stop Loss Short: price >= trigger_price
   - Take Profit Long: price >= trigger_price
   - Take Profit Short: price <= trigger_price
3. Execute the trade via vAMM (same as open/close_position)
4. Small incentive fee to caller (0.01% of notional or minimum 1000 lamports)
5. Close TriggerOrder account

### Maintenance (Permissionless)

#### `liquidate(user: Pubkey)`
Anyone can call:
1. Settle target user (funding, PnL)
2. Check below maintenance margin
3. Close position via vAMM
4. Liquidation fee (1% of notional):
   - 50% → liquidator (caller incentive)
   - 50% → market insurance fund
5. If account deficit → socialize via A/K
6. Update market state

#### `crank_funding`
Anyone can call:
1. Check funding period elapsed
2. Calculate funding rate:
   - `premium = (vamm_mark_price - oracle_price) / oracle_price`
   - `funding_rate = clamp(premium, -cap, +cap)`
   - Positive: longs pay shorts. Negative: shorts pay longs.
3. Update cumulative funding indices
4. Individual accounts settle lazily on next interaction

#### `update_amm()`
Anyone can call:
1. Read oracle price
2. Adjust peg_multiplier to re-anchor vAMM mark price toward oracle
3. Prevents vAMM price from drifting too far from reality
4. Small incentive to caller

---

## 6. vAMM Engine

### How It Works

The vAMM is a **virtual** constant-product AMM. There are no actual token reserves — it's pure math that determines execution prices based on supply/demand.

```
base_reserve * quote_reserve = k (invariant)
mark_price = (quote_reserve * peg_multiplier) / base_reserve
```

### Opening a Long Position
```
User wants to go long 10 SOL:

Before: base = 1000, quote = 1000, k = 1,000,000, peg = 150
Mark price = (1000 * 150) / 1000 = $150

After buying 10 base:
new_base = 1000 - 10 = 990
new_quote = 1,000,000 / 990 = 1010.10
quote_cost = 1010.10 - 1000 = 10.10
effective_price = 10.10 * 150 / 10 = $151.51 (slippage!)

Mark price after = (1010.10 * 150) / 990 = $153.04
```

### Key Properties
- **Slippage is natural** — larger trades move the price more, just like a real AMM
- **k determines depth** — higher k = less slippage = more liquid market
- **No LPs needed** — the vAMM provides infinite liquidity (at a cost of slippage)
- **Oracle peg** — `peg_multiplier` keeps the vAMM anchored to reality
- **Self-balancing** — funding rate incentivizes the minority side, re-centering OI

### vAMM vs Order Book — Why vAMM

| | vAMM | Order Book |
|---|---|---|
| Liquidity | Instant, always available | Needs market makers |
| Permissionless | Anyone creates a market, immediately tradeable | Dead without MM bots |
| Complexity | Simple math | Slab structures, matching engine |
| Build time | Fast | Slow |
| Price discovery | Oracle-anchored | Book-driven |
| Best for | Long-tail tokens, memecoins | Major pairs with deep liquidity |

For permissionless markets where any random memecoin can have perps, vAMM is the only viable option. You can't bootstrap an order book for $BONK-PERP.

### k Adjustment
- Market creator sets initial k (determines initial depth)
- k can grow organically: as more collateral enters the vault, k can increase proportionally
- This means liquidity depth grows with usage — self-reinforcing

### Peg Updates
- `update_amm()` adjusts `peg_multiplier` to keep mark price near oracle
- Called periodically by cranker or any user
- Prevents vAMM divergence during volatile moves

---

## 7. Risk Engine

Ported from Perk. These mechanisms are what make the protocol safe without human intervention.

### H — Haircut Ratio (Exit Fairness)
```
Residual = max(0, Vault_Balance - Total_Deposited_Capital - Insurance)

            min(Residual, Total_Matured_Profit)
H = ────────────────────────────────────────────
              Total_Matured_Profit
```
- H = 1: fully backed, all profit is real
- H < 1: stressed, profit is proportionally reduced
- **Deposited capital is NEVER haircut** — flat users always safe
- Self-healing: as losses settle or new deposits come in, H recovers

### A/K — Overhang Clearing (No ADL)
```
effective_position(i) = floor(basis_i * A / a_snapshot_i)
pnl_delta(i) = floor(|basis_i| * (K - k_snapshot_i) / (a_snapshot_i * POS_SCALE))
```
- Bankrupt liquidation → A decreases → everyone on that side shrinks equally
- Deficit socialization → K shifts → everyone absorbs equal per-unit loss
- **No individual is singled out. No ADL queue. O(1) per account.**

### Three-Phase Recovery (Fully Autonomous)
1. **DrainOnly** — A drops below threshold, no new OI on that side
2. **ResetPending** — OI hits zero, snapshot K, reset A, increment epoch
3. **Normal** — side reopens

No admin intervention. No governance vote. The math just works.

### Warmup Window (Anti-Oracle-Manipulation)
- New profit enters `reserved_pnl` (locked)
- Converts to matured profit linearly over `warmup_period_slots`
- Prevents: pump oracle → open position → claim profit → dump
- **Patched:** liquidation path correctly resets warmup slope (our bug find, issue #22)

### Margin Calculations
```
Initial margin = notional / leverage
Maintenance margin = notional * maintenance_margin_bps / 10000
Margin ratio = (collateral + unrealized_pnl) / notional

Liquidation when: margin_ratio < maintenance_margin_bps / 10000
```

---

## 8. Fee System

### Fee Flow

```
Trade executes → trading_fee = notional * trading_fee_bps / 10000

Fee split:
├── 10% → Market Creator (creator_fee_account)
└── 90% → Protocol (protocol_fee_vault)

Liquidation → liquidation_fee = notional * liquidation_fee_bps / 10000
├── 50% → Liquidator (incentive)
└── 50% → Market Insurance Fund

Trigger order execution → execution_fee = 0.01% of notional
└── 100% → Executor (cranker incentive)
```

### Example

Market creator sets trading fee at 0.1% (10 bps):
- $10,000 notional trade
- Total fee: $10
- Creator earns: $1 (10%)
- Protocol earns: $9 (90%)

If that market does $1M daily volume:
- Creator earns: $100/day → $3,000/month **passively, forever**
- Protocol earns: $900/day → $27,000/month

### Fee Bounds
- Minimum trading fee: 3 bps (0.03%) — floor set by protocol
- Maximum trading fee: 100 bps (1%) — ceiling to protect traders
- Liquidation fee: 100 bps (1%) — fixed, not configurable
- Creator sets their fee within these bounds at market creation time (immutable after)

### Revenue at Scale

| Total Platform Volume | Protocol Revenue/Day | Protocol Revenue/Month |
|---|---|---|
| $1M | $540 | $16,200 |
| $10M | $5,400 | $162,000 |
| $100M | $54,000 | $1,620,000 |
| $1B | $540,000 | $16,200,000 |

Assuming average 0.06% blended fee, 90% protocol share.

---

## 9. Oracle Integration

### PerkOracle System

**PerkOracle** is a custom oracle built for permissionless markets. The cranker aggregates prices from multiple sources, validates consensus via divergence checks, and writes to on-chain PDA accounts.

**Key properties:**
- Fail-closed: if sources disagree beyond `MAX_DIVERGENCE_PCT` (5%), oracle freezes
- Minimum 2 price sources required per update — averaged with divergence rejection
- Anyone can initialize oracles for any SPL token (including Token-2022) by paying rent — no admin approval needed
- One oracle per token mint, deterministic PDA: `[b"perk_oracle", token_mint]`
- See `PERK-ORACLE-SPEC.md` for full specification

### Oracle Selection
- All markets use PerkOracle (Pyth Pull and DexPool deferred to v2)
- Oracle PDA is derived from `token_mint` — validated on-chain during `create_market`
- Oracle authority (cranker) must be authorized by protocol admin

### Price Validation
- Cranker: median of Jupiter + Birdeye prices, reject if divergence > 5%
- On-chain: staleness check, circuit breaker, fallback oracle support
- Oracle writes update `price`, `confidence`, `last_update_ts`, `num_sources`

### Price Scaling
- All prices: u64, 6 decimal places (matches collateral decimals)
- Position sizes: u128 (POS_SCALE = 10^6)
- Collateral: always 6 decimals (USDC/USDT/PYUSD)

---

## 10. Trigger Orders (Limit/Stop)

Since we use a vAMM (not an order book), traditional limit orders don't sit on a book. Instead, we use **trigger orders** — on-chain orders that execute when the oracle/mark price crosses a threshold.

### Order Types

**Limit Order (Open Position)**
- "Buy SOL-PERP long when price drops to $140"
- Stored on-chain, margin reserved
- When oracle price <= $140 → anyone can call `execute_trigger_order` → opens long via vAMM

**Stop Loss (Close Position)**
- "Close my long if price drops to $130"
- When oracle price <= $130 → executes close via vAMM
- `reduce_only = true`

**Take Profit (Close Position)**
- "Close my long when price hits $170"
- When oracle price >= $170 → executes close via vAMM
- `reduce_only = true`

### Execution Incentive
- Anyone who calls `execute_trigger_order` successfully earns 0.01% of notional
- This incentivizes crankers/bots to watch and execute orders
- User pays this fee from their margin

### How It Differs From a Traditional Limit Order
- Traditional: sits on the book, provides liquidity, filled by a counterparty
- Trigger: sits in an account, executes as a market order via vAMM when price crosses
- Slightly worse execution (vAMM slippage) but works for any token, any market, no market makers needed

### Trigger Order Limits
- Max 8 trigger orders per user per market
- GTC or expiry timestamp
- Can cancel anytime (margin released, rent returned)

---

## 11. Safety Rails

### Global (Protocol Level)

| Safeguard | Detail |
|---|---|
| Global pause | Admin can freeze all markets (emergency only) |
| Withdrawals always work | Even when paused, users can close + withdraw |
| Fee bounds | Creators can't set predatory fees (3-100 bps) |
| Min liquidity | Markets must have minimum k to prevent manipulation |

### Per-Market (Set at Creation, Immutable)

| Safeguard | Detail |
|---|---|
| Max leverage | Creator sets 1x-20x, can't change after |
| Maintenance margin | 5% default, protects against sudden moves |
| Warmup window | PnL matures over time, blocks oracle manipulation |
| Insurance fund | Per-market, funded by 50% of liquidation fees |
| Three-phase recovery | Markets self-heal from cascading liquidations |

### Economic Safeguards

| Safeguard | Detail |
|---|---|
| Haircut (H) | Profit scaled down when vault is stressed — nobody gets more than exists |
| A/K socialization | Deficit spread equally, no ADL picks on individuals |
| Funding rate cap | ±0.1% per period, prevents runaway costs |
| Oracle staleness | Rejects stale prices, halts trading if oracle dies |



---

## 12. TypeScript SDK

### Package: `@Perk/sdk`

```typescript
class PerkClient {
  constructor(connection: Connection, wallet: Wallet, programId: PublicKey)

  // Protocol (admin only)
  initializeProtocol(params: InitProtocolParams): Promise<TxSig>
  pauseProtocol(paused: boolean): Promise<TxSig>

  // Market Creation (permissionless)
  createMarket(params: CreateMarketParams): Promise<{ tx: TxSig, market: PublicKey }>
  getMarkets(): Promise<Market[]>
  getMarket(tokenMint: PublicKey): Promise<Market>

  // User — Deposits
  deposit(market: PublicKey, amount: number): Promise<TxSig>
  withdraw(market: PublicKey, amount: number): Promise<TxSig>

  // User — Trading
  openLong(market: PublicKey, size: number, leverage: number, maxSlippage?: number): Promise<TxSig>
  openShort(market: PublicKey, size: number, leverage: number, maxSlippage?: number): Promise<TxSig>
  closePosition(market: PublicKey): Promise<TxSig>
  closePositionPartial(market: PublicKey, size: number): Promise<TxSig>

  // User — Trigger Orders
  placeLimitOrder(params: TriggerOrderParams): Promise<TxSig>
  placeStopLoss(market: PublicKey, triggerPrice: number): Promise<TxSig>
  placeTakeProfit(market: PublicKey, triggerPrice: number): Promise<TxSig>
  cancelTriggerOrder(market: PublicKey, orderId: number): Promise<TxSig>

  // Read
  getPosition(market: PublicKey): Promise<UserPosition | null>
  getMarkPrice(market: PublicKey): Promise<number>
  getOraclePrice(market: PublicKey): Promise<number>
  getFundingRate(market: PublicKey): Promise<FundingInfo>
  getTriggerOrders(market: PublicKey): Promise<TriggerOrder[]>
  getMarketStats(market: PublicKey): Promise<MarketStats>

  // Cranker (permissionless)
  liquidate(market: PublicKey, user: PublicKey): Promise<TxSig>
  crankFunding(market: PublicKey): Promise<TxSig>
  executeTriggerOrder(market: PublicKey, order: PublicKey): Promise<TxSig>
  updateAmm(market: PublicKey): Promise<TxSig>
}

// Helpers
function calculateLiquidationPrice(entry: number, leverage: number, side: Side): number
function calculatePnl(entryQuote: number, exitQuote: number): number
function calculateMarginRequired(notional: number, leverage: number): number
function estimateSlippage(baseSize: number, baseReserve: number, quoteReserve: number): number
function calculateFundingPayment(position: UserPosition, market: Market): number
```

---

## 13. Cranker Bots

### Architecture
- Single Node.js process, 4 async loops
- Uses `@Perk/sdk`
- Dedicated keypair funded with SOL
- **Fully permissionless** — anyone can run these for profit

### Loop 1: Funding Rate Cranker
```
Every 60 seconds:
  For each market:
    If funding period elapsed → call crank_funding()
    Earn: good citizen points (no direct fee, but keeps market healthy)
```

### Loop 2: Backup Liquidation Bot
```
Every 2 seconds:
  For each market:
    Fetch all UserPositions with open positions
    For each position below maintenance margin:
      Call liquidate() → earn 50% of liquidation fee
```

### Loop 3: Trigger Order Executor
```
Every 1 second:
  For each market:
    Get current oracle price
    Fetch all TriggerOrders
    For each order where trigger condition met:
      Call execute_trigger_order() → earn 0.01% execution fee
```

### Loop 4: AMM Peg Updater
```
Every 10 seconds:
  For each market:
    If |mark_price - oracle_price| / oracle_price > 0.5%:
      Call update_amm() → re-peg vAMM to oracle
```

### Why Anyone Can Run These
- All cranker instructions are permissionless
- Liquidators earn real money (50% of liq fee)
- Trigger executors earn real money (0.01% of notional)
- Funding crankers keep markets healthy (social good + future token rewards)
- We run the first set, but anyone can compete

---

## 14. Frontend

### Tech Stack
- Next.js 14 (App Router)
- TradingView Advanced Charts (charting_library) — full indicators, drawing tools, multi-timeframe
- `@solana/wallet-adapter`
- `@Perk/sdk`
- Tailwind CSS (no CSS-in-JS runtime)
- Jupiter Token List + Helius DAS (token logos + metadata)
- Real-time: Pyth Hermes WebSocket + Solana account subscriptions (NO polling)
- **See `DESIGN.md` for all UI/UX rules — every sub-agent must read it**

### Pages

#### `/` — Market Explorer (Landing)
```
┌─────────────────────────────────────────────────────────┐
│  Perk                         [Connect Wallet]     │
│  Permissionless Perpetual Futures on Solana               │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  [+ Create Market]                                        │
│                                                           │
│  Live Markets                                             │
│  ─────────────                                            │
│  Token       Price      24h Vol     OI        Leverage    │
│  SOL-PERP    $150.32    $2.1M      $890K     20x  [Trade]│
│  BONK-PERP   $0.00001   $450K      $120K     10x  [Trade]│
│  WIF-PERP    $1.23      $780K      $340K     15x  [Trade]│
│  JUP-PERP    $0.89      $190K      $45K      10x  [Trade]│
│                                                           │
│  Total Volume: $3.52M    Total OI: $1.39M                │
│  Markets: 4              Creators Earning: $352/day       │
└─────────────────────────────────────────────────────────┘
```

#### `/trade/[token]` — Trading View
```
┌─────────────────────────────────────────────────────────┐
│  Perk    SOL-PERP   $150.32   +2.4%   [Markets ↩] │
│  Funding: +0.003%/1h   OI: $890K   24h Vol: $2.1M       │
├────────────────────────────────┬────────────────────────┤
│                                │                          │
│                                │  ┌─ Trade Panel ───────┐ │
│    TradingView Chart           │  │ [Market] [Limit]    │ │
│    (SOL/USD live)              │  │ [Stop] [TP]         │ │
│                                │  │                      │ │
│                                │  │ [Long]    [Short]   │ │
│                                │  │                      │ │
│                                │  │ Size: [______] SOL  │ │
│                                │  │ Leverage: [===] 5x  │ │
│                                │  │                      │ │
│                                │  │ --- Limit Only ---  │ │
│                                │  │ Trigger: [___] USD  │ │
│                                │  │                      │ │
│                                │  │ Entry: ~$150.32     │ │
│                                │  │ Liq:   ~$125.30     │ │
│                                │  │ Fee:   $0.75        │ │
│                                │  │ Slippage: ~0.12%    │ │
│                                │  │                      │ │
│                                │  │ [Open Long ───────] │ │
│                                │  └──────────────────────┘ │
│                                │                          │
│                                │  ┌─ Deposit ──────────┐ │
│                                │  │ Balance: 50.2 SOL   │ │
│                                │  │ In Vault: 20.0 SOL  │ │
│                                │  │ [Deposit] [Withdraw]│ │
│                                │  └──────────────────────┘ │
├────────────────────────────────┴────────────────────────┤
│  Positions                                                │
│  ─────────                                                │
│  SOL-PERP  LONG  5x  Entry: $148.50  Size: 10 SOL       │
│  PnL: +$18.20 (+1.2%)  Liq: $125.30  [Close] [TP] [SL] │
├─────────────────────────────────────────────────────────┤
│  Trigger Orders                                           │
│  ──────────────                                           │
│  Limit Long  $140.00  5 SOL  5x  GTC          [Cancel]  │
│  Stop Loss   $130.00  close all                [Cancel]  │
│  Take Profit $170.00  close all                [Cancel]  │
├─────────────────────────────────────────────────────────┤
│  Market Info                                              │
│  Creator: 7Wx...NPdB   Creator Earned: $1,204            │
│  Fee: 0.10%   Max Leverage: 20x   Insurance: $4,520      │
└─────────────────────────────────────────────────────────┘
```

#### `/launch` — Create Market
```
┌─────────────────────────────────────────────────────────┐
│  Perk — Launch a Market                             │
├─────────────────────────────────────────────────────────┤
│                                                           │
│  Token Mint: [________________________________] [Search] │
│  Detected: BONK (Bonk) — Raydium pool found ✓            │
│                                                           │
│  Oracle Source: (●) DEX Pool  ( ) Pyth Feed              │
│  Pool: Raydium BONK/USDC — $2.3M liquidity ✓            │
│                                                           │
│  Max Leverage: [====|=========] 10x                      │
│  Trading Fee:  [==|===========] 0.10% (10 bps)           │
│  Initial Depth (k): [=====|======] Medium                │
│                                                           │
│  ┌─ Revenue Estimate ─────────────────────────────────┐  │
│  │ At $100K daily volume:                              │  │
│  │ Your earnings: $10/day ($300/month)                 │  │
│  │ You earn 10% of all trading fees. Forever.          │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  [Create Market — costs ~0.05 SOL]                       │
│                                                           │
└─────────────────────────────────────────────────────────┘
```

### Design Principles
- Dark mode only
- Minimal, functional — traders don't care about pretty
- Monospace for numbers
- Green = long/profit, Red = short/loss
- Fast — no unnecessary animations or transitions
- Show the creator fee prominently — it's the growth engine

---

## 15. Deployment

### Program Deployment
```bash
# Devnet
anchor build
anchor deploy --provider.cluster devnet

# Mainnet
anchor build --verifiable
anchor deploy --provider.cluster mainnet-beta
# ~3-5 SOL deployment cost
```

### Frontend
```bash
cd app/
vercel --prod
```

### Cranker
```bash
cd cranker/
node src/index.js
# Or PM2: pm2 start src/index.js --name Perk-cranker
```

### Infrastructure
- **Deployer keypair** — funded with SOL for program deployment
- **Protocol admin wallet** — holds global pause authority
- **Cranker keypair** — separate, funded with SOL for tx fees
- **Domain** — perk.fund (Cloudflare)



---

## Repo Structure

```
Perk/
├── ARCHITECTURE.md              # This file
├── programs/
│   └── Perk/
│       ├── Cargo.toml
│       └── src/                 # Anchor program
├── sdk/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts
│       ├── client.ts            # PerkClient
│       ├── types.ts
│       └── utils.ts
├── cranker/
│   ├── package.json
│   └── src/
│       ├── index.ts             # Main (4 loops)
│       ├── liquidator.ts
│       ├── funding.ts
│       ├── trigger-executor.ts
│       └── peg-updater.ts
├── app/
│   ├── package.json
│   ├── next.config.js
│   └── src/
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx         # Market explorer
│       │   ├── trade/
│       │   │   └── [token]/
│       │   │       └── page.tsx # Trading view
│       │   └── launch/
│       │       └── page.tsx     # Create market
│       ├── components/
│       │   ├── Chart.tsx
│       │   ├── TradePanel.tsx
│       │   ├── Positions.tsx
│       │   ├── TriggerOrders.tsx
│       │   ├── DepositWithdraw.tsx
│       │   ├── MarketStats.tsx
│       │   ├── MarketExplorer.tsx
│       │   ├── CreateMarket.tsx
│       │   └── WalletButton.tsx
│       ├── hooks/
│       │   ├── usePerk.ts
│       │   ├── usePosition.ts
│       │   ├── useMarkets.ts
│       │   └── usePythPrice.ts
│       └── lib/
│           └── Perk.ts
├── tests/
│   └── Perk.ts            # Anchor test suite
├── Anchor.toml
├── Cargo.toml
└── package.json
```

---

## Constants

```rust
// Protocol
pub const CREATOR_FEE_SHARE_BPS: u16 = 1000;      // 10% of fees to creator
pub const MIN_TRADING_FEE_BPS: u16 = 3;            // 0.03% minimum
pub const MAX_TRADING_FEE_BPS: u16 = 100;          // 1% maximum
pub const LIQUIDATION_FEE_BPS: u16 = 100;          // 1%
pub const LIQUIDATOR_SHARE_BPS: u16 = 5000;        // 50% of liq fee to liquidator
pub const TRIGGER_EXECUTION_FEE_BPS: u16 = 1;      // 0.01% to executor

// Market defaults
pub const DEFAULT_MAX_LEVERAGE: u32 = 2000;         // 20x
pub const MAINTENANCE_MARGIN_BPS: u16 = 500;        // 5%
pub const DEFAULT_FUNDING_PERIOD: u32 = 3600;       // 1 hour
pub const FUNDING_RATE_CAP_BPS: u16 = 10;           // 0.1% per period
pub const WARMUP_PERIOD_SLOTS: u64 = 1000;          // ~400 seconds
pub const MAX_TRIGGER_ORDERS_PER_USER: u8 = 8;

// Oracle
pub const ORACLE_STALENESS_SECONDS: u32 = 30;
pub const ORACLE_CONFIDENCE_BPS: u16 = 200;         // 2%
pub const AMM_PEG_THRESHOLD_BPS: u16 = 50;          // 0.5% drift triggers re-peg

// Precision
pub const PRICE_SCALE: u64 = 1_000_000;             // 6 decimals
pub const K_SCALE: u128 = 1_000_000_000_000;        // 12 decimals for k precision
pub const PEG_SCALE: u128 = 1_000_000;              // 6 decimals
```

---

## Summary: What Makes Us Different

| Feature | Perk (Us) | Drift | Jupiter Perps | Perpolator |
|---|---|---|---|---|
| Permissionless markets | ✅ Anyone | ❌ Governance | ❌ Curated | ✅ Anyone |
| Creator fees | ✅ 10% forever | ❌ | ❌ | ✅ 8% |
| Risk engine | Percolator H/A/K | DLOB + AMM | Oracle-based | Basic vAMM |
| No ADL | ✅ A/K socialization | ❌ Has ADL | ❌ | ❌ |
| Self-healing markets | ✅ Three-phase | ❌ | ❌ | ❌ |
| Warmup anti-manipulation | ✅ | ❌ | ❌ | ❌ |
| Stablecoin collateral | ✅ USDC/USDT/PYUSD | ✅ USDC | ✅ | Coin-margined |
| Mainnet | ✅ Live | ✅ Live | ✅ Live | ❌ Devnet |

Our edge: **Anatoly's risk math** (the best in the game) + **permissionless markets** (the pump.fun model) + **stablecoin-margined** (no decimal mismatch issues) + **OtterSec verified builds** + **117/117 Kani formal proofs** + **6 rounds of independent security review**.
