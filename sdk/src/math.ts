import BN from "bn.js";
import {
  PRICE_SCALE,
  POS_SCALE,
  BPS_DENOMINATOR,
  MAINTENANCE_MARGIN_BPS,
  LEVERAGE_SCALE,
  FUNDING_RATE_PRECISION,
} from "./constants";
import { MarketAccount, UserPositionAccount, Side } from "./types";

const ZERO = new BN(0);
const BN_PRICE_SCALE = new BN(PRICE_SCALE);
const BN_POS_SCALE = new BN(POS_SCALE);
const BN_BPS_DENOM = new BN(BPS_DENOMINATOR);
const MIN_NONZERO_MM_REQ = new BN(10_000);

// ── Price Helpers ──

/** Convert on-chain scaled price (u64, 6 decimals) to human-readable number. */
export function priceToNumber(price: BN): number {
  return price.toNumber() / PRICE_SCALE;
}

/** Convert human-readable price to on-chain scaled price. */
export function numberToPrice(price: number): BN {
  return new BN(Math.round(price * PRICE_SCALE));
}

/** Convert on-chain token amount (with decimals) to human-readable. */
export function amountToNumber(amount: BN, decimals: number = 9): number {
  return amount.toNumber() / Math.pow(10, decimals);
}

// ── vAMM Math ──

/** Calculate the vAMM mark price (returns human-readable number). */
export function calculateMarkPrice(market: MarketAccount): number {
  if (market.baseReserve.isZero()) return 0;
  // mark = quote_reserve * peg_multiplier / (base_reserve * PRICE_SCALE)
  // Use BN arithmetic to avoid u128 overflow, convert to number at the end
  const numerator = market.quoteReserve.mul(market.pegMultiplier);
  const denominator = market.baseReserve.mul(BN_PRICE_SCALE);
  // Result is a ratio close to 1.0 for balanced reserves, safe to convert
  // Use high-precision: multiply numerator by 1e12 first, divide, then divide by 1e12
  const PRECISION = new BN("1000000000000");
  const scaled = numerator.mul(PRECISION).div(denominator);
  return scaled.toNumber() / 1e12;
}

/** Estimate execution price for a trade (constant product, returns human-readable). */
export function estimateExecutionPrice(
  market: MarketAccount,
  side: Side,
  baseSize: BN
): number {
  const base = market.baseReserve;
  const quote = market.quoteReserve;
  const peg = market.pegMultiplier;
  const k = market.k; // Use stored k, not recomputed (avoids rounding drift)

  if (side === Side.Long) {
    const newBase = base.sub(baseSize);
    if (newBase.isZero() || newBase.isNeg()) return Infinity;
    const newQuote = k.div(newBase);
    const quoteDelta = newQuote.sub(quote);
    // exec_price = quoteDelta * peg / (size * PRICE_SCALE)
    const PRECISION = new BN("1000000000000");
    const num = quoteDelta.mul(peg).mul(PRECISION);
    const den = baseSize.mul(BN_PRICE_SCALE);
    return num.div(den).toNumber() / 1e12;
  } else {
    const newBase = base.add(baseSize);
    const newQuote = k.div(newBase);
    const quoteDelta = quote.sub(newQuote);
    const PRECISION = new BN("1000000000000");
    const num = quoteDelta.mul(peg).mul(PRECISION);
    const den = baseSize.mul(BN_PRICE_SCALE);
    return num.div(den).toNumber() / 1e12;
  }
}

/** Calculate slippage in BPS between execution price and mark price. */
export function calculateSlippageBps(
  executionPrice: number,
  markPrice: number
): number {
  if (markPrice === 0) return 0;
  return Math.abs(((executionPrice - markPrice) / markPrice) * BPS_DENOMINATOR);
}

// ── Position Math ──

/** Get the epoch for a side from the market. */
function getEpochSide(market: MarketAccount, isLong: boolean): BN {
  return isLong ? market.longEpoch : market.shortEpoch;
}

/** Calculate effective position size (accounts for ADL A-coefficient + epoch). */
export function effectivePositionQ(
  position: UserPositionAccount,
  market: MarketAccount
): BN {
  const basis = position.basis;
  if (basis.isZero()) return ZERO;

  const isLong = !basis.isNeg();
  const absBasis = basis.abs();
  const aSide = isLong ? market.longA : market.shortA;
  const aBasis = position.aSnapshot;

  // Epoch mismatch check — position was wiped by ADL reset
  const epochSide = getEpochSide(market, isLong);
  if (!position.epochSnapshot.eq(epochSide)) return ZERO;

  if (aBasis.isZero()) return ZERO;

  // floor(|basis| * a_side / a_basis)
  const result = absBasis.mul(aSide).div(aBasis);
  return basis.isNeg() ? result.neg() : result;
}

/** Calculate notional value of a position (BN, raw on-chain units). */
export function calculateNotionalBN(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): BN {
  const effQ = effectivePositionQ(position, market);
  if (effQ.isZero()) return ZERO;
  // notional = |eff| * price / POS_SCALE
  return effQ.abs().mul(oraclePrice).div(BN_POS_SCALE);
}

