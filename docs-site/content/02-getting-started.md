# Getting Started

> **⚠️ Risk Warning:** Leveraged trading carries significant risk. You can lose your entire deposited collateral. Perk is experimental software. Never trade more than you can afford to lose.

This guide covers connecting your wallet, making your first trade, and creating a market.

---

## Connect Your Wallet

Perk supports any Solana wallet compatible with Wallet Adapter:

- Phantom
- Solflare
- Backpack
- Ledger (via Phantom or Solflare)

Click **Connect Wallet** in the top bar. Select your wallet, approve the connection. No signatures required to connect — only to sign transactions.

---

## Make Your First Trade

### 1. Deposit Collateral

Navigate to a market (e.g., SOL-PERP). In the deposit panel:

1. Enter the amount of collateral to deposit
2. Click **Deposit**
3. Approve the transaction in your wallet

Collateral goes into the market's vault. Your deposited amount appears as available margin.

> Your first trade on a market requires a small rent deposit (~0.01 SOL) to create your position account on-chain. This is refundable when the account is closed. Position initialization is handled automatically.

> Perk uses coin-margined positions. For SOL-PERP, you deposit SOL. For BONK-PERP, you deposit BONK.
>
> **⚠️ Compounding risk:** Coin-margined positions carry compounding risk. If the token price drops, both your position and your collateral lose value simultaneously. This means liquidation can happen faster than on stablecoin-margined platforms.

### 2. Open a Position

In the trade panel:

1. Select **Long** or **Short**
2. Enter your position size (in the market's base token)
3. Set leverage using the slider (2x–20x, depending on market)
4. Review the estimate: entry price, liquidation price, fee, slippage
5. Click **Open Long** or **Open Short**
6. Approve the transaction

The position opens immediately against the vAMM. Your entry price depends on the size of your trade relative to the vAMM's depth — larger trades experience more slippage.

### 3. Manage Your Position

Once open, your position appears in the **Positions** panel below the chart:

- **PnL** updates in real-time as the price moves
- **Liquidation price** shows where your position would be liquidated
- **TP/SL buttons** let you set take-profit and stop-loss trigger orders

### 4. Close Your Position

Click **Close** on your position. Review the PnL preview, confirm the transaction.

Profit (after the warmup period) is added to your available collateral. You can then withdraw from the vault back to your wallet.

### 5. Withdraw

In the deposit panel, click **Withdraw**, enter the amount, and confirm. Tokens transfer from the vault back to your wallet.

> You can only withdraw available margin — collateral not currently backing an open position.

---

## Create a Market

Anyone can create a perpetual futures market for any SPL token.

### Requirements

- The token must have existing DEX liquidity (for oracle pricing)
- 1 SOL creation fee
- A Solana wallet

### Steps

1. Navigate to `/launch` (or click **Create Market**)
2. Enter the token mint address or search by name
3. Select the oracle source:
   - **Pyth** — for tokens with Pyth price feeds (SOL, BTC, ETH, etc.)
   - **PerkOracle** — for everything else (requires DEX liquidity on Jupiter/Birdeye)
4. Configure parameters:
   - **Max leverage** — 2x to 20x
   - **Trading fee** — 0.03% to 1% (you choose, immutable after creation)
   - **Initial depth (k)** — determines vAMM liquidity depth
5. Review the revenue estimate
6. Click **Create Market** and approve the transaction

The market is live immediately. You earn 10% of every trading fee collected on it for the lifetime of the market.

> One market per token mint. The first creator for a given token gets the market.

---

## Fee Overview

| Fee | Amount | Who Pays | Who Receives |
|---|---|---|---|
| Trading fee | 0.03%–1% (set by creator) | Trader | 90% protocol, 10% creator |
| Liquidation fee | 1% of notional | Liquidated trader | 50% liquidator, 50% insurance |
| Trigger execution fee | 0.01% of notional | Trader | Executor (cranker) |
| Market creation | 1 SOL | Creator | Protocol |

See [Fees](09-fees.md) for full details.
