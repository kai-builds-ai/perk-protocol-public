# Fees

Perk has four fee types: trading fees, liquidation fees, trigger execution fees, and the market creation fee. All fee parameters are transparent and enforced on-chain.

---

## Trading Fees

Charged on every trade (open and close) based on the notional value:

```
fee = notional_value × trading_fee_bps / 10,000
```

The trading fee rate is set by the market creator at creation time and is immutable. Because multiple creators can launch competing markets for the same token, fee parameters vary per market. Creators competing for the same token's trading volume have a direct incentive to offer lower fees — traders choose the market with the best terms.

| Parameter | Value |
|---|---|
| Minimum | 3 bps (0.03%) |
| Maximum | 100 bps (1%) |
| Suggested default | 30 bps (0.3%) — this is an SDK/UI suggestion, not a protocol-enforced default. The creator chooses. |

### Fee Split

Every trading fee is split:

| Recipient | Share | Description |
|---|---|---|
| Protocol | 90% | Perk protocol treasury |
| Market creator | 10% | Permanent revenue for the creator |

The creator's 10% share is hardcoded at `CREATOR_FEE_SHARE_BPS = 1000`. It cannot be changed.

### Example

A $10,000 notional trade on a market with 0.1% (10 bps) trading fee:

```
Total fee:     $10,000 × 0.001 = $10.00
Creator gets:  $10.00 × 10% = $1.00
Protocol gets: $10.00 × 90% = $9.00
```

### Fee Claims

Fees accumulate on-chain in the market account (`creatorClaimableFees`, `protocolClaimableFees`). The creator and protocol admin call `claimFees()` to withdraw to a token account.

---

## Creator Revenue

Market creators earn 10% of all trading fees on their market for the lifetime of the market. The creator address is set at market creation and cannot be changed.

### Revenue Examples

> *These are hypothetical examples for illustration only. Actual revenue depends entirely on market volume, which is not guaranteed. Markets may have zero volume.*

Assuming 0.1% (10 bps) trading fee:

| Daily Volume | Creator Revenue/Day | Creator Revenue/Month |
|---|---|---|
| $10,000 | $1 | $30 |
| $100,000 | $10 | $300 |
| $1,000,000 | $100 | $3,000 |
| $10,000,000 | $1,000 | $30,000 |

---

## Liquidation Fee

Charged when a position is liquidated. Fixed at 1% of notional value.

```
liquidation_fee = notional_value × 100 / 10,000
```

| Recipient | Share | Description |
|---|---|---|
| Liquidator | 50% | Incentive for calling `liquidate()` |
| Insurance fund | 50% | Per-market insurance against bad debt |

The liquidation fee is not configurable. `LIQUIDATION_FEE_BPS = 100` is a protocol constant.

---

## Trigger Execution Fee

Charged when a trigger order (limit, stop loss, take profit) is executed. Fixed at 0.01% of notional.

```
execution_fee = notional_value × 1 / 10,000
```

| Recipient | Share | Description |
|---|---|---|
| Executor | 100% | Incentive for calling `executeTriggerOrder()` |

This fee incentivizes crankers and bots to monitor and execute trigger orders promptly.

---

## Market Creation Fee

A one-time fee of **1 SOL** (1,000,000,000 lamports) paid when creating a new market.

```
DEFAULT_MARKET_CREATION_FEE = 1_000_000_000  // lamports
```

This fee goes to the protocol and serves as a spam deterrent. It's separate from the account rent (~0.02 SOL) which is also required.

---

## Funding Rates

Funding rates are not a fee collected by the protocol — they're payments between traders. They keep the mark price aligned with the index price.

### How Funding Works

```
premium = (mark_price - index_price) / index_price
funding_rate = clamp(premium, -cap, +cap)
```

| Parameter | Value |
|---|---|
| Funding period | 3,600 seconds (1 hour) |
| Rate cap | ±10 bps (0.1%) per period |
| Max annualized | ~876% at constant max rate |

### Payment Direction

| Condition | Longs Pay | Shorts Pay |
|---|---|---|
| Mark > Index (premium) | ✅ Longs pay shorts | |
| Mark < Index (discount) | | ✅ Shorts pay longs |

### Settlement

Funding is settled lazily:

1. `crankFunding()` is called each period, updating cumulative funding indices on the market
2. Individual accounts settle on their next interaction (open, close, deposit, withdraw)
3. The difference between the market's cumulative index and the user's last-seen index determines the payment

### Cost to Hold a Position

At the maximum funding rate:

```
0.1% per hour × 24 hours = 2.4% per day
```

In practice, funding rates are typically much lower (a few basis points per hour). They only spike when there's a large imbalance between long and short open interest.

---

## Fee Summary

| Fee | Rate | Paid By | Paid To | Configurable |
|---|---|---|---|---|
| Trading fee | 0.03%–1% | Trader | 90% protocol, 10% creator | Set by creator at market creation |
| Liquidation fee | 1% | Liquidated user | 50% liquidator, 50% insurance | No (protocol constant) |
| Trigger execution | 0.01% | Trader | Executor | No (protocol constant) |
| Market creation | 1 SOL | Creator | Protocol | No (protocol constant) |
| Funding rate | ±0.1% max/hr | Majority side | Minority side | No (protocol constant) |