/** Calculate notional value (human-readable number, for display).
 *  Uses BN precision internally; converts to JS Number at the end.
 *  Note: for notional > Number.MAX_SAFE_INTEGER (~9e15) precision degrades
 *  due to IEEE 754 limits. Use calculateNotionalBN for exact values. */
export function calculateNotional(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): number {
  const notional = calculateNotionalBN(position, market, oraclePrice);
  // For values within safe integer range, convert directly (lossless)
  if (notional.bitLength() <= 53) return notional.toNumber();
  // For large values, go through string to avoid intermediate overflow
  return parseFloat(notional.toString());
}

/** Compute account equity matching on-chain logic.
 *  equity = max(0, collateral + pnl - feeDebt) */
export function accountEquity(position: UserPositionAccount): BN {
  const collateral = position.depositedCollateral;
  const pnl = position.pnl; // i128 (can be negative)
  const feeCredits = position.feeCredits; // i128 (negative = debt)

  // fee_debt = abs(min(0, feeCredits))
  const feeDebt = feeCredits.isNeg() ? feeCredits.abs() : ZERO;

  // equity_raw = collateral + pnl - feeDebt
  let equityRaw = new BN(collateral.toString()).add(pnl).sub(feeDebt);

  // Clamp to 0 (matches on-chain max(0, eq_raw))
  if (equityRaw.isNeg()) equityRaw = ZERO;
  return equityRaw;
}

/** Calculate initial margin requirement in BPS for a given leverage. */
export function initialMarginBps(maxLeverage: number): number {
  const leverageActual = Math.floor(maxLeverage / LEVERAGE_SCALE);
  if (leverageActual <= 0) return BPS_DENOMINATOR;
  const raw = Math.floor(BPS_DENOMINATOR / leverageActual);
  return Math.max(raw, MAINTENANCE_MARGIN_BPS + 1);
}

/** Check if position is above maintenance margin (matches on-chain). */
export function isAboveMaintenanceMargin(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): boolean {
  const equity = accountEquity(position);
  const notional = calculateNotionalBN(position, market, oraclePrice);

  // mm_req = notional * market.maintenanceMarginBps / 10000
  const mmBps = new BN(market.maintenanceMarginBps);
  let mmReq = notional.mul(mmBps).div(BN_BPS_DENOM);

  // Apply MIN_NONZERO_MM_REQ floor for non-zero positions
  if (!notional.isZero()) {
    mmReq = BN.max(mmReq, MIN_NONZERO_MM_REQ);
  }

  // On-chain: eq_net > mm_req (strictly greater)
  return equity.gt(mmReq);
}

/** Check if position is liquidatable. */
export function isLiquidatable(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): boolean {
  const effQ = effectivePositionQ(position, market);
  if (effQ.isZero() && position.baseSize.isZero()) return false;
  return !isAboveMaintenanceMargin(position, market, oraclePrice);
}

/** Calculate margin ratio for a position (for display). */
export function marginRatio(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): number {
  const notional = calculateNotional(position, market, oraclePrice);
  if (notional === 0) return Infinity;
  const equity = accountEquity(position);
  return equity.toNumber() / notional;
}

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
export function estimateLiquidationPrice(
  position: UserPositionAccount,
  market: MarketAccount,
  oraclePrice: BN
): number | null {
  const effQ = effectivePositionQ(position, market);
  if (effQ.isZero()) return null;

  const isLong = !effQ.isNeg();
  const currentPriceHuman = oraclePrice.toNumber() / PRICE_SCALE;

  // Already liquidatable
  if (isLiquidatable(position, market, oraclePrice)) {
    return currentPriceHuman;
  }

  // Current equity (scalar, can use .toNumber() — equity is clamped to u64 range)
  const equity = accountEquity(position);
  const equityNum = equity.toNumber();

  // PnL sensitivity to price: how much PnL changes per unit of scaled price.
  // On-chain: pnl_delta = |basis| * A_mult * delta_P / (a_basis * POS_SCALE)
  // where A_mult = longA or shortA (the market-level ADL multiplier).
  //
  // The position's a_basis (aSnapshot) was set to A_mult at position open,
  // so |basis| * A_mult / a_basis = |effQ| (the effective position size).
  // This means: pnl_delta = |effQ| * delta_P / POS_SCALE
  //
  // In human price units (dividing scaled price by PRICE_SCALE):
  //   pnl_per_unit = |effQ| * PRICE_SCALE / POS_SCALE
  const absEffQ = effQ.abs().toNumber();
  const pnlPerUnit = absEffQ * PRICE_SCALE / POS_SCALE;

  // MM requirement per unit price:
  //   mm_per_unit = |effQ| * mmBps / (POS_SCALE * 10000)
  //   In human price units: mm_per_unit_human = |effQ| * PRICE_SCALE * mmBps / (POS_SCALE * 10000)
  const mmBps = market.maintenanceMarginBps;
  const mmPerUnit = absEffQ * PRICE_SCALE * mmBps / (POS_SCALE * BPS_DENOMINATOR);

  // Solve: equity + sign * pnlPerUnit * (P - currentPrice) = mmPerUnit * P
  // where sign = +1 for longs (price up = profit), -1 for shorts (price down = profit)
  //
  // For longs:  equity + pnlPerUnit * P - pnlPerUnit * currentPrice = mmPerUnit * P
  //             equity - pnlPerUnit * currentPrice = P * (mmPerUnit - pnlPerUnit)
  //             P = (equity - pnlPerUnit * currentPrice) / (mmPerUnit - pnlPerUnit)
  //
  // For shorts: equity - pnlPerUnit * P + pnlPerUnit * currentPrice = mmPerUnit * P
  //             equity + pnlPerUnit * currentPrice = P * (mmPerUnit + pnlPerUnit)
  //             P = (equity + pnlPerUnit * currentPrice) / (mmPerUnit + pnlPerUnit)

  let liqPrice: number;
  if (isLong) {
    const denominator = mmPerUnit - pnlPerUnit;
    // If denominator >= 0, longs can't be liquidated (MM requirement grows
    // slower than equity — position is always solvent as price rises)
    if (denominator >= 0) return null;
    liqPrice = (equityNum - pnlPerUnit * currentPriceHuman) / denominator;
  } else {
    const denominator = mmPerUnit + pnlPerUnit;
    if (denominator <= 0) return null; // Can't happen for valid positions
    liqPrice = (equityNum + pnlPerUnit * currentPriceHuman) / denominator;
  }

  // Sanity: price must be positive
  if (liqPrice <= 0) return null;

  // Sanity: longs liquidate below current price, shorts above
  if (isLong && liqPrice >= currentPriceHuman) return currentPriceHuman;
  if (!isLong && liqPrice <= currentPriceHuman) return currentPriceHuman;

  return liqPrice;
}

