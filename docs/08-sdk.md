# SDK Reference

The TypeScript SDK (`perk-protocol`) wraps all on-chain instructions and provides helper functions for building on Perk.

---

## Installation

```bash
npm install perk-protocol
```

Peer dependencies: `@solana/web3.js`, `@coral-xyz/anchor`, `@solana/spl-token`, `bn.js`

---

## PerkClient

The main entry point. Wraps the Anchor program and exposes typed methods for every instruction.

### Constructor

```typescript
import { PerkClient } from "perk-protocol";
import { Connection, PublicKey } from "@solana/web3.js";

const client = new PerkClient({
  connection: new Connection("https://your-rpc-endpoint.com"),
  wallet: yourWallet,              // Anchor Wallet interface
  programId: PERK_PROGRAM_ID,     // Optional, defaults to mainnet program
  commitment: "confirmed",         // Optional
  preInstructions: [],             // Optional, e.g. ComputeBudget instructions
});
```

---

## Account Fetchers

```typescript
// Protocol config
const protocol = await client.fetchProtocol();

// Single market (by token mint and creator)
const market = await client.fetchMarket(tokenMint, creatorPubkey);

// All markets
const markets = await client.fetchAllMarkets();
// Returns: { address: PublicKey, account: MarketAccount }[]

// User position
const position = await client.fetchPosition(marketAddress, userPublicKey);

// All positions for a user
const positions = await client.fetchAllPositions(userPublicKey);

// Trigger orders for a user on a market
const orders = await client.fetchTriggerOrders(marketAddress, userPublicKey);

// PerkOracle price feed
const oracle = await client.fetchPerkOracle(tokenMint);
const oracleOrNull = await client.fetchPerkOracleNullable(tokenMint);
```

---

## Trading

### Deposit Collateral

```typescript
import BN from "bn.js";

// First interaction: initialize position account
await client.initializePosition(tokenMint);

// Deposit 10 SOL (in lamports)
await client.deposit(
  tokenMint,
  oracleAddress,
  new BN(10_000_000_000),      // 10 SOL
  fallbackOracleAddress,        // optional
);
```

### Open Position

```typescript
import { Side } from "perk-protocol";

// Open a 5x long position, 1 SOL size
await client.openPosition(
  tokenMint,
  oracleAddress,
  Side.Long,
  new BN(1_000_000_000),       // 1 SOL base size
  500,                          // 5x leverage (leverage × 100)
  300,                          // max slippage: 3% (300 bps)
  fallbackOracleAddress,        // optional
);
```

Leverage is scaled by 100: `200` = 2x, `500` = 5x, `1000` = 10x, `2000` = 20x.

### Close Position

```typescript
// Close entire position
await client.closePosition(tokenMint, oracleAddress);

// Close partial (0.5 SOL)
await client.closePosition(
  tokenMint,
  oracleAddress,
  new BN(500_000_000),          // 0.5 SOL
);
```

### Withdraw

```typescript
await client.withdraw(
  tokenMint,
  oracleAddress,
  new BN(5_000_000_000),        // 5 SOL
);
```

---

## Trigger Orders

### Place a Limit Order

```typescript
import { TriggerOrderType, Side } from "perk-protocol";

await client.placeTriggerOrder(tokenMint, {
  orderType: TriggerOrderType.Limit,
  side: Side.Long,
  size: new BN(1_000_000_000),       // 1 SOL
  triggerPrice: new BN(140_000_000),  // $140 (1e6 scale)
  leverage: 500,                      // 5x
  reduceOnly: false,
  expiry: new BN(0),                  // GTC (0 = no expiry)
});
```

### Place a Stop Loss

```typescript
await client.placeTriggerOrder(tokenMint, {
  orderType: TriggerOrderType.StopLoss,
  side: Side.Long,                     // Side of position to close
  size: new BN(0),                     // 0 = close entire position
  triggerPrice: new BN(130_000_000),   // $130
  leverage: 0,                         // Ignored for reduce-only
  reduceOnly: true,
  expiry: new BN(0),
});
```

### Place a Take Profit

```typescript
await client.placeTriggerOrder(tokenMint, {
  orderType: TriggerOrderType.TakeProfit,
  side: Side.Long,
  size: new BN(0),
  triggerPrice: new BN(170_000_000),   // $170
  leverage: 0,
  reduceOnly: true,
  expiry: new BN(0),
});
```

### Cancel a Trigger Order

```typescript
await client.cancelTriggerOrder(tokenMint, orderId);
```

---

## Market Creation

```typescript
import { OracleSource } from "perk-protocol";

await client.createMarket(
  tokenMint,
  oracleAddress,
  {
    oracleSource: OracleSource.PerkOracle,
    maxLeverage: 1000,                              // 10x
    tradingFeeBps: 30,                               // 0.3%
    initialK: new BN("1000000000000000000"),         // 1e18
  }
);
```

---

## PerkOracle (Permissionless / Admin / Cranker)

### Initialize Oracle (Permissionless)

Anyone can initialize a PerkOracle for any SPL token by paying rent. The oracle authority is inherited from `Protocol.oracle_authority`.

```typescript
await client.initializePerkOracle(
  tokenMint,
  {
    minSources: 2,
    maxStalenessSeconds: 15,
    maxPriceChangeBps: 0,               // 0 = no banding (memecoin)
    circuitBreakerDeviationBps: 0,      // 0 = disabled
  }
);
```

