# Architecture

Perk is an Anchor program on Solana with a TypeScript SDK, off-chain crankers, and a Next.js frontend. All trading logic is on-chain — no off-chain matching, no centralized sequencer.

---

## vAMM Engine

The virtual AMM is a constant-product market maker with no real token reserves. It's pure math that determines execution prices.

### Core Formula

```
base_reserve × quote_reserve = k    (invariant)
mark_price = (quote_reserve × peg_multiplier) / base_reserve
```

### Execution

When a trader goes long (buys base):

```
new_base    = base_reserve - base_size
new_quote   = k / new_base
quote_cost  = new_quote - quote_reserve
exec_price  = (quote_cost × peg_multiplier) / base_size
```

The price moves with each trade. Larger trades experience more slippage — this is by design. It naturally limits risk without requiring position size caps.

### Key Properties

| Property | Detail |
|---|---|
| No LPs required | The vAMM provides virtual liquidity — anyone can trade immediately |
| Slippage is natural | Larger trades move the price more, like a real AMM |
| k determines depth | Higher k = less slippage = deeper market |
| Oracle-pegged | `peg_multiplier` anchors the vAMM to the oracle price |
| Self-balancing | Funding rates incentivize the minority side |

### Peg Updates

The `update_amm()` instruction adjusts `peg_multiplier` to keep the mark price near the oracle price. Called periodically by the cranker or any user. If the mark price drifts more than 0.5% from the oracle, a peg update is triggered.

Peg updates have a cooldown of 100 slots (~40 seconds) to prevent manipulation.

---

## Risk Engine

