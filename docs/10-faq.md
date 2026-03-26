# FAQ

---

## General

### What is Perk?

A permissionless perpetual futures protocol on Solana. Anyone can create a leveraged trading market for any SPL token. Market creators earn 10% of all trading fees for the lifetime of the market.

### How is Perk different from Drift or Jupiter Perps?

Perk is fully permissionless — anyone can create a market for any token without governance approval. It uses a vAMM (no order book, no market makers needed) and the Percolator risk engine (no auto-deleveraging). Market creators earn ongoing revenue.

### Is Perk open source?

Yes. All code — on-chain program, SDK, cranker, and frontend — is MIT licensed and available at [github.com/kai-builds-ai/perk-protocol](https://github.com/kai-builds-ai/perk-protocol).

### What blockchain is Perk on?

Solana. Program ID: `3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2`

---

## Trading

### What wallets does Perk support?

Any Solana wallet compatible with Wallet Adapter: Phantom, Solflare, Backpack, Ledger (via adapter).

### What's the maximum leverage?

Up to 20x, configurable per market. The market creator sets the maximum at creation time.

### What collateral do I need?

Perk uses coin-margined positions. For SOL-PERP, you deposit SOL. For BONK-PERP, you deposit BONK. The collateral token matches the market's base token.

### How does the vAMM determine my execution price?

The vAMM uses a constant-product formula (`x · y = k`). Your execution price depends on your trade size relative to the vAMM's depth. Larger trades experience more slippage. See [Architecture](05-architecture.md) for the math.

### What is slippage?

The difference between the expected price and your actual execution price. It increases with trade size. The `maxSlippageBps` parameter on `openPosition` lets you set a maximum acceptable slippage — the transaction reverts if exceeded.

### When does my position get liquidated?

When your margin ratio drops below the maintenance margin (5% by default). The margin ratio is:

```
margin_ratio = (collateral + unrealized_pnl) / notional
```

Anyone can call `liquidate()` on an underwater position. The liquidator earns 50% of the 1% liquidation fee.

### What happens to my funds if I get liquidated?

Your remaining collateral (after the liquidation fee) stays in the protocol. If your loss exceeds your collateral, the insurance fund absorbs the deficit. If the deficit exceeds the insurance fund, the Percolator's A/K mechanism socializes it across all positions on the same side.

### Can I set stop losses and take profits?

Yes. Perk supports trigger orders: limit orders, stop losses, and take profits. These are on-chain orders that execute as market orders when the price crosses your trigger price. Maximum 8 per user per market.

### How do funding rates work?

Funding rates are periodic payments between longs and shorts that keep the vAMM's mark price aligned with the oracle's index price. When mark > index, longs pay shorts. When mark < index, shorts pay longs. Max rate: ±0.1% per hour. See [Trading](03-trading.md) for details.

### What is the warmup period?

New unrealized profit takes ~400 seconds (1000 Solana slots) to become fully withdrawable. During warmup, profit is visible but locked. This prevents oracle manipulation attacks where someone pumps a price, opens a position, takes profit, and dumps — all in a few seconds.

---

## Market Creation

### How much does it cost to create a market?

1 SOL (plus ~0.02 SOL account rent).

### Can I create a market for any token?

Any SPL token with a viable price source. For Pyth-covered tokens (SOL, BTC, ETH, etc.), use the Pyth oracle. For everything else, the token needs DEX liquidity visible to Jupiter and Birdeye, and a PerkOracle feed must be initialized.

### How much do I earn as a market creator?

10% of all trading fees on your market for the lifetime of the market. Revenue depends entirely on market volume — see [Fees](09-fees.md) for hypothetical examples.

### Can I change the fee or leverage after creation?

No. Market parameters are immutable after creation. Choose carefully. The protocol admin can make changes in exceptional circumstances (e.g., safety issues), but this is not standard operation.

### What if someone already created a market for my token?

You can still create your own. Multiple creators can launch competing markets for the same token — each market is uniquely identified by its (token, creator) pair. Your market competes on parameters: better fees, leverage limits, and liquidity depth attract more traders. A single creator cannot create two markets for the same token.

### Can multiple markets exist for the same token?

Yes. Each market is identified by `[token_mint, creator]`. Different creators can launch markets for the same token with different parameters. Traders choose which market to trade on based on fees, leverage, liquidity depth, and creator reputation. All markets for the same token share the same oracle price feed.

### How do I choose which market to trade on?

Compare the available markets for your token across these dimensions: trading fee (lower = cheaper per trade), max leverage (higher = more capital efficiency), vAMM depth (higher `k` = less slippage), and vault balance (more collateral = healthier risk profile). The Perk UI sorts markets by creator $PERK stake and volume.

### Do I need to provide liquidity?

No. The vAMM provides virtual liquidity. There are no LPs. The `initialK` parameter you set at creation determines the initial depth (how much slippage trades experience). As collateral enters the vault, liquidity can grow.

---

## Oracle

### What oracles does Perk use?

- **Pyth** for major tokens (SOL, BTC, ETH) — sub-second updates with confidence intervals
- **PerkOracle** for everything else — aggregates Jupiter and Birdeye prices, posted on-chain by a cranker every 2–5 seconds

### What happens if the oracle goes down?

The market pauses. Stale prices (older than 15 seconds) are rejected. No trades, liquidations, or position changes execute until fresh prices resume. This is by design — a paused market is safer than one trading on bad data.

### Can the oracle be manipulated?

PerkOracle aggregates from multiple sources and rejects outliers, making manipulation significantly harder. However, because sources may share underlying DEX liquidity, the warmup window provides a second layer of defense against short-lived price manipulation. See [PerkOracle](06-perkoracle.md) for the full security model.

---

## Security

### Has Perk been audited?

Perk has undergone multiple internal review rounds covering the full stack — on-chain program, SDK, cranker, and frontend. The protocol uses formal verification (Kani) and extensive fuzz testing. These are development team reviews, not independent third-party audits. See [Security](07-security.md) for details.

### What is the Percolator?

The risk engine powering Perk, originally designed by Anatoly Yakovenko (Solana co-founder). It handles liquidations, deficit socialization (A/K mechanism), and market recovery (three-phase system) without admin intervention. Full port from [aeyakovenko/percolator](https://github.com/aeyakovenko/percolator).

### Does Perk have auto-deleveraging (ADL)?

Not in the traditional sense. Perk uses the A/K socialization mechanism instead of ADL — positions are not force-closed. Instead, deficits are spread across all positions on the affected side via position scaling. No individual is singled out.

### What if a market's insurance fund runs out?

The Percolator's A/K mechanism kicks in, socializing the deficit across all positions on the affected side. The three-phase recovery system then works to restore the market to normal operation. No admin intervention required.

### Is there a bug bounty?

The code is MIT-licensed and fully open source. Check the [GitHub repository](https://github.com/kai-builds-ai/perk-protocol) for the latest on security reporting.

---

## Technical

### What's the program ID?

`3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2`

### What framework is the program built with?

Anchor 0.32.1 on Solana.

### How are prices stored on-chain?

All prices use a scale of 1e6 (6 decimal places). `$150.32` is stored as `150_320_000`.

### Can I run my own cranker?

Yes. All cranker instructions are permissionless. Liquidators earn 50% of the liquidation fee. Trigger order executors earn 0.01% of notional. See [Architecture](05-architecture.md) for cranker details.

### Is there an SDK?

Yes. `perk-protocol` — TypeScript SDK covering all instructions, account fetching, math helpers, and cranker utilities. See [SDK Reference](08-sdk.md).

---

## $PERK Token

### What is $PERK?

The native SPL token of Perk Protocol. It provides fee discounts, staking rewards, market creation discounts, and (in Phase 2) governance over protocol parameters. See [$PERK Token](11-perk-token.md) for full details.

### Do I need $PERK to trade?

No. Anyone can trade on Perk without holding $PERK. The token provides fee discounts and staking rewards but is not required.

### Do I need $PERK to create a market?

No. Market creation is permissionless — pay 1 SOL and your market is live. Paying in $PERK gives a 50% discount (0.5 SOL equivalent), but it's optional.

### What are staking rewards?

Stake $PERK to earn a proportional share of protocol trading fees. Rewards are distributed from the protocol fee accumulator based on your share of total staked supply.

### When does governance launch?

Governance is Phase 2. At launch, protocol parameters are admin-configurable. Governance will transfer to $PERK holders after the protocol stabilizes. Market creation will remain permissionless regardless — governance covers protocol-wide parameters, not market listing.