/** Calculate trading fee for a given notional. */
export function calculateFee(notional: number, feeBps: number): number {
  return Math.ceil((notional * feeBps) / BPS_DENOMINATOR);
}

/** Calculate funding rate (annualized %). */
export function fundingRateAnnualized(market: MarketAccount): number {
  const ratePerSlot = market.fundingRateBpsPerSlotLast.toNumber();
  // ~2.5 slots per second on Solana
  const slotsPerYear = 2.5 * 86400 * 365;
  return (ratePerSlot * slotsPerYear) / (FUNDING_RATE_PRECISION * 100);
}

/** Calculate warmup progress (0 to 1).
 *  Matches on-chain slope-based model: slope = max(1, R / period).
 *  Release cap = slope * elapsed; progress = min(cap, R) / R. */
export function warmupProgress(
  position: UserPositionAccount,
  market: MarketAccount,
  currentSlot: BN
): number {
  if (position.reservedPnl.isZero()) return 1;
  const period = market.warmupPeriodSlots;
  if (period.isZero()) return 1;

  // On-chain: slope = max(1, reserved_pnl / warmup_period_slots)
  // The position stores warmupSlope set at warmup start.
  const slope = position.warmupSlope.isZero()
    ? BN.max(new BN(1), position.reservedPnl.div(period))
    : position.warmupSlope;

  const elapsed = currentSlot.sub(position.warmupStartedAtSlot);
  if (elapsed.isNeg()) return 0;

  // cap = slope * elapsed (saturating)
  const cap = slope.mul(elapsed);
  // released = min(reserved_pnl, cap)
  const released = BN.min(position.reservedPnl, cap);

  // Progress = released / reserved_pnl
  if (position.reservedPnl.isZero()) return 1;
  return released.toNumber() / position.reservedPnl.toNumber();
}

/** Calculate haircut ratio (what fraction of matured PnL is withdrawable).
 *  Matches on-chain risk::haircut_ratio() — computed dynamically from market state. */
export function haircutRatio(market: MarketAccount): number {
  // If no matured positive PnL, ratio is 1 (no haircut needed)
  if (market.pnlMaturedPosTot.isZero()) return 1;

  // Senior claims: c_tot + insurance + claimable fees
  const claimable = market.creatorClaimableFees.add(market.protocolClaimableFees);
  const seniorSum = market.cTot
    .add(new BN(market.insuranceFundBalance.toString()))
    .add(claimable);

  // Residual = vault_balance - senior_claims (clamped to 0)
  const vaultBal = new BN(market.vaultBalance.toString());
  const residual = vaultBal.gt(seniorSum) ? vaultBal.sub(seniorSum) : ZERO;

  // h = min(residual, pnl_matured_pos_tot) / pnl_matured_pos_tot
  const hNum = BN.min(residual, market.pnlMaturedPosTot);
  const hDen = market.pnlMaturedPosTot;

  if (hDen.isZero()) return 1;
  // Use BN precision to avoid .toNumber() overflow on large pnl_matured_pos_tot
  const RATIO_PRECISION = new BN("1000000000000"); // 1e12
  const scaled = hNum.mul(RATIO_PRECISION).div(hDen);
  return scaled.toNumber() / 1e12;
}