The risk engine is a full port of [Anatoly Yakovenko's Percolator](https://github.com/aeyakovenko/percolator). It handles three problems autonomously: exit fairness, deficit socialization, and market recovery.

### H — Haircut Ratio

When a vault is stressed (total liabilities exceed assets), profitable traders can't all withdraw their full profit. The haircut ratio ensures fair exit:

```
Residual = max(0, vault_balance - total_deposited_capital - insurance)

            min(Residual, total_matured_profit)
H = ────────────────────────────────────────────
              total_matured_profit
```

- H = 1: fully backed, all profit is real
- H < 1: stressed, profit is scaled down proportionally
- The haircut mechanism is designed to protect deposited capital — only unrealized profit is subject to haircuts when the vault is stressed

H self-heals: as losses settle or new deposits arrive, it recovers toward 1.

### A/K — Overhang Clearing

When a liquidation creates a deficit (position loss > collateral), the A/K mechanism socializes it across all positions on the same side:

```
effective_position(i) = floor(basis_i × A / a_snapshot_i)
pnl_delta(i) = floor(|basis_i| × (K - k_snapshot_i) / (a_snapshot_i × POS_SCALE))
```

Key properties:
- **No individual is singled out.** Everyone on the affected side absorbs an equal per-unit loss.
- **No ADL (auto-deleveraging).** Unlike other protocols, Perk doesn't force-close profitable positions.
- **O(1) per account.** Settlement is lazy — each account computes its share on next interaction.

### Three-Phase Recovery

When cascading liquidations stress one side of the market, recovery is fully autonomous:

1. **DrainOnly** — A drops below threshold. No new positions on that side. Existing positions can only close.
2. **ResetPending** — Open interest reaches zero. State is snapshotted, A resets, epoch increments.
3. **Normal** — Side reopens for trading.

Recovery is fully autonomous — no admin intervention or governance vote required.

### Warmup Window

New profit doesn't mature instantly. It enters `reservedPnl` and converts to matured profit linearly over `warmup_period_slots` (default: 1000 slots ≈ 400 seconds).

This blocks a specific attack: manipulate the oracle → open position → claim paper profit → dump. With warmup, the profit is locked long enough for the manipulation to be detected or self-correct.

---

## Account Structure

All state lives on-chain as Anchor accounts.

### Protocol (singleton PDA)

Seeds: `[b"protocol"]`

Global configuration: admin, fee parameters, pause state, market count. One per program deployment.

### Market (per token PDA)

Seeds: `[b"market", token_mint]`

Contains all market state:
- vAMM reserves (`base_reserve`, `quote_reserve`, `k`, `peg_multiplier`)
- Risk engine state (`long_a/k_index`, `short_a/k_index`, side states, epochs). Note: `haircut_numerator/denominator` are legacy fields — the haircut ratio is computed dynamically from vault state
- Market parameters (`max_leverage`, `trading_fee_bps`, `maintenance_margin_bps`)
- Oracle configuration (`oracle_source`, `oracle_address`, fallback oracle)
- Funding state (`last_funding_time`). Note: `cumulative_long_funding` and `cumulative_short_funding` are legacy fields — funding is applied through per-slot K-coefficient accumulation
- Aggregate tracking (`total_long_position`, `total_short_position`, `c_tot`, `pnl_pos_tot`)
- Fee accumulators (`creator_claimable_fees`, `protocol_claimable_fees`)
- Insurance fund (`insurance_fund_balance`, epoch caps, floor)

### UserPosition (per user per market PDA)

Seeds: `[b"position", market, user]`

Per-user position state:
- Collateral and margin (`deposited_collateral`)
- Position (`base_size`, `quote_entry_amount`)
- Risk engine snapshots (`basis`, `a_snapshot`, `k_snapshot`, `epoch_snapshot`)
- PnL state (`pnl`, `reserved_pnl`, warmup fields)
- Funding tracking (`last_cumulative_funding`)
- Trigger order count (`open_trigger_orders`, `next_order_id`)

### TriggerOrder (per order PDA)

Seeds: `[b"trigger", market, user, order_id]`

Order details: type, side, size, trigger price, leverage, reduce_only flag, expiry.

### PerkOraclePrice (per token PDA)

Seeds: `[b"perk_oracle", token_mint]`

Oracle state: price, confidence, timestamp, EMA, source count, staleness config, freeze flag. See [PerkOracle](06-perkoracle.md).

---

## On-Chain Program

Built with Anchor 0.32.1. Program structure:

```
programs/perk-protocol/src/
├── lib.rs                    # Instruction dispatch
├── constants.rs              # All protocol constants
├── errors.rs                 # Error codes
├── state/                    # Account definitions
│   ├── protocol.rs
│   ├── market.rs
│   ├── user_position.rs
│   ├── trigger_order.rs
│   └── perk_oracle.rs
├── instructions/             # Instruction handlers
│   ├── initialize_protocol.rs
│   ├── create_market.rs
│   ├── deposit.rs / withdraw.rs
│   ├── open_position.rs / close_position.rs
│   ├── place_trigger_order.rs / cancel_trigger_order.rs / execute_trigger_order.rs
│   ├── liquidate.rs
│   ├── crank_funding.rs
│   ├── update_amm.rs
│   └── admin_*.rs
└── engine/                   # Core math
    ├── vamm.rs               # vAMM constant-product math
    ├── risk.rs               # H, A/K, three-phase recovery
    ├── funding.rs            # Funding rate calculation
    ├── margin.rs             # Margin requirements
    ├── liquidation.rs        # Liquidation logic
    ├── oracle.rs             # Oracle abstraction + fallback
    ├── warmup.rs             # PnL warmup window
    └── wide_math.rs          # u256/i128 arithmetic
```

### Key Instructions

| Instruction | Permissionless | Description |
|---|---|---|
| `create_market` | ✅ | Create a market for any SPL token |
| `deposit` / `withdraw` | ✅ | Move collateral in/out of vault |
| `open_position` | ✅ | Open long or short via vAMM |
| `close_position` | ✅ | Close full or partial position |
| `place_trigger_order` | ✅ | Place limit/stop/TP order |
| `execute_trigger_order` | ✅ | Execute triggered order (earns fee) |
| `liquidate` | ✅ | Liquidate underwater position (earns fee) |
| `crank_funding` | ✅ | Update funding rate indices |
| `update_amm` | ✅ | Re-peg vAMM to oracle |
| `admin_pause` | ❌ Admin | Emergency global pause |

---

## Cranker System

Crankers are off-chain bots that call permissionless instructions. Anyone can run them. Perk runs the initial set, but the system is designed for competition.

### Cranker Loops

| Loop | Frequency | What It Does | Incentive |
|---|---|---|---|
| Funding | Each funding period | Calls `crank_funding()` on each market | None (protocol health) |
| Liquidation | Frequently | Scans positions, liquidates underwater ones | 50% of liquidation fee |
| Trigger Executor | Near real-time | Checks trigger conditions, executes orders | 0.01% of notional |
| Peg Updater | Periodically | Re-pegs vAMM when mark drifts >0.5% from oracle | None (protocol health) |
| Oracle (PerkOracle) | Near real-time | Posts aggregated prices from Jupiter + Birdeye | None (required for trading) |

### Architecture

Each cranker is a Node.js process using `@perk/sdk`. The `PerkCranker` and `PerkOracleCranker` classes handle the loops:

```typescript
import { PerkCranker, PerkOracleCranker } from "@perk/sdk";

const cranker = new PerkCranker({ connection, wallet, /* ... */ });
const oracleCranker = new PerkOracleCranker({ connection, wallet, /* ... */ });
```

Crankers hold minimal SOL for transaction fees (~0.5–1 SOL). They have no admin privileges and can't access vault funds. If a cranker goes offline, anyone else can step in — all instructions are permissionless.

---

## Price Scaling

All prices on-chain use a scale of `1e6` (6 decimal places, matching USDC precision).

```
$150.32 on-chain → 150_320_000
$0.00001832 on-chain → 18
```

Position sizes use token-native decimals. The SDK provides `priceToNumber()` and `numberToPrice()` helpers.

---

## Constants

```rust
PRICE_SCALE               = 1_000_000      // 6 decimal price precision
POS_SCALE                 = 1_000_000      // Position scaling
K_SCALE                   = 1e12           // vAMM k precision
CREATOR_FEE_SHARE_BPS     = 1000           // 10%
MIN_TRADING_FEE_BPS       = 3              // 0.03%
MAX_TRADING_FEE_BPS       = 100            // 1%
LIQUIDATION_FEE_BPS       = 100            // 1%
MAINTENANCE_MARGIN_BPS    = 500            // 5%
DEFAULT_FUNDING_PERIOD     = 3600          // 1 hour
FUNDING_RATE_CAP_BPS      = 10             // 0.1% per period
WARMUP_PERIOD_SLOTS       = 1000           // ~400 seconds
MAX_TRIGGER_ORDERS        = 8              // Per user per market
ORACLE_STALENESS_SECONDS  = 15             // Max age for oracle prices
INSURANCE_EPOCH_CAP_BPS   = 3000           // 30% max epoch payout
```

See `constants.rs` (on-chain) and `constants.ts` (SDK) for the full list.
