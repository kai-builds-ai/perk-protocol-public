import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
export declare enum OracleSource {
    Pyth = 0,
    PerkOracle = 1,
    DexPool = 2
}
export declare enum Side {
    Long = 0,
    Short = 1
}
export declare enum SideState {
    Normal = 0,
    DrainOnly = 1,
    ResetPending = 2
}
export declare enum TriggerOrderType {
    Limit = 0,
    StopLoss = 1,
    TakeProfit = 2
}
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
    baseReserve: BN;
    quoteReserve: BN;
    k: BN;
    pegMultiplier: BN;
    totalLongPosition: BN;
    totalShortPosition: BN;
    maxLeverage: number;
    tradingFeeBps: number;
    liquidationFeeBps: number;
    maintenanceMarginBps: number;
    oracleSource: OracleSource;
    oracleAddress: PublicKey;
    insuranceFundBalance: BN;
    haircutNumerator: BN;
    haircutDenominator: BN;
    longA: BN;
    longKIndex: BN;
    longEpoch: BN;
    longState: SideState;
    longEpochStartK: BN;
    shortA: BN;
    shortKIndex: BN;
    shortEpoch: BN;
    shortState: SideState;
    shortEpochStartK: BN;
    lastFundingTime: BN;
    cumulativeLongFunding: BN;
    cumulativeShortFunding: BN;
    fundingPeriodSeconds: number;
    fundingRateCapBps: number;
    warmupPeriodSlots: BN;
    creatorFeesEarned: BN;
    protocolFeesEarned: BN;
    totalVolume: BN;
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
    fallbackOracleSource: OracleSource;
    fallbackOracleAddress: PublicKey;
}
export interface UserPositionAccount {
    authority: PublicKey;
    market: PublicKey;
    depositedCollateral: BN;
    baseSize: BN;
    quoteEntryAmount: BN;
    lastCumulativeFunding: BN;
    pnl: BN;
    reservedPnl: BN;
    warmupStartedAtSlot: BN;
    warmupSlope: BN;
    basis: BN;
    aSnapshot: BN;
    kSnapshot: BN;
    epochSnapshot: BN;
    feeCredits: BN;
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
export interface PerkOracleAccount {
    bump: number;
    tokenMint: PublicKey;
    authority: PublicKey;
    price: BN;
    confidence: BN;
    timestamp: BN;
    numSources: number;
    minSources: number;
    lastSlot: BN;
    emaPrice: BN;
    maxStalenessSeconds: number;
    isFrozen: boolean;
    createdAt: BN;
    totalUpdates: BN;
}
export interface InitPerkOracleParams {
    minSources: number;
    maxStalenessSeconds: number;
    /** Max price change per update in basis points. 0 = no banding (memecoins). 3000 = 30%. */
    maxPriceChangeBps: number;
    /** Circuit breaker: max deviation from EMA in bps. 0 = disabled. Must be 0 or [500, 9999]. */
    circuitBreakerDeviationBps: number;
}
export interface UpdatePerkOracleParams {
    price: BN;
    confidence: BN;
    numSources: number;
}
export interface UpdateOracleConfigParams {
    /** Max price change per update in basis points. 0 = no banding. null = don't change. */
    maxPriceChangeBps: number | null;
    /** Minimum sources required. null = don't change. */
    minSources: number | null;
    /** Max staleness in seconds. null = don't change. */
    maxStalenessSeconds: number | null;
    /** Circuit breaker: max deviation from EMA in bps. 0 = disabled. null = don't change. */
    circuitBreakerDeviationBps: number | null;
}
export interface SetFallbackOracleParams {
    fallbackOracleSource: OracleSource;
    fallbackOracleAddress: PublicKey;
}
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
    warmupProgress: number;
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
//# sourceMappingURL=types.d.ts.map