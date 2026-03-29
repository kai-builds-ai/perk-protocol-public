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

### 1. Open the Trade Panel

Navigate to a market (e.g., SOL-PERP). The trade panel shows your balances (Wallet, Vault, Margin, Buffer) at the top, followed by a **Size** input for your collateral, a **Leverage** slider, and the **Open Long / Open Short** buttons.

To trade, simply enter your collateral size, set your leverage, and click **Open Long** or **Open Short**. The protocol handles depositing collateral into the vault automatically — no separate deposit step is needed.

Below the trade button you'll find the **Add Margin / Withdraw** section for managing margin on existing positions.

> Your first trade on a market requires a small rent deposit (~0.01 SOL) to create your position account on-chain. This is refundable when the account is closed. Position initialization is handled automatically.

> Perk uses stablecoin-margined positions. All markets accept stablecoin collateral (USDC, USDT, or PYUSD) — the specific stablecoin is chosen by the market creator. Your collateral value is stable regardless of the base token's price movement.

### 2. Open a Position

In the trade panel:

1. Select **Long** or **Short**
2. Enter your collateral size (in the market's stablecoin, e.g. USDC)
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

In the panel below the trade button, click **Withdraw**, enter the amount, and confirm. Tokens transfer from the vault back to your wallet.

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
3. Choose the **collateral stablecoin** (USDC, USDT, or PYUSD). All traders on your market will use this stablecoin.
4. Configure parameters:
   - **Max leverage** — 2x to 20x
   - **Trading fee** — 0.03% to 1% (you choose, immutable after creation)
   - **Initial depth (k)** — determines vAMM liquidity depth
5. Review the revenue estimate
6. Click **Create Market** and approve the transaction

The market is live immediately. You earn 10% of every trading fee collected on it for the lifetime of the market.

> One market per token mint per creator. Multiple creators can create markets for the same token with different parameters.

---

## Fee Overview

| Fee | Amount | Who Pays | Who Receives |
|---|---|---|---|
| Trading fee | 0.03%–1% (set by creator) | Trader | 90% protocol, 10% creator |
| Liquidation fee | 1% of notional | Liquidated trader | 50% liquidator, 50% insurance |
| Trigger execution fee | 0.01% of notional | Trader | Executor (cranker) |
| Market creation | 1 SOL | Creator | Protocol |

See [Fees](09-fees.md) for full details.
