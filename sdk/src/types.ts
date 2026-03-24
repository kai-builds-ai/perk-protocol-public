import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// ── Enums ──

export enum OracleSource {
  Pyth = 0,
  DexPool = 1,
}

export enum Side {
  Long = 0,
  Short = 1,
}

export enum SideState {
  Normal = 0,
  DrainOnly = 1,
  ResetPending = 2,
}

export enum TriggerOrderType {
  Limit = 0,
  StopLoss = 1,
  TakeProfit = 2,
}

// ── Account Types ──

export interface ProtocolAccount {
  admin: PublicKey;
  paused: boolean;
  marketCount: BN;
  protocolFeeVault: PublicKey;
  creatorFeeShareBps: number;
  minTradingFeeBps: number;
  maxTradingFeeBps: number;
  minInitialLiquidity: BN;
  totalVolume: BN;
  totalFeesCollected: BN;
  totalUsers: BN;
  bump: number;
  marketCreationFee: BN;
  pendingAdmin: PublicKey | null;
}

export interface MarketAccount {
  marketIndex: BN;
  tokenMint: PublicKey;
  collateralMint: PublicKey;
  creator: PublicKey;
  vault: PublicKey;
  vaultBump: number;

  // vAMM
  baseReserve: BN;
  quoteReserve: BN;
  k: BN;
  pegMultiplier: BN;
  totalLongPosition: BN;
  totalShortPosition: BN;

  // Parameters
  maxLeverage: number;
  tradingFeeBps: number;
  liquidationFeeBps: number;
  maintenanceMarginBps: number;

  // Oracle
  oracleSource: OracleSource;
  oracleAddress: PublicKey;

  // Risk engine
  insuranceFundBalance: BN;
  haircutNumerator: BN;
  haircutDenominator: BN;

  // ADL — long side
  longA: BN;
  longKIndex: BN;
  longEpoch: BN;
  longState: SideState;
  longEpochStartK: BN;

  // ADL — short side
  shortA: BN;
  shortKIndex: BN;
  shortEpoch: BN;
  shortState: SideState;
  shortEpochStartK: BN;

  // Funding
  lastFundingTime: BN;
  cumulativeLongFunding: BN;
  cumulativeShortFunding: BN;
  fundingPeriodSeconds: number;
  fundingRateCapBps: number;
  warmupPeriodSlots: BN;

  // Fees & volume
  creatorFeesEarned: BN;
  protocolFeesEarned: BN;
  totalVolume: BN;

  // State
  active: boolean;
  totalUsers: number;
  totalPositions: number;
  cTot: BN;
  pnlPosTot: BN;
  pnlMaturedPosTot: BN;
  vaultBalance: BN;
  oiEffLongQ: BN;
  oiEffShortQ: BN;
  storedPosCountLong: BN;
  storedPosCountShort: BN;
  bump: number;
  createdAt: BN;
  maxPositionSize: BN;
  maxOi: BN;
  lastPegUpdateSlot: BN;
  lastMarkPriceForFunding: BN;
  creatorClaimableFees: BN;
  protocolClaimableFees: BN;
  insuranceEpochStart: BN;
  insuranceEpochPayout: BN;
  lastOraclePrice: BN;
  lastMarketSlot: BN;
  currentSlot: BN;
  fundingRateBpsPerSlotLast: BN;
  fundingPriceSampleLast: BN;
  insuranceFloor: BN;
  staleAccountCountLong: BN;
  staleAccountCountShort: BN;
  phantomDustBoundLongQ: BN;
  phantomDustBoundShortQ: BN;
  insuranceFeeRevenue: BN;
  pendingResetLong: boolean;
  pendingResetShort: boolean;
  markPriceAccumulator: BN;
  twapObservationCount: number;
  twapVolumeAccumulator: BN;
  creationFeePaid: BN;
}

export interface UserPositionAccount {
  authority: PublicKey;
  market: PublicKey;
  depositedCollateral: BN;
  baseSize: BN; // i64
  quoteEntryAmount: BN;
  lastCumulativeFunding: BN;
  pnl: BN; // i128
  reservedPnl: BN;
  warmupStartedAtSlot: BN;
  warmupSlope: BN;
  basis: BN; // i128
  aSnapshot: BN;
  kSnapshot: BN; // i128
  epochSnapshot: BN;
  feeCredits: BN; // i128
  lastFeeSlot: BN;
  openTriggerOrders: number;
  maxTriggerOrders: number;
  nextOrderId: BN;
  lastActivitySlot: BN;
  bump: number;
}

export interface TriggerOrderAccount {
  authority: PublicKey;
  market: PublicKey;
  orderId: BN;
  orderType: TriggerOrderType;
  side: Side;
  size: BN;
  triggerPrice: BN;
  leverage: number;
  reduceOnly: boolean;
  createdAt: BN;
  expiry: BN;
  bump: number;
}

// ── Instruction Params ──

export interface CreateMarketParams {
  oracleSource: OracleSource;
  maxLeverage: number;
  tradingFeeBps: number;
  initialK: BN;
}

export interface AdminUpdateMarketParams {
  oracleAddress: PublicKey | null;
  active: boolean | null;
  tradingFeeBps: number | null;
  maxLeverage: number | null;
}

export interface TriggerOrderParams {
  orderType: TriggerOrderType;
  side: Side;
  size: BN;
  triggerPrice: BN;
  leverage: number;
  reduceOnly: boolean;
  expiry: BN;
}

// ── Computed types ──

export interface PositionInfo {
  side: Side | null;
  sizeAbs: BN;
  effectiveSize: BN;
  notional: number;
  entryPrice: number;
  markPrice: number;
  oraclePrice: number;
  unrealizedPnl: number;
  marginRatio: number;
  leverage: number;
  liquidationPrice: number | null;
  isLiquidatable: boolean;
  collateral: number;
  warmupProgress: number; // 0-1
}

export interface MarketInfo {
  address: PublicKey;
  tokenMint: PublicKey;
  markPrice: number;
  oraclePrice: number;
  fundingRate: number;
  longOI: number;
  shortOI: number;
  volume24h: number;
  insuranceFund: number;
  longState: SideState;
  shortState: SideState;
  maxLeverage: number;
  tradingFeeBps: number;
}
