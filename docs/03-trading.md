# Trading

> **⚠️ Risk Warning:** Leveraged trading carries significant risk. You can lose your entire deposited collateral. Perk is experimental software. Never trade more than you can afford to lose.

Perk is a perpetual futures protocol. You trade synthetic positions against a virtual AMM — no counterparty matching, no order book. This document covers how trading works.

---

## Positions

A position represents your leveraged exposure to a token's price.

**Long:** You profit when the price goes up. Your `baseSize` is positive.

**Short:** You profit when the price goes down. Your `baseSize` is negative.

Positions are isolated per market. Your SOL-PERP position is independent of your BONK-PERP position. Each market has its own collateral vault.

---

## Leverage

Leverage ranges from 2x to 20x, configurable per market by the creator. The leverage you choose determines how much margin is required to open a position.

```
Required margin = notional value / leverage
```

At 10x leverage on a $1,000 notional position, you need $100 in collateral. The remaining $900 is "borrowed" via the vAMM's virtual liquidity.

Higher leverage means:
- Less margin required
- Higher liquidation risk (your liquidation price is closer to entry)
- Same PnL per dollar of price movement

The leverage value is encoded as an integer scaled by 100. So `500` = 5x, `2000` = 20x. The SDK handles this conversion.

---

## Collateral and Margin

**Deposited collateral** is the total amount you've put into a market's vault.

**Available margin** is what's not currently backing a position. This is what you can use to open new positions or withdraw.

**Margin ratio** determines your liquidation status:

```
margin_ratio = (collateral + unrealized_pnl) / notional_value
```

If your margin ratio falls below the maintenance margin requirement (5% by default), your position becomes liquidatable.

> **⚠️ Coin-margined compounding risk:** Because collateral is denominated in the same token you're trading, a price drop reduces both your position value and your collateral value simultaneously. This double exposure means liquidation can occur faster than on stablecoin-margined platforms.

---

## Mark Price vs Index Price

**Mark price** is the vAMM's current price. This is what you trade at.

```
mark_price = (quote_reserve × peg_multiplier) / base_reserve
```

**Index price** is the oracle price — the "real" market price from Pyth or PerkOracle.

The mark price can diverge from the index price during heavy trading. Two mechanisms keep them aligned:

1. **Peg updates** — the vAMM's peg multiplier is periodically adjusted to re-anchor the mark price toward the oracle price
2. **Funding rates** — traders on the side pushing the mark price away from the index pay a funding rate to the other side

---

## Liquidation

When a position's margin ratio drops below the maintenance margin (default 5%), it becomes eligible for liquidation.

### How It Works

1. Anyone can call `liquidate()` on an underwater position (permissionless)
2. The position is closed against the vAMM at the current mark price
3. A liquidation fee of 1% of notional value is charged:
   - 50% goes to the liquidator (incentive)
   - 50% goes to the market's insurance fund
4. If the position's loss exceeds its collateral (bad debt), the Percolator risk engine handles socialization via the A/K mechanism

### Liquidation Price

For a long position:

```
liq_price ≈ entry_price × (1 - 1/leverage × (1 - maintenance_margin_rate))
```

For a short:

```
liq_price ≈ entry_price × (1 + 1/leverage × (1 - maintenance_margin_rate))
```

The SDK provides `estimateLiquidationPrice()` for precise calculation including funding accrual.

### Safety Factor

The Percolator's warmup window prevents a specific attack: manipulating the oracle to create instant paper profit, then withdrawing before the price reverts. Unrealized profit enters a warmup period and matures linearly over ~400 seconds (1000 slots). During warmup, profit exists as `reservedPnl` — visible but not withdrawable.

---

## Trigger Orders

Since Perk uses a vAMM (not an order book), traditional limit orders don't exist. Instead, Perk has **trigger orders** — on-chain orders that execute as market orders when the oracle price crosses a threshold.

### Order Types

| Type | Trigger Condition | Use Case |
|---|---|---|
| **Limit** | Price reaches target | Open a position at a specific price |
| **Stop Loss** | Price moves against you | Automatically close to limit losses |
| **Take Profit** | Price hits your target | Automatically close to lock in gains |

### How They Work

1. You place a trigger order on-chain. For limit orders, margin is reserved.
2. The order sits in a `TriggerOrder` PDA account.
3. When the oracle price crosses the trigger price, anyone can call `executeTriggerOrder()`.
4. The order executes as a market trade against the vAMM.
5. The executor earns 0.01% of the notional value as an incentive fee.

### Constraints

- Maximum 8 trigger orders per user per market
- Orders can be GTC (good 'til cancelled) or have an expiry timestamp
- Stop loss and take profit orders are `reduce_only` — they can only close existing positions
- Cancel anytime to release reserved margin and reclaim account rent

### Execution Quality

Trigger orders execute at the vAMM's current price when triggered, not at the trigger price. This means:
- Execution price may differ from trigger price (vAMM slippage)
- In volatile markets, the gap can be larger
- This is inherent to the vAMM model — there's no order book to match against

---

## Funding Rates

Funding rates are periodic payments between longs and shorts. They keep the mark price (vAMM) aligned with the index price (oracle).

### Calculation

```
premium = (mark_price - index_price) / index_price
funding_rate = clamp(premium, -cap, +cap)
```

The cap is ±0.1% per funding period (default: 1 hour).

### Payment Direction

- **Mark price > index price:** Longs pay shorts (incentivizes shorts to bring price down)
- **Mark price < index price:** Shorts pay longs (incentivizes longs to bring price up)

### Settlement

Funding is settled lazily. The protocol tracks cumulative funding indices per market. When a user interacts with their position (open, close, deposit, withdraw), their pending funding is settled automatically. The cranker calls `crankFunding()` every funding period to update the market-level indices.

### Cost

At the maximum funding rate (0.1% per hour), holding a position costs 2.4% per day. In practice, funding rates are much smaller — typically a few basis points per hour.

---

## PnL Calculation

### Unrealized PnL

PnL is calculated based on the difference between your entry quote amount and the current value of your position at the mark price:

```
For a long position (base_size > 0):
  current_value = quote amount you'd receive closing at mark price
  unrealized_pnl = current_value - quote_entry_amount

For a short position (base_size < 0):
  current_value = quote amount you'd pay to close at mark price
  unrealized_pnl = quote_entry_amount - current_value
```

### Realized PnL

When you close (fully or partially), the PnL is realized. The Percolator applies:

1. **Warmup** — new profit enters warmup and matures over ~400 seconds
2. **Haircut (H)** — if the vault is stressed, matured profit is scaled down proportionally
3. **Funding** — any pending funding payments are settled

After these adjustments, realized profit is added to your available margin.

### Account Equity

```
equity = max(0, collateral + pnl - fee_debt)
```

Where `pnl` is the settled value (updated on-chain by the program) and `fee_debt` is `abs(min(0, fee_credits))`. The SDK exposes `accountEquity(position)` to compute this from the on-chain position account.