### Set Oracle Authority (Admin, One-Time)

Admin sets the oracle authority (cranker pubkey) on the Protocol account. All newly initialized oracles inherit this authority.

```typescript
await client.adminSetOracleAuthority(
  newOracleAuthorityPubkey
);
```

### Update Oracle Price (Cranker)

```typescript
await client.updatePerkOracle(tokenMint, {
  price: new BN(150_320_000),          // $150.32
  confidence: new BN(50_000),          // $0.05 spread
  numSources: 2,
});
```

### Freeze / Unfreeze (Admin)

```typescript
await client.freezePerkOracle(tokenMint, true);   // freeze
await client.freezePerkOracle(tokenMint, false);   // unfreeze
```

### Update Oracle Config (Admin)

```typescript
await client.updateOracleConfig(tokenMint, {
  maxPriceChangeBps: 500,              // 5% band
  minSources: null,                     // don't change
  maxStalenessSeconds: null,            // don't change
  circuitBreakerDeviationBps: 1000,    // 10% circuit breaker
});
```

---

## Cranker Instructions

These are permissionless — anyone can call them.

```typescript
// Crank funding rate
await client.crankFunding(marketAddress, oracleAddress);

// Liquidate an underwater position
await client.liquidate(
  marketAddress,
  oracleAddress,
  targetUserPubkey,
  liquidatorTokenAccount,
);

// Execute a triggered order
await client.executeTriggerOrder(
  marketAddress,
  oracleAddress,
  targetUserPubkey,
  orderId,
  executorTokenAccount,
);

// Re-peg the vAMM
await client.updateAmm(marketAddress, oracleAddress);

// Reclaim an empty position account
await client.reclaimEmptyAccount(
  marketAddress,
  oracleAddress,
  positionOwnerPubkey,
);
```

---

## Fee Claims

```typescript
// Creator or protocol admin claims accumulated fees
await client.claimFees(tokenMint, recipientTokenAccount);
```

---

## Math Helpers

The SDK exports pure functions for client-side calculations:

```typescript
import {
  calculateMarkPrice,
  estimateExecutionPrice,
  calculateSlippageBps,
  effectivePositionQ,
  calculateNotional,
  marginRatio,
  isLiquidatable,
  estimateLiquidationPrice,
  calculateFee,
  fundingRateAnnualized,
  warmupProgress,
  haircutRatio,
  accountEquity,
  priceToNumber,
  numberToPrice,
} from "perk-protocol";

// Mark price from vAMM state
const mark = calculateMarkPrice(market);

// Estimated execution price for a trade
const execPrice = estimateExecutionPrice(market, side, baseSize);

// Slippage in basis points
const slippage = calculateSlippageBps(executionPrice, markPrice);

// Is the position liquidatable?
const underwater = isLiquidatable(position, market, oraclePrice);

// Liquidation price estimate
const liqPrice = estimateLiquidationPrice(position, market, oraclePrice);

// Account equity (max(0, collateral + pnl - feeDebt))
const equity = accountEquity(position);

// Warmup progress (0 to 1)
const progress = warmupProgress(position, market, currentSlot);

// Haircut ratio
const h = haircutRatio(market);
```

---

## PDA Helpers

```typescript
import {
  findProtocolAddress,
  findMarketAddress,
  findPositionAddress,
  findVaultAddress,
  findTriggerOrderAddress,
  findPerkOracleAddress,
} from "perk-protocol";

const [protocolPda] = findProtocolAddress(programId);
const [marketPda] = findMarketAddress(tokenMint, creatorPubkey, programId);
const [positionPda] = findPositionAddress(marketPda, userPubkey, programId);
const [vaultPda] = findVaultAddress(marketPda, programId);
const [triggerPda] = findTriggerOrderAddress(marketPda, userPubkey, orderId, programId);
const [oraclePda] = findPerkOracleAddress(tokenMint, programId);
```

---

## Types

All account types and enums are exported:

```typescript
import type {
  ProtocolAccount,
  MarketAccount,
  UserPositionAccount,
  TriggerOrderAccount,
  PerkOracleAccount,
  CreateMarketParams,
  TriggerOrderParams,
  PositionInfo,
  MarketInfo,
} from "perk-protocol";

import {
  Side,
  OracleSource,
  SideState,
  TriggerOrderType,
} from "perk-protocol";
```

See [types.ts](https://github.com/kai-builds-ai/perk-protocol/blob/main/sdk/src/types.ts) for the full type definitions.

---

## Constants

All on-chain constants are mirrored in the SDK:

```typescript
import {
  PERK_PROGRAM_ID,        // 3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2
  PRICE_SCALE,             // 1_000_000
  CREATOR_FEE_SHARE_BPS,   // 1000 (10%)
  MAINTENANCE_MARGIN_BPS,  // 500 (5%)
  MAX_LEVERAGE,            // 2000 (20x)
  MIN_TRADING_FEE_BPS,     // 3 (0.03%)
  MAX_TRADING_FEE_BPS,     // 100 (1%)
  WARMUP_PERIOD_SLOTS,     // 1000
  MAX_TRIGGER_ORDERS,      // 8
  // ... see constants.ts for full list
} from "perk-protocol";
```
