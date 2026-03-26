"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.priceToNumber = priceToNumber;
exports.numberToPrice = numberToPrice;
exports.amountToNumber = amountToNumber;
exports.calculateMarkPrice = calculateMarkPrice;
exports.estimateExecutionPrice = estimateExecutionPrice;
exports.calculateSlippageBps = calculateSlippageBps;
exports.effectivePositionQ = effectivePositionQ;
exports.calculateNotionalBN = calculateNotionalBN;
exports.calculateNotional = calculateNotional;
exports.accountEquity = accountEquity;
exports.initialMarginBps = initialMarginBps;
exports.isAboveMaintenanceMargin = isAboveMaintenanceMargin;
exports.isLiquidatable = isLiquidatable;
exports.marginRatio = marginRatio;
exports.estimateLiquidationPrice = estimateLiquidationPrice;
exports.calculateFee = calculateFee;
exports.fundingRateAnnualized = fundingRateAnnualized;
exports.warmupProgress = warmupProgress;
exports.haircutRatio = haircutRatio;
const bn_js_1 = __importDefault(require("bn.js"));
const constants_1 = require("./constants");
const types_1 = require("./types");
const ZERO = new bn_js_1.default(0);
const BN_PRICE_SCALE = new bn_js_1.default(constants_1.PRICE_SCALE);
const BN_POS_SCALE = new bn_js_1.default(constants_1.POS_SCALE);
const BN_BPS_DENOM = new bn_js_1.default(constants_1.BPS_DENOMINATOR);
const MIN_NONZERO_MM_REQ = new bn_js_1.default(10000);
// ── Price Helpers ──
/** Convert on-chain scaled price (u64, 6 decimals) to human-readable number. */
function priceToNumber(price) {
    return price.toNumber() / constants_1.PRICE_SCALE;
}
/** Convert human-readable price to on-chain scaled price. */
function numberToPrice(price) {
    return new bn_js_1.default(Math.round(price * constants_1.PRICE_SCALE));
}
/** Convert on-chain token amount (with decimals) to human-readable. */
function amountToNumber(amount, decimals = 9) {
    return amount.toNumber() / Math.pow(10, decimals);
}
// ── vAMM Math ──
/** Calculate the vAMM mark price (returns human-readable number). */
function calculateMarkPrice(market) {
    if (market.baseReserve.isZero())
        return 0;
    // mark = quote_reserve * peg_multiplier / (base_reserve * PRICE_SCALE)
    // Use BN arithmetic to avoid u128 overflow, convert to number at the end
    const numerator = market.quoteReserve.mul(market.pegMultiplier);
    const denominator = market.baseReserve.mul(BN_PRICE_SCALE);
    // Result is a ratio close to 1.0 for balanced reserves, safe to convert
    // Use high-precision: multiply numerator by 1e12 first, divide, then divide by 1e12
    const PRECISION = new bn_js_1.default("1000000000000");
    const scaled = numerator.mul(PRECISION).div(denominator);
    return scaled.toNumber() / 1e12;
}
/** Estimate execution price for a trade (constant product, returns human-readable). */
function estimateExecutionPrice(market, side, baseSize) {
    const base = market.baseReserve;
    const quote = market.quoteReserve;
    const peg = market.pegMultiplier;
    const k = market.k; // Use stored k, not recomputed (avoids rounding drift)
    if (side === types_1.Side.Long) {
        const newBase = base.sub(baseSize);
        if (newBase.isZero() || newBase.isNeg())
            return Infinity;
        const newQuote = k.div(newBase);
        const quoteDelta = newQuote.sub(quote);
        // exec_price = quoteDelta * peg / (size * PRICE_SCALE)
        const PRECISION = new bn_js_1.default("1000000000000");
        const num = quoteDelta.mul(peg).mul(PRECISION);
        const den = baseSize.mul(BN_PRICE_SCALE);
        return num.div(den).toNumber() / 1e12;
    }
    else {
        const newBase = base.add(baseSize);
        const newQuote = k.div(newBase);
        const quoteDelta = quote.sub(newQuote);
        const PRECISION = new bn_js_1.default("1000000000000");
        const num = quoteDelta.mul(peg).mul(PRECISION);
        const den = baseSize.mul(BN_PRICE_SCALE);
        return num.div(den).toNumber() / 1e12;
    }
}
/** Calculate slippage in BPS between execution price and mark price. */
function calculateSlippageBps(executionPrice, markPrice) {
    if (markPrice === 0)
        return 0;
    return Math.abs(((executionPrice - markPrice) / markPrice) * constants_1.BPS_DENOMINATOR);
}
// ── Position Math ──
/** Get the epoch for a side from the market. */
function getEpochSide(market, isLong) {
    return isLong ? market.longEpoch : market.shortEpoch;
}
/** Calculate effective position size (accounts for ADL A-coefficient + epoch). */
function effectivePositionQ(position, market) {
    const basis = position.basis;
    if (basis.isZero())
        return ZERO;
    const isLong = !basis.isNeg();
    const absBasis = basis.abs();
    const aSide = isLong ? market.longA : market.shortA;
    const aBasis = position.aSnapshot;
    // Epoch mismatch check — position was wiped by ADL reset
    const epochSide = getEpochSide(market, isLong);
    if (!position.epochSnapshot.eq(epochSide))
        return ZERO;
    if (aBasis.isZero())
        return ZERO;
    // floor(|basis| * a_side / a_basis)
    const result = absBasis.mul(aSide).div(aBasis);
    return basis.isNeg() ? result.neg() : result;
}
/** Calculate notional value of a position (BN, raw on-chain units). */
function calculateNotionalBN(position, market, oraclePrice) {
    const effQ = effectivePositionQ(position, market);
    if (effQ.isZero())
        return ZERO;
    // notional = |eff| * price / POS_SCALE
    return effQ.abs().mul(oraclePrice).div(BN_POS_SCALE);
}
/** Calculate notional value (human-readable number, for display).
 *  Uses BN precision internally; converts to JS Number at the end.
 *  Note: for notional > Number.MAX_SAFE_INTEGER (~9e15) precision degrades
 *  due to IEEE 754 limits. Use calculateNotionalBN for exact values. */
