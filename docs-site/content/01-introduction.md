# Introduction

> **⚠️ Risk Warning:** Leveraged trading carries significant risk. You can lose your entire deposited collateral. Perk is experimental software on a public blockchain. Never trade more than you can afford to lose.

*Docs version: 2026-03-25 · Perk Protocol v1*

Perk is a permissionless perpetual futures protocol on Solana. It lets anyone create a leveraged trading market for any SPL token — no governance approval, no whitelist, no waiting. Market creators earn 10% of all trading fees on their market for the lifetime of the market.

**Program ID:** `5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW`

**GitHub:** [github.com/kai-builds-ai/perk-protocol](https://github.com/kai-builds-ai/perk-protocol)

**License:** MIT (fully open source)

**Contact:** [contact@perk.fund](mailto:contact@perk.fund)

---

## Key Features

**Permissionless market creation.** Anyone can launch a perpetual futures market for any SPL token in a single transaction. The creator pays 1 SOL, configures leverage limits and fees, and the market goes live immediately.

**Creator revenue.** Market creators earn 10% of every trading fee collected on their market for the lifetime of the market. The creator address is set at market creation and cannot be changed. See [Fees](09-fees.md) for details.

**Virtual AMM (vAMM).** Perk uses a constant-product virtual AMM (`x · y = k`) for price discovery. There's no order book and no need for market makers. Any token with an oracle price feed can have liquid leveraged trading from the moment the market is created.

**Up to 20x leverage.** Each market's maximum leverage is set by the creator (2x–20x). Traders choose their leverage per position within that range.

**Percolator risk engine.** The risk engine is a full port of [Anatoly Yakovenko's Percolator](https://github.com/aeyakovenko/percolator). It handles liquidations, deficit socialization, and market recovery autonomously — no admin intervention, no governance votes.

---

## How It Works

1. **Someone creates a market.** They pick a token, set the oracle, choose leverage limits and fees, pay 1 SOL. The market is live.

2. **Traders deposit collateral** into the market's vault and open long or short positions against the vAMM.

3. **The vAMM determines execution prices** using constant-product math. Larger trades create more slippage, naturally limiting risk.

4. **Oracles anchor the price.** Pyth provides price feeds for major tokens (SOL, BTC, ETH). PerkOracle — a custom aggregation system using Jupiter and Birdeye — covers everything else.

5. **Funding rates** keep the mark price aligned with the index price. Longs pay shorts (or vice versa) based on the premium/discount.

6. **Liquidations are permissionless.** Anyone can liquidate underwater positions and earn a portion of the liquidation fee.

7. **The risk engine handles the rest.** If liquidations create bad debt, the Percolator's H/A/K mechanism socializes losses fairly across all participants on the affected side. No traditional auto-deleveraging (ADL) — positions are not force-closed. Instead, deficits are socialized via position scaling. No individual targeting.

---

## What Perk Is Not

- Not an order book exchange. No market makers required.
- Not a governance-gated protocol. No proposals to list new tokens.
- Not cross-margin. Positions are isolated per market.
- Not a token launch. No governance token on day one.

---

## Documentation

| Document | Description |
|---|---|
| [Getting Started](02-getting-started.md) | Connect, trade, create a market |
| [Trading](03-trading.md) | Positions, leverage, liquidation, funding rates |
| [Market Creation](04-market-creation.md) | How to launch a market and earn fees |
| [Architecture](05-architecture.md) | vAMM, risk engine, account structure, crankers |
| [PerkOracle](06-perkoracle.md) | Custom oracle system for long-tail tokens |
| [Security](07-security.md) | Verification, audits, safety mechanisms |
| [SDK Reference](08-sdk.md) | TypeScript SDK for building on Perk |
| [Fees](09-fees.md) | Fee structure, creator revenue, funding rates |
| [FAQ](10-faq.md) | Common questions |
