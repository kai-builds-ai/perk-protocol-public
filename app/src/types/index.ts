// Matches ARCHITECTURE.md account structures

export enum OracleSource {
  Pyth = "Pyth",
  PerkOracle = "PerkOracle",
  DexPool = "DexPool",
}

export enum Side {
  Long = "Long",
  Short = "Short",
}

export enum TriggerOrderType {
  Limit = "Limit",
  StopLoss = "StopLoss",
  TakeProfit = "TakeProfit",
}

export enum SideState {
  Normal = "Normal",
  DrainOnly = "DrainOnly",
  ResetPending = "ResetPending",
}

export interface Market {
  address: string; // Market PDA address (base58)
  marketIndex: number;
  tokenMint: string;
  collateralMint: string;
  creator: string;
  symbol: string;
  name: string;
  logoUrl?: string;

  // vAMM
  baseReserve: number;
  quoteReserve: number;
  k: number;
  pegMultiplier: number;
  totalLongPosition: number;
  totalShortPosition: number;

  // Params
  maxLeverage: number; // e.g. 20 for 20x
  tradingFeeBps: number;
  liquidationFeeBps: number;
  maintenanceMarginBps: number;

  // Oracle
  oracleSource: OracleSource;
  oracleAddress: string;

  // Stats
  markPrice: number;
  indexPrice: number;
  fundingRate: number; // per hour, as decimal
  volume24h: number;
  openInterest: number;
  change24h: number; // as decimal, e.g. 0.0241 = +2.41%

  active: bool;
  totalUsers: number;
  totalPositions: number;
  createdAt: number;

  // Creator fees (human-readable units, not lamports)
  creatorClaimableFees: number;
  creatorFeesEarned: number;
}

type bool = boolean;

export interface UserPosition {
  authority: string;
  market: string;
  marketSymbol: string;
  tokenMint: string;
  creator: string;
  oracleAddress: string;
  depositedCollateral: number;
  availableMargin: number;
  baseSize: number; // positive = long, negative = short
  quoteEntryAmount: number;
  entryPrice: number;
  leverage: number;
  pnl: number;
  pnlPercent: number;
  liquidationPrice: number;
  openTriggerOrders: number;
}

export interface TriggerOrder {
  authority: string;
  market: string;
  marketSymbol: string;
  tokenMint: string;
  creator: string;
  orderId: number;
  orderType: TriggerOrderType;
  side: Side;
  size: number;
  triggerPrice: number;
  leverage: number;
  reduceOnly: boolean;
  createdAt: number;
}

export type OrderTab = "market" | "limit" | "stop";

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