function calculateNotional(position, market, oraclePrice) {
    const notional = calculateNotionalBN(position, market, oraclePrice);
    // For values within safe integer range, convert directly (lossless)
    if (notional.bitLength() <= 53)
        return notional.toNumber();
    // For large values, go through string to avoid intermediate overflow
    return parseFloat(notional.toString());
}
/** Compute account equity matching on-chain logic.
 *  equity = max(0, collateral + pnl - feeDebt) */
function accountEquity(position) {
    const collateral = position.depositedCollateral;
    const pnl = position.pnl; // i128 (can be negative)
    const feeCredits = position.feeCredits; // i128 (negative = debt)
    // fee_debt = abs(min(0, feeCredits))
    const feeDebt = feeCredits.isNeg() ? feeCredits.abs() : ZERO;
    // equity_raw = collateral + pnl - feeDebt
    let equityRaw = new bn_js_1.default(collateral.toString()).add(pnl).sub(feeDebt);
    // Clamp to 0 (matches on-chain max(0, eq_raw))
    if (equityRaw.isNeg())
        equityRaw = ZERO;
    return equityRaw;
}
/** Calculate initial margin requirement in BPS for a given leverage. */
function initialMarginBps(maxLeverage) {
    const leverageActual = Math.floor(maxLeverage / constants_1.LEVERAGE_SCALE);
    if (leverageActual <= 0)
        return constants_1.BPS_DENOMINATOR;
    const raw = Math.floor(constants_1.BPS_DENOMINATOR / leverageActual);
    return Math.max(raw, constants_1.MAINTENANCE_MARGIN_BPS + 1);
}
/** Check if position is above maintenance margin (matches on-chain). */
function isAboveMaintenanceMargin(position, market, oraclePrice) {
    const equity = accountEquity(position);
    const notional = calculateNotionalBN(position, market, oraclePrice);
    // mm_req = notional * market.maintenanceMarginBps / 10000
    const mmBps = new bn_js_1.default(market.maintenanceMarginBps);
    let mmReq = notional.mul(mmBps).div(BN_BPS_DENOM);
    // Apply MIN_NONZERO_MM_REQ floor for non-zero positions
    if (!notional.isZero()) {
        mmReq = bn_js_1.default.max(mmReq, MIN_NONZERO_MM_REQ);
    }
    // On-chain: eq_net > mm_req (strictly greater)
    return equity.gt(mmReq);
}
/** Check if position is liquidatable. */
function isLiquidatable(position, market, oraclePrice) {
    const effQ = effectivePositionQ(position, market);
    if (effQ.isZero() && position.baseSize.isZero())
        return false;
    return !isAboveMaintenanceMargin(position, market, oraclePrice);
}
/** Calculate margin ratio for a position (for display). */
function marginRatio(position, market, oraclePrice) {
    const notional = calculateNotional(position, market, oraclePrice);
    if (notional === 0)
        return Infinity;
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
function estimateLiquidationPrice(position, market, oraclePrice) {
    const effQ = effectivePositionQ(position, market);
    if (effQ.isZero())
        return null;
    const isLong = !effQ.isNeg();
    const currentPriceHuman = oraclePrice.toNumber() / constants_1.PRICE_SCALE;
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
    const pnlPerUnit = absEffQ * constants_1.PRICE_SCALE / constants_1.POS_SCALE;
    // MM requirement per unit price:
    //   mm_per_unit = |effQ| * mmBps / (POS_SCALE * 10000)
    //   In human price units: mm_per_unit_human = |effQ| * PRICE_SCALE * mmBps / (POS_SCALE * 10000)
    const mmBps = market.maintenanceMarginBps;
    const mmPerUnit = absEffQ * constants_1.PRICE_SCALE * mmBps / (constants_1.POS_SCALE * constants_1.BPS_DENOMINATOR);
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
    let liqPrice;
    if (isLong) {
        const denominator = mmPerUnit - pnlPerUnit;
        // If denominator >= 0, longs can't be liquidated (MM requirement grows
        // slower than equity — position is always solvent as price rises)
        if (denominator >= 0)
            return null;
        liqPrice = (equityNum - pnlPerUnit * currentPriceHuman) / denominator;
    }
    else {
        const denominator = mmPerUnit + pnlPerUnit;
        if (denominator <= 0)
            return null; // Can't happen for valid positions
        liqPrice = (equityNum + pnlPerUnit * currentPriceHuman) / denominator;
    }
    // Sanity: price must be positive
    if (liqPrice <= 0)
        return null;
    // Sanity: longs liquidate below current price, shorts above
    if (isLong && liqPrice >= currentPriceHuman)
        return currentPriceHuman;
    if (!isLong && liqPrice <= currentPriceHuman)
        return currentPriceHuman;
    return liqPrice;
}
/** Calculate trading fee for a given notional. */
function calculateFee(notional, feeBps) {
    return Math.ceil((notional * feeBps) / constants_1.BPS_DENOMINATOR);
}
/** Calculate funding rate (annualized %). */
function fundingRateAnnualized(market) {
    const ratePerSlot = market.fundingRateBpsPerSlotLast.toNumber();
    // ~2.5 slots per second on Solana
    const slotsPerYear = 2.5 * 86400 * 365;
    return (ratePerSlot * slotsPerYear) / (constants_1.FUNDING_RATE_PRECISION * 100);
}
/** Calculate warmup progress (0 to 1).
 *  Matches on-chain slope-based model: slope = max(1, R / period).
 *  Release cap = slope * elapsed; progress = min(cap, R) / R. */
function warmupProgress(position, market, currentSlot) {
    if (position.reservedPnl.isZero())
        return 1;
    const period = market.warmupPeriodSlots;
    if (period.isZero())
        return 1;
    // On-chain: slope = max(1, reserved_pnl / warmup_period_slots)
    // The position stores warmupSlope set at warmup start.
    const slope = position.warmupSlope.isZero()
        ? bn_js_1.default.max(new bn_js_1.default(1), position.reservedPnl.div(period))
        : position.warmupSlope;
    const elapsed = currentSlot.sub(position.warmupStartedAtSlot);
    if (elapsed.isNeg())
        return 0;
    // cap = slope * elapsed (saturating)
    const cap = slope.mul(elapsed);
    // released = min(reserved_pnl, cap)
    const released = bn_js_1.default.min(position.reservedPnl, cap);
    // Progress = released / reserved_pnl
    if (position.reservedPnl.isZero())
        return 1;
    return released.toNumber() / position.reservedPnl.toNumber();
}
/** Calculate haircut ratio (what fraction of matured PnL is withdrawable).
 *  Matches on-chain risk::haircut_ratio() — computed dynamically from market state. */
function haircutRatio(market) {
    // If no matured positive PnL, ratio is 1 (no haircut needed)
    if (market.pnlMaturedPosTot.isZero())
        return 1;
    // Senior claims: c_tot + insurance + claimable fees
    const claimable = market.creatorClaimableFees.add(market.protocolClaimableFees);
    const seniorSum = market.cTot
        .add(new bn_js_1.default(market.insuranceFundBalance.toString()))
        .add(claimable);
    // Residual = vault_balance - senior_claims (clamped to 0)
    const vaultBal = new bn_js_1.default(market.vaultBalance.toString());
    const residual = vaultBal.gt(seniorSum) ? vaultBal.sub(seniorSum) : ZERO;
    // h = min(residual, pnl_matured_pos_tot) / pnl_matured_pos_tot
    const hNum = bn_js_1.default.min(residual, market.pnlMaturedPosTot);
    const hDen = market.pnlMaturedPosTot;
    if (hDen.isZero())
        return 1;
    // Use BN precision to avoid .toNumber() overflow on large pnl_matured_pos_tot
    const RATIO_PRECISION = new bn_js_1.default("1000000000000"); // 1e12
    const scaled = hNum.mul(RATIO_PRECISION).div(hDen);
    return scaled.toNumber() / 1e12;
}
//# sourceMappingURL=math.js.map