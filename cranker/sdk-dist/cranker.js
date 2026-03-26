"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerkCranker = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const client_1 = require("./client");
const math_1 = require("./math");
const constants_1 = require("./constants");
// ── Helpers ──
/** Check if an Anchor-deserialized enum matches a variant name. */
function isEnumVariant(anchorEnum, variant) {
    if (typeof anchorEnum === "object" && anchorEnum !== null) {
        return variant in anchorEnum;
    }
    return false;
}
/** Get the trigger order type as a string from Anchor-deserialized enum. */
function getOrderType(anchorEnum) {
    if (typeof anchorEnum === "object" && anchorEnum !== null) {
        if ("limit" in anchorEnum)
            return "limit";
        if ("stopLoss" in anchorEnum)
            return "stopLoss";
        if ("takeProfit" in anchorEnum)
            return "takeProfit";
    }
    return null;
}
/** Check if order is on the long side (Anchor-deserialized). */
function isLongSide(anchorSide) {
    if (typeof anchorSide === "object" && anchorSide !== null) {
        return "long" in anchorSide;
    }
    return false;
}
/** Check if a trigger order should execute given oracle price. */
function shouldTriggerExecute(order, oraclePrice) {
    const triggerPrice = order.triggerPrice.toNumber();
    const orderType = getOrderType(order.orderType);
    const isLong = isLongSide(order.side);
    switch (orderType) {
        case "limit":
            return isLong ? oraclePrice <= triggerPrice : oraclePrice >= triggerPrice;
        case "stopLoss":
            return isLong ? oraclePrice <= triggerPrice : oraclePrice >= triggerPrice;
        case "takeProfit":
            return isLong ? oraclePrice >= triggerPrice : oraclePrice <= triggerPrice;
        default:
            return false;
    }
}
/** Check if a trigger order would increase OI on a drain-only side. */
function wouldIncreaseOI(order, market) {
    if (order.reduceOnly)
        return false;
    const isLong = isLongSide(order.side);
    if (isLong && isEnumVariant(market.longState, "drainOnly"))
        return true;
    if (!isLong && isEnumVariant(market.shortState, "drainOnly"))
        return true;
    return false;
}
/** Resolve fallback oracle account: use the market's configured address, or SystemProgram as sentinel. */
function resolveFallbackOracle(market) {
    const addr = market.fallbackOracleAddress;
    if (addr.equals(web3_js_1.PublicKey.default))
        return web3_js_1.SystemProgram.programId;
    return addr;
}
class PerkCranker {
    constructor(config) {
        this.running = false;
        this.intervalId = null;
        this.tickInProgress = false;
        /** Cache: collateral mint → ATA address for this wallet. */
        this.ataCache = new Map();
        this.config = config;
        // Build preInstructions for priority fees
        const preInstructions = [];
        if (config.priorityFeeMicroLamports && config.priorityFeeMicroLamports > 0) {
            preInstructions.push(web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: config.priorityFeeMicroLamports,
            }));
        }
        this.client = new client_1.PerkClient({
            connection: config.connection,
            wallet: config.wallet,
            preInstructions,
        });
    }
    // ── Logging ──
    log(msg) {
        if (this.config.onLog)
            this.config.onLog(msg);
        else
            console.log(`[Cranker] ${msg}`);
    }
    handleError(err, context) {
        if (this.config.onError)
            this.config.onError(err, context);
        else
            console.error(`[Cranker] ${context}: ${err.message}`);
    }
    // ── Lifecycle ──
    /** Start the cranker loop. */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.log("Starting cranker...");
        const interval = this.config.pollIntervalMs ?? 5000;
        this.tick();
        this.intervalId = setInterval(() => this.tick(), interval);
    }
    /** Stop the cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
    stop(timeoutMs = 30000) {
        this.running = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.log("Cranker stopping...");
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                if (!this.tickInProgress) {
                    this.log("Cranker stopped.");
                    resolve();
                }
                else if (Date.now() >= deadline) {
                    this.log("Cranker stop timed out — tick still in progress.");
                    resolve();
                }
                else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
    /** Returns true if the cranker is currently running. */
    isRunning() {
        return this.running;
    }
    // ── Tick ──
    async tick() {
        if (!this.running || this.tickInProgress)
            return;
        this.tickInProgress = true;
        try {
            return await this._tickInner();
        }
        finally {
            this.tickInProgress = false;
        }
    }
    async _tickInner() {
        const tickStart = Date.now();
        const metrics = {
            tickDurationMs: 0,
            marketsProcessed: 0,
            liquidationsAttempted: 0,
            liquidationsSucceeded: 0,
            triggerOrdersExecuted: 0,
            fundingCranked: 0,
            pegUpdates: 0,
            reclaimsAttempted: 0,
            errors: 0,
        };
        try {
            // Fetch markets — use allSettled so one bad market doesn't kill everything
            const markets = await this.fetchMarkets();
            for (const { address, account: marketInit } of markets) {
                let market = marketInit;
                if (!market.active)
                    continue;
                metrics.marketsProcessed++;
                try {
                    // 1. Crank funding
                    if (this.config.enableFunding !== false) {
                        const cranked = await this.crankFunding(address, market);
                        if (cranked)
                            metrics.fundingCranked++;
                    }
                    // 2. Update AMM peg (refreshes oracle price on-chain)
                    if (this.config.enablePegUpdate !== false) {
                        const updated = await this.updatePeg(address, market);
                        if (updated) {
                            metrics.pegUpdates++;
                            // Re-fetch market after peg update so scans use fresh oracle price
                            try {
                                const freshMarket = await this.client.fetchMarketByAddress(address);
                                market = freshMarket;
                            }
                            catch (err) {
                                this.handleError(err, `re-fetch after peg ${address.toBase58().slice(0, 8)}`);
                                metrics.errors++;
                            }
                        }
                    }
                    // Check oracle staleness — skip scans if price is too stale
                    // (on-chain will use fresh oracle, so our client-side decisions
                    // based on stale lastOraclePrice would be unreliable)
                    const lastPegSlot = market.lastPegUpdateSlot?.toNumber?.() ?? 0;
                    let currentSlot;
                    try {
                        currentSlot = await this.config.connection.getSlot();
                    }
                    catch {
                        currentSlot = 0; // If we can't get slot, skip staleness check
                    }
                    // ~400ms per slot on Solana → convert staleness seconds to slots
                    const maxStaleSlots = Math.ceil(constants_1.ORACLE_STALENESS_SECONDS * 1000 / 400);
                    const oracleIsStale = currentSlot > 0 &&
                        lastPegSlot > 0 &&
                        currentSlot - lastPegSlot > maxStaleSlots;
                    if (oracleIsStale) {
                        this.log(`Skipping scans for ${address.toBase58().slice(0, 8)} — oracle stale by ${currentSlot - lastPegSlot} slots`);
                    }
                    // Fetch positions and trigger orders in parallel for this market
                    const [positions, orders] = await Promise.all([
                        this.config.enableLiquidations !== false ||
                            this.config.enableReclaim
                            ? this.fetchPositions(address)
                            : Promise.resolve([]),
                        this.config.enableTriggerOrders !== false
                            ? this.fetchTriggerOrders(address)
                            : Promise.resolve([]),
                    ]);
                    // 3. Trigger orders FIRST (stop-losses can save positions from liquidation)
                    // Skip if oracle is stale — our price-based decisions would be unreliable
                    if (this.config.enableTriggerOrders !== false && !oracleIsStale) {
                        const executed = await this.scanTriggerOrders(address, market, orders);
                        metrics.triggerOrdersExecuted += executed;
                    }
                    // 4. Liquidations
                    if (this.config.enableLiquidations !== false && !oracleIsStale) {
                        const { attempted, succeeded } = await this.scanLiquidations(address, market, positions);
                        metrics.liquidationsAttempted += attempted;
                        metrics.liquidationsSucceeded += succeeded;
                    }
                    // 5. Reclaim empty accounts (any time, not just ResetPending)
                    if (this.config.enableReclaim) {
                        const reclaimed = await this.scanReclaims(address, market, positions);
                        metrics.reclaimsAttempted += reclaimed;
                    }
                }
                catch (err) {
                    metrics.errors++;
                    this.handleError(err, `market ${address.toBase58().slice(0, 8)}`);
                }
            }
        }
        catch (err) {
            metrics.errors++;
            this.handleError(err, "tick");
        }
        metrics.tickDurationMs = Date.now() - tickStart;
        if (this.config.onMetrics) {
            this.config.onMetrics(metrics);
        }
    }
    // ── Market fetching with allSettled ──
    async fetchMarkets() {
        if (this.config.markets?.length) {
            const results = await Promise.allSettled(this.config.markets.map(async (addr) => ({
                address: addr,
                account: await this.client.fetchMarketByAddress(addr),
            })));
            const markets = [];
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                if (r.status === "fulfilled") {
                    markets.push(r.value);
                }
                else {
                    this.handleError(r.reason, `fetch market ${this.config.markets[i].toBase58().slice(0, 8)}`);
                }
            }
            return markets;
        }
        return this.client.fetchAllMarkets();
    }
    // ── Position / order fetching ──
    async fetchPositions(marketAddress) {
        const raw = await this.client.accounts.userPosition.all([
            { memcmp: { offset: 8 + 32, bytes: marketAddress.toBase58() } },
        ]);
        return raw.map((r) => ({
            publicKey: r.publicKey,
            account: r.account,
        }));
    }
    async fetchTriggerOrders(marketAddress) {
        const raw = await this.client.accounts.triggerOrder.all([
            { memcmp: { offset: 8 + 32, bytes: marketAddress.toBase58() } },
        ]);
        return raw.map((r) => ({
            publicKey: r.publicKey,
            account: r.account,
        }));
    }
    // ── ATA cache ──
    async getRewardAccount(collateralMint) {
        if (this.config.rewardTokenAccount)
            return this.config.rewardTokenAccount;
        const key = collateralMint.toBase58();
        let cached = this.ataCache.get(key);
        if (!cached) {
            cached = await (0, spl_token_1.getAssociatedTokenAddress)(collateralMint, this.config.wallet.publicKey);
            this.ataCache.set(key, cached);
        }
        return cached;
    }
    // ── Funding ──
    async crankFunding(marketAddress, market) {
        const now = Math.floor(Date.now() / 1000);
        const elapsed = now - market.lastFundingTime.toNumber();
        if (elapsed < market.fundingPeriodSeconds)
            return false;
        try {
            const sig = await this.client.crankFunding(marketAddress, market.oracleAddress, resolveFallbackOracle(market));
            this.log(`Cranked funding for ${marketAddress.toBase58().slice(0, 8)}: ${sig}`);
            return true;
        }
        catch (err) {
            this.handleError(err, "crankFunding");
            return false;
        }
    }
    // ── Peg update ──
    async updatePeg(marketAddress, market) {
        try {
            const sig = await this.client.updateAmm(marketAddress, market.oracleAddress, resolveFallbackOracle(market));
            this.log(`Updated AMM peg for ${marketAddress.toBase58().slice(0, 8)}: ${sig}`);
            return true;
        }
        catch (err) {
            const msg = err?.message ?? "";
            // Expected: cooldown not elapsed, drift within threshold
            if (msg.includes("cooldown") || msg.includes("threshold")) {
                return false;
            }
            // Log all other errors (including Anchor error codes)
            this.handleError(err, "updatePeg");
            return false;
        }
    }
    // ── Liquidations ──
    async scanLiquidations(marketAddress, market, positions) {
        const oraclePrice = market.lastOraclePrice;
        let attempted = 0;
        let succeeded = 0;
        // Collect liquidatable positions
        const liquidatable = [];
        for (const { account: pos } of positions) {
            if (pos.baseSize.isZero() && pos.basis.isZero())
                continue;
            if ((0, math_1.isLiquidatable)(pos, market, oraclePrice)) {
                liquidatable.push(pos);
            }
        }
        if (liquidatable.length === 0)
            return { attempted: 0, succeeded: 0 };
        const rewardAccount = await this.getRewardAccount(market.collateralMint);
        // Execute liquidations (one per tx for now — batching requires
        // building raw transactions with the program's instruction builder)
        for (const pos of liquidatable) {
            attempted++;
            try {
                const sig = await this.client.liquidate(marketAddress, market.oracleAddress, pos.authority, rewardAccount, resolveFallbackOracle(market));
                succeeded++;
                this.log(`Liquidated ${pos.authority.toBase58().slice(0, 8)} on ${marketAddress.toBase58().slice(0, 8)}: ${sig}`);
            }
            catch (err) {
                this.handleError(err, `liquidate ${pos.authority.toBase58().slice(0, 8)}`);
            }
        }
        return { attempted, succeeded };
    }
    // ── Trigger orders ──
    async scanTriggerOrders(marketAddress, market, orders) {
        const oraclePrice = market.lastOraclePrice.toNumber();
        let executed = 0;
        const now = Math.floor(Date.now() / 1000);
        for (const { account: order } of orders) {
            // Check expiry
            if (order.expiry.toNumber() > 0 && now > order.expiry.toNumber()) {
                continue;
            }
            // Check max age
            const createdAt = order.createdAt?.toNumber?.() ?? 0;
            if (createdAt > 0 &&
                now - createdAt > constants_1.MAX_TRIGGER_ORDER_AGE_SECONDS) {
                continue;
            }
            // Skip OI-increasing orders on drain-only sides (on-chain rejects them)
            if (wouldIncreaseOI(order, market))
                continue;
            // Check if trigger condition is met
            if (shouldTriggerExecute(order, oraclePrice)) {
                try {
                    const rewardAccount = await this.getRewardAccount(market.collateralMint);
                    const sig = await this.client.executeTriggerOrder(marketAddress, market.oracleAddress, order.authority, order.orderId, rewardAccount, resolveFallbackOracle(market));
                    executed++;
                    this.log(`Executed trigger order ${order.orderId.toString()} for ${order.authority.toBase58().slice(0, 8)}: ${sig}`);
                }
                catch (err) {
                    this.handleError(err, `executeTrigger ${order.orderId.toString()}`);
                }
            }
        }
        return executed;
    }
    // ── Reclaims ──
    async scanReclaims(marketAddress, market, positions) {
        let reclaimed = 0;
        for (const { account: pos } of positions) {
            // Match on-chain reclaim_empty_account requirements
            if (!pos.baseSize.isZero() || !pos.basis.isZero())
                continue;
            if (pos.depositedCollateral.toNumber() > constants_1.DUST_THRESHOLD)
                continue;
            if (pos.openTriggerOrders > 0)
                continue;
            if (pos.feeCredits.isNeg())
                continue; // Has fee debt — on-chain rejects
            try {
                const sig = await this.client.reclaimEmptyAccount(marketAddress, market.oracleAddress, pos.authority, resolveFallbackOracle(market));
                reclaimed++;
                this.log(`Reclaimed empty account for ${pos.authority.toBase58().slice(0, 8)}: ${sig}`);
            }
            catch (err) {
                this.handleError(err, `reclaim ${pos.authority.toBase58().slice(0, 8)}`);
            }
        }
        return reclaimed;
    }
}
exports.PerkCranker = PerkCranker;
//# sourceMappingURL=cranker.js.map