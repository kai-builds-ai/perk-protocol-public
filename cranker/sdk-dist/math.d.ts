import BN from "bn.js";
import { MarketAccount, UserPositionAccount, Side } from "./types";
/** Convert on-chain scaled price (u64, 6 decimals) to human-readable number. */
export declare function priceToNumber(price: BN): number;
/** Convert human-readable price to on-chain scaled price. */
export declare function numberToPrice(price: number): BN;
/** Convert on-chain token amount (with decimals) to human-readable. */
export declare function amountToNumber(amount: BN, decimals?: number): number;
/** Calculate the vAMM mark price (returns human-readable number). */
export declare function calculateMarkPrice(market: MarketAccount): number;
/** Estimate execution price for a trade (constant product, returns human-readable). */
export declare function estimateExecutionPrice(market: MarketAccount, side: Side, baseSize: BN): number;
/** Calculate slippage in BPS between execution price and mark price. */
export declare function calculateSlippageBps(executionPrice: number, markPrice: number): number;
/** Calculate effective position size (accounts for ADL A-coefficient + epoch). */
export declare function effectivePositionQ(position: UserPositionAccount, market: MarketAccount): BN;
/** Calculate notional value of a position (BN, raw on-chain units). */
export declare function calculateNotionalBN(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): BN;
/** Calculate notional value (human-readable number, for display).
 *  Uses BN precision internally; converts to JS Number at the end.
 *  Note: for notional > Number.MAX_SAFE_INTEGER (~9e15) precision degrades
 *  due to IEEE 754 limits. Use calculateNotionalBN for exact values. */
export declare function calculateNotional(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): number;
/** Compute account equity matching on-chain logic.
 *  equity = max(0, collateral + pnl - feeDebt) */
export declare function accountEquity(position: UserPositionAccount): BN;
/** Calculate initial margin requirement in BPS for a given leverage. */
export declare function initialMarginBps(maxLeverage: number): number;
/** Check if position is above maintenance margin (matches on-chain). */
export declare function isAboveMaintenanceMargin(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): boolean;
/** Check if position is liquidatable. */
export declare function isLiquidatable(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): boolean;
/** Calculate margin ratio for a position (for display). */
export declare function marginRatio(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): number;
/** Estimate liquidation price for a position (human-readable, e.g. 150.0 for $150).
 *
 *  Uses closed-form solution derived from on-chain K-diff PnL model:
 *    pnl_delta(P) = |basis| * A_mult * (P - P_last) / (a_basis * POS_SCALE)
 *    notional(P)  = |effQ| * P / POS_SCALE
 *
 *  Liquidation occurs when equity <= mm_requirement:
 *    equity_now + pnl_delta(P) = |effQ| * P * mmBps / (POS_SCALE * 10000)
 *
 *  Both sides are linear in P → solve directly. O(1), no binary search.
 *
 *  Approximation: ignores funding accrual between now and liquidation
 *  (funding is time-dependent, not price-dependent). For UI display. */
export declare function estimateLiquidationPrice(position: UserPositionAccount, market: MarketAccount, oraclePrice: BN): number | null;
/** Calculate trading fee for a given notional. */
export declare function calculateFee(notional: number, feeBps: number): number;
/** Calculate funding rate (annualized %). */
export declare function fundingRateAnnualized(market: MarketAccount): number;
/** Calculate warmup progress (0 to 1).
 *  Matches on-chain slope-based model: slope = max(1, R / period).
 *  Release cap = slope * elapsed; progress = min(cap, R) / R. */
export declare function warmupProgress(position: UserPositionAccount, market: MarketAccount, currentSlot: BN): number;
/** Calculate haircut ratio (what fraction of matured PnL is withdrawable).
 *  Matches on-chain risk::haircut_ratio() — computed dynamically from market state. */
export declare function haircutRatio(market: MarketAccount): number;
//# sourceMappingURL=math.d.ts.map