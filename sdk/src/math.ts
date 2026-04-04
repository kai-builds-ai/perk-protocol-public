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
  return parseFloat(scaled.toString()) / 1e12;
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

/** Calculate funding PnL from K-coefficient difference.
 *  fundingPnl = |basis| * (kSide - kSnapshot) / (aSnapshot * POS_SCALE)
 *  where kSide = longKIndex for longs, shortKIndex for shorts.
 *  Returns a signed BN in collateral-token units (positive = earned, negative = paid). */
export function calculateFundingPnl(
  position: UserPositionAccount,
  market: MarketAccount,
): BN {
  const basis = position.basis;
  if (basis.isZero()) return ZERO;

  const isLong = !basis.isNeg();
  const absBasis = basis.abs();
  const aBasis = position.aSnapshot;
  if (aBasis.isZero()) return ZERO;

  // Epoch mismatch → position was wiped, no pending funding
  const epochSide = isLong ? market.longEpoch : market.shortEpoch;
  if (!position.epochSnapshot.eq(epochSide)) return ZERO;

  const kSide = isLong ? market.longKIndex : market.shortKIndex;
  const kSnap = position.kSnapshot;
  const kDiff = kSide.sub(kSnap);

  if (kDiff.isZero()) return ZERO;

  // pnl = |basis| * kDiff / (aBasis * POS_SCALE)
  const den = aBasis.mul(BN_POS_SCALE);
  const num = absBasis.mul(kDiff);
  // Signed division (floor toward negative infinity for negative numerator)
  const isNeg = num.isNeg();
  const absResult = num.abs().div(den);
  return isNeg ? absResult.neg() : absResult;
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

// ── Settle Funding Prediction ──

export interface SettleFundingPrediction {
  /** Human-readable USD change to collateral (can be negative) */
  collateralDelta: number;
  /** The raw K-diff funding PnL (what we currently show) */
  grossFundingPnl: number;
  /** Amount deducted by settle_losses */
  lossSettled: number;
  /** Amount added by do_profit_conversion (after haircut) */
  profitConverted: number;
  /** Amount deducted by fee_debt_sweep */
  feeDebtSwept: number;
  /** Haircut percentage applied (0 = no haircut, 100 = full haircut) */
  haircutPercent: number;
}

/**
 * Predict what `settle_funding` will actually do to collateral.
 *
 * Replicates the on-chain flow:
 *   1. Accrue funding PnL (K-diff) → add to position.pnl
 *   2. Advance warmup → release matured reserved PnL
 *   3. Settle losses → if pnl < 0, deduct from collateral
 *   4. Profit conversion → released matured PnL * haircut → add to collateral
 *   5. Fee debt sweep → deduct outstanding fee debt from collateral
 *
 * All intermediate math uses BN (arbitrary precision). Only converts to
 * human-readable numbers at the very end.
 */
export function predictSettleFunding(
  position: UserPositionAccount,
  market: MarketAccount,
  currentSlot: number,
): SettleFundingPrediction {
  // ── Step 0: Snapshot initial collateral ──
  const initialCollateral = new BN(position.depositedCollateral.toString());

  // ── Step 1: Compute K-diff funding PnL (same as calculateFundingPnl) ──
  const fundingPnlBN = calculateFundingPnl(position, market);

  // ── Step 1b: Simulate set_pnl (on-chain settle_side_effects calls set_pnl) ──
  // set_pnl modifies reserved_pnl: new profit goes to reserved, losses shrink reserved.
  const oldPnl = new BN(position.pnl.toString());
  const oldPosPnl = oldPnl.isNeg() ? ZERO : new BN(oldPnl.toString());
  const oldR = new BN(position.reservedPnl.toString());

  // Post-accrue PnL = position.pnl + fundingPnl
  let pnl = oldPnl.add(fundingPnlBN);
  const newPosPnl = pnl.isNeg() ? ZERO : new BN(pnl.toString());

  // Replicate set_pnl's reserved_pnl logic (spec §4.4 steps 7-8):
  // If positive PnL increased: all new positive goes to reserved
  // If positive PnL decreased: reserved shrinks by the loss (saturating)
  let reservedPnl: BN;
  if (newPosPnl.gt(oldPosPnl)) {
    const reserveAdd = newPosPnl.sub(oldPosPnl);
    reservedPnl = oldR.add(reserveAdd);
  } else {
    const posLoss = oldPosPnl.sub(newPosPnl);
    reservedPnl = oldR.gt(posLoss) ? oldR.sub(posLoss) : ZERO;
  }

  // ── Step 2: Advance warmup (release matured reserved PnL) ──
  const warmupPeriod = market.warmupPeriodSlots;
  const currentSlotBN = new BN(currentSlot);

  if (!reservedPnl.isZero()) {
    const rIncreased = reservedPnl.gt(oldR);

    if (warmupPeriod.isZero()) {
      // Instant release: all reserved PnL matures
      // On-chain: advance_warmup sets R = 0 when warmup_period = 0
      // If R increased, restart_warmup_after_reserve_increase also sets R = 0 when t = 0
      reservedPnl = ZERO;
    } else if (rIncreased) {
      // After set_pnl increases R, settle_side_effects calls restart_warmup.
      // restart_warmup sets: slope = max(1, new_R / period), started_at = market.current_slot
      // Then advance_warmup runs with clock.slot = market.current_slot → elapsed = 0.
      // Nothing is released. reservedPnl stays as-is.
    } else {
      // R did not increase — use existing slope and warmup state
      const elapsed = currentSlotBN.sub(position.warmupStartedAtSlot);
      if (elapsed.gtn(0)) {
        // On-chain uses position.warmup_slope directly (no fallback)
        const slope = position.warmupSlope;
        const cap = slope.mul(elapsed);
        const release = BN.min(reservedPnl, cap);
        reservedPnl = reservedPnl.sub(release);
      }
    }
  }

  // ── Step 3: Settle losses (if pnl < 0, deduct from collateral) ──
  let collateral = new BN(initialCollateral.toString());
  let lossSettled = ZERO;

  if (pnl.isNeg()) {
    const need = pnl.abs();
    const pay = BN.min(need, collateral);
    if (pay.gtn(0)) {
      collateral = collateral.sub(pay);
      pnl = pnl.add(pay);
      lossSettled = pay;
    }
  }

  // ── Step 4: Released pos = max(pnl, 0) - reserved_pnl ──
  const posPnl = pnl.isNeg() ? ZERO : pnl;
  const released = posPnl.gt(reservedPnl) ? posPnl.sub(reservedPnl) : ZERO;

  // ── Step 5: Haircut ratio + profit conversion ──
  let profitConverted = ZERO;
  let haircutNum = ZERO;
  let haircutDen = ZERO;

  if (released.gtn(0)) {
    // Compute haircut ratio: h = min(residual, matured_pos_tot) / matured_pos_tot
    const maturedPosTot = new BN(market.pnlMaturedPosTot.toString());

    if (maturedPosTot.isZero()) {
      // No matured positions → ratio is 1/1 (no haircut)
      haircutNum = new BN(1);
      haircutDen = new BN(1);
    } else {
      // Senior claims: c_tot + insurance + claimable fees
      const claimable = market.creatorClaimableFees.add(market.protocolClaimableFees);
      const seniorSum = market.cTot
        .add(new BN(market.insuranceFundBalance.toString()))
        .add(claimable);
      const vaultBal = new BN(market.vaultBalance.toString());
      const residual = vaultBal.gt(seniorSum) ? vaultBal.sub(seniorSum) : ZERO;

      haircutNum = BN.min(residual, maturedPosTot);
      haircutDen = maturedPosTot;
    }

    // y = released * h_num / h_den (floor division)
    if (haircutDen.isZero()) {
      profitConverted = released;
    } else {
      profitConverted = released.mul(haircutNum).div(haircutDen);
    }

    // On-chain: consume_released_pnl subtracts released (x) from pnl
    // Then adds profitConverted (y) to collateral
    collateral = collateral.add(profitConverted);
    pnl = pnl.sub(released);
  }

  // ── Step 6: Fee debt sweep ──
  // fee_credits is i128. Negative = debt.
  let feeDebtSwept = ZERO;
  const feeCredits = new BN(position.feeCredits.toString());
  if (feeCredits.isNeg()) {
    const debt = feeCredits.abs();
    const pay = BN.min(debt, collateral);
    if (pay.gtn(0)) {
      collateral = collateral.sub(pay);
      feeDebtSwept = pay;
    }
  }

  // ── Convert to human-readable (USDC has 6 decimals) ──
  const USDC_DECIMALS = 6;
  const scale = Math.pow(10, USDC_DECIMALS);

  const collateralDeltaBN = collateral.sub(initialCollateral);
  // For BN → number conversion, handle sign properly
  const collateralDelta = collateralDeltaBN.isNeg()
    ? -(collateralDeltaBN.abs().toNumber() / scale)
    : collateralDeltaBN.toNumber() / scale;

  const grossFundingPnl = fundingPnlBN.isNeg()
    ? -(fundingPnlBN.abs().toNumber() / scale)
    : fundingPnlBN.toNumber() / scale;

  // Haircut percent: 0 = no haircut (100% converted), 100 = full haircut (0% converted)
  let haircutPercent = 0;
  if (!haircutDen.isZero()) {
    const PREC = new BN("10000"); // basis points precision
    const ratio = haircutNum.mul(PREC).div(haircutDen);
    haircutPercent = 100 - (ratio.toNumber() / 100); // convert basis points to percent
  }

  return {
    collateralDelta,
    grossFundingPnl,
    lossSettled: lossSettled.toNumber() / scale,
    profitConverted: profitConverted.toNumber() / scale,
    feeDebtSwept: feeDebtSwept.toNumber() / scale,
    haircutPercent: Math.max(0, Math.min(100, haircutPercent)),
  };
}
