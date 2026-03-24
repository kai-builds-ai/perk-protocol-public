// @perk/sdk — TypeScript SDK for the Perk perpetual futures protocol on Solana

export { PerkClient } from "./client";
export type { PerkClientConfig } from "./client";

export { PerkCranker } from "./cranker";
export type { CrankerConfig, CrankerMetrics } from "./cranker";

export {
  findProtocolAddress,
  findMarketAddress,
  findPositionAddress,
  findVaultAddress,
  findTriggerOrderAddress,
} from "./pda";

export {
  calculateMarkPrice,
  estimateExecutionPrice,
  calculateSlippageBps,
  effectivePositionQ,
  calculateNotional,
  initialMarginBps,
  marginRatio,
  isLiquidatable,
  estimateLiquidationPrice,
  calculateFee,
  fundingRateAnnualized,
  warmupProgress,
  haircutRatio,
  priceToNumber,
  numberToPrice,
  amountToNumber,
  accountEquity,
  calculateNotionalBN,
  isAboveMaintenanceMargin,
} from "./math";

export {
  PERK_PROGRAM_ID,
  PROTOCOL_SEED,
  MARKET_SEED,
  POSITION_SEED,
  VAULT_SEED,
  TRIGGER_SEED,
  MIN_LEVERAGE,
  MAX_LEVERAGE,
  LEVERAGE_SCALE,
  MIN_TRADING_FEE_BPS,
  MAX_TRADING_FEE_BPS,
  DEFAULT_TRADING_FEE_BPS,
  LIQUIDATION_FEE_BPS,
  MAINTENANCE_MARGIN_BPS,
  CREATOR_FEE_SHARE_BPS,
  PRICE_SCALE,
  POS_SCALE,
  ADL_ONE,
  K_SCALE,
  MIN_INITIAL_K,
  DEFAULT_MARKET_CREATION_FEE,
  FUNDING_RATE_PRECISION,
  MAX_FUNDING_ITERATIONS,
  FUNDING_RATE_CAP_BPS,
  PEG_UPDATE_COOLDOWN_SLOTS,
  AMM_PEG_THRESHOLD_BPS,
  ORACLE_STALENESS_SECONDS,
  INSURANCE_EPOCH_SECONDS,
  INSURANCE_EPOCH_CAP_BPS,
  WARMUP_PERIOD_SLOTS,
  MAX_TRIGGER_ORDERS,
  BPS_DENOMINATOR,
  PYTH_PROGRAM_ID,
  PYTH_SOL_USD_FEED,
  MAX_FUNDING_DT,
  MIN_REMAINING_POSITION_SIZE,
  MIN_RECLAIM_DELAY_SLOTS,
  DUST_THRESHOLD,
  MIN_NONZERO_MM_REQ,
  MIN_NONZERO_IM_REQ,
  LIQUIDATOR_SHARE_BPS,
  TRIGGER_EXECUTION_FEE_BPS,
  MIN_DEPOSIT_AMOUNT,
  MIN_A_SIDE,
  MAX_TRIGGER_ORDER_AGE_SECONDS,
} from "./constants";

export {
  Side,
  OracleSource,
  SideState,
  TriggerOrderType,
} from "./types";

export type {
  ProtocolAccount,
  MarketAccount,
  UserPositionAccount,
  TriggerOrderAccount,
  CreateMarketParams,
  AdminUpdateMarketParams,
  TriggerOrderParams,
  PositionInfo,
  MarketInfo,
} from "./types";
