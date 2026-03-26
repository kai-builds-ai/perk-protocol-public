# Market Creation

Anyone can create a perpetual futures market for any SPL token on Perk. No governance, no whitelist, no approval process. Pay 1 SOL, configure your parameters, and the market goes live immediately.

---

## How It Works

Market creation is a single transaction that calls `createMarket`. The creator specifies:

| Parameter | Range | Description |
|---|---|---|
| `tokenMint` | Any SPL token | The token this market trades |
| `oracleSource` | Pyth or PerkOracle | Where the index price comes from |
| `oracleAddress` | Valid feed address | The specific oracle account |
| `maxLeverage` | 200–2000 (2x–20x) | Maximum leverage traders can use |
| `tradingFeeBps` | 3–100 (0.03%–1%) | Fee charged on every trade |
| `initialK` | ≥ 1e18 | Initial vAMM depth (liquidity) |

These parameters are **immutable after creation**. The creator cannot modify them. The protocol admin can update the oracle address, trading fee, max leverage, and active status in exceptional circumstances (e.g., oracle migration, safety issues) — this is not standard operation. Choose carefully.

---

## Cost

Market creation costs **1 SOL**, paid to the protocol. This covers the on-chain account rent for the Market PDA and serves as a spam deterrent.

---

## Creator Revenue

The market creator earns **10% of all trading fees** collected on their market for the lifetime of the market. This is hardcoded into the protocol — no one can change the split.

> **⚠️** The creator address cannot be updated. Ensure you use a secure wallet — if access is lost, accumulated and future fees are unrecoverable.

### Revenue Examples

> *These are hypothetical examples for illustration only. Actual revenue depends entirely on market volume, which is not guaranteed. Markets may have zero volume.*

| Daily Volume | Trading Fee | Daily Revenue | Monthly Revenue |
|---|---|---|---|
| $10,000 | 0.1% | $1 | $30 |
| $100,000 | 0.1% | $10 | $300 |
| $1,000,000 | 0.1% | $100 | $3,000 |
| $10,000,000 | 0.1% | $1,000 | $30,000 |

Fees accumulate on-chain in `creatorClaimableFees`. The creator can call `claimFees()` at any time to withdraw.

---

## Oracle Requirements

The token must have a viable price source:

### Pyth (Tier 1)

Use Pyth for tokens that have an established Pyth price feed: SOL, BTC, ETH, and other major tokens. Pyth provides sub-second updates with confidence intervals.

Pass the Pyth price feed account address as `oracleAddress`.

### PerkOracle (Tier 2)

For everything else — memecoins, new launches, long-tail tokens. PerkOracle aggregates prices from Jupiter Price API and Birdeye, posting them on-chain via a cranker.

Requirements:
- The token must have DEX liquidity visible to Jupiter and Birdeye
- A PerkOracle price feed must be initialized for the token (admin creates these)

See [PerkOracle](06-perkoracle.md) for details on how the oracle system works.

---

## One Market Per Token

Only one market can exist per token mint. Seeds for the Market PDA are `[b"market", token_mint]`. The first creator to land the transaction wins.

Because parameters are immutable, the first market for a token sets permanent trading conditions. A poorly configured market cannot be replaced.

---

## What Happens After Creation

1. **Market goes live immediately.** Traders can deposit and open positions.
2. **The vAMM initializes** with the creator's `initialK` value and the current oracle price as the peg.
3. **Cranker bots pick it up** — funding rate cranking, peg updates, liquidation monitoring, and trigger order execution start automatically.
4. **Fees accumulate** in the creator's on-chain balance from the first trade.

The creator has no ongoing admin control over the market. They can't pause it, change fees, or modify leverage limits. The market is autonomous.

---

## Choosing Good Parameters

### Max Leverage

Higher leverage attracts more traders but increases liquidation risk and potential for bad debt. Conservative markets for volatile tokens should use lower leverage (2x–5x). Established tokens with reliable oracles can handle higher leverage (10x–20x).

### Trading Fee

Lower fees attract volume. Higher fees generate more revenue per trade. The protocol minimum is 0.03% and the maximum is 1%.

Typical values:
- Major tokens (SOL, BTC): 0.05%–0.1%
- Mid-cap tokens: 0.1%–0.3%
- Memecoins / high-volatility: 0.3%–1%

### Initial K (vAMM Depth)

Higher `k` means less slippage for traders (deeper liquidity). Lower `k` means the market moves more on each trade.

The minimum is 1e18. For most markets, start moderate and let the protocol adjust depth as collateral enters the vault.

---

## SDK Example

```typescript
import { PerkClient, OracleSource } from "@perk/sdk";
import BN from "bn.js";

const tx = await perkClient.createMarket(
  tokenMint,           // PublicKey of the SPL token
  oracleAddress,       // Pyth feed or PerkOracle account
  {
    oracleSource: OracleSource.PerkOracle,
    maxLeverage: 1000,       // 10x
    tradingFeeBps: 30,       // 0.3%
    initialK: new BN("1000000000000000000"), // 1e18
  }
);
```

See [SDK Reference](08-sdk.md) for the full `PerkClient` API.
