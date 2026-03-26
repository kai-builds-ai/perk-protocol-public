"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerkOracleCranker = void 0;
const web3_js_1 = require("@solana/web3.js");
const anchor_1 = require("@coral-xyz/anchor");
const client_1 = require("./client");
const constants_1 = require("./constants");
// ── Helpers ──
/** Fetch with timeout using AbortController. Prevents hung connections from freezing the cranker. */
async function fetchWithTimeout(url, opts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
        return await fetch(url, { ...opts, signal: controller.signal });
    }
    finally {
        clearTimeout(timer);
    }
}
// ── Price Source Fetchers ──
/**
 * Fetch prices from Jupiter Price API v2.
 * Batches all mints in a single request.
 */
async function fetchJupiterPrices(mints, timeoutMs) {
    const results = new Map();
    if (mints.length === 0)
        return results;
    const ids = mints.map((m) => m.toBase58()).join(",");
    const url = `https://api.jup.ag/price/v2?ids=${ids}`;
    const res = await fetchWithTimeout(url, { timeoutMs });
    if (!res.ok) {
        throw new Error(`Jupiter API returned ${res.status}: ${res.statusText}`);
    }
    const json = (await res.json());
    // Schema validation: ensure data is an object
    if (!json.data || typeof json.data !== "object") {
        throw new Error("Jupiter API returned unexpected schema (missing data)");
    }
    const now = Math.floor(Date.now() / 1000);
    for (const mint of mints) {
        const key = mint.toBase58();
        const entry = json.data[key];
        if (!entry?.price || typeof entry.price !== "string")
            continue;
        const price = parseFloat(entry.price);
        if (!isFinite(price) || price <= 0)
            continue;
        results.set(key, {
            name: "jupiter",
            price,
            confidence: 0,
            timestamp: now, // Jupiter doesn't provide timestamps — known limitation (M-03)
        });
    }
    return results;
}
/**
 * Fetch prices from Birdeye Token Price API.
 * Batches all mints in a single request.
 */
async function fetchBirdeyePrices(mints, apiKey, timeoutMs) {
    const results = new Map();
    if (mints.length === 0)
        return results;
    const addresses = mints.map((m) => m.toBase58()).join(",");
    const url = `https://public-api.birdeye.so/defi/multi_price?list_address=${addresses}`;
    const res = await fetchWithTimeout(url, {
        timeoutMs,
        headers: {
            "X-API-KEY": apiKey,
            "x-chain": "solana",
        },
    });
    if (!res.ok) {
        throw new Error(`Birdeye API returned ${res.status}: ${res.statusText}`);
    }
    const json = (await res.json());
    // Schema validation
    if (!json.data || typeof json.data !== "object") {
        throw new Error("Birdeye API returned unexpected schema (missing data)");
    }
    const now = Math.floor(Date.now() / 1000);
    for (const mint of mints) {
        const key = mint.toBase58();
        const entry = json.data[key];
        if (!entry?.value || typeof entry.value !== "number")
            continue;
        const price = entry.value;
        if (!isFinite(price) || price <= 0)
            continue;
        // M-03 mitigation: reject prices with timestamps older than 60s
        const ts = entry.updateUnixTime ?? now;
        if (now - ts > 60)
            continue;
        results.set(key, {
            name: "birdeye",
            price,
            confidence: 0,
            timestamp: ts,
        });
    }
    return results;
}
/**
 * Fetch prices from on-chain Raydium AMM pools.
 * STUB — returns empty map. Will read from Raydium AMM accounts directly
 * using on-chain reserves and TWAP (not spot) to resist flash-loan manipulation.
 */
async function fetchRaydiumPrices(_mints, _connection) {
    // TODO: Implement on-chain Raydium pool reads.
    // Will deserialize Raydium AMM accounts, compute price from reserves,
    // and use TWAP observations for manipulation resistance.
    return new Map();
}
// ── Aggregation ──
function computeMedian(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}
function aggregatePrice(sources, minSources, maxDeviationPct) {
    // 1. Filter out null/zero/negative prices
    const valid = sources.filter((s) => isFinite(s.price) && s.price > 0);
    // 2. If fewer than minSources, return null
    if (valid.length < minSources) {
        return { result: null, outlierRejections: 0 };
    }
    // 3. Compute median
    const prices = valid.map((s) => s.price);
    const median = computeMedian(prices);
    // 4. Outlier rejection: remove any source that deviates > maxDeviationPct from median
    let outlierRejections = 0;
    const accepted = valid.filter((s) => {
        const deviation = Math.abs(s.price - median) / median;
        if (deviation > maxDeviationPct) {
            outlierRejections++;
            return false;
        }
        return true;
    });
    // 5. Re-compute median with remaining sources
    // 6. If fewer than minSources after rejection, return null
    if (accepted.length < minSources) {
        return { result: null, outlierRejections };
    }
    const acceptedPrices = accepted.map((s) => s.price);
    const finalMedian = computeMedian(acceptedPrices);
    // 7. Confidence = max_price - min_price across valid sources
    const minPrice = Math.min(...acceptedPrices);
    const maxPrice = Math.max(...acceptedPrices);
    const confidence = maxPrice - minPrice;
    // 8. Return { price, confidence, numSources }
    return {
        result: {
            price: finalMedian,
            confidence,
            numSources: accepted.length,
        },
        outlierRejections,
    };
}
// ── Oracle Cranker ──
class PerkOracleCranker {
    constructor(config) {
        this.running = false;
        this.intervalId = null;
        this.tickInProgress = false;
        this.config = config;
        // Build preInstructions for priority fees
        const preInstructions = [];
        const priorityFee = config.priorityFeeMicroLamports ?? 50000;
        if (priorityFee > 0) {
            preInstructions.push(web3_js_1.ComputeBudgetProgram.setComputeUnitPrice({
                microLamports: priorityFee,
            }));
        }
        this.client = new client_1.PerkClient({
            connection: config.connection,
            wallet: config.wallet,
            preInstructions,
        });
    }
    // ── Jito Bundle Submission ──
    /**
     * Submit a transaction as a Jito bundle for private, front-run-resistant submission.
     * Falls back to normal RPC submission if Jito fails.
     */
    async sendViaJito(instructions) {
        const jitoCfg = this.config.jito;
        const blockEngineUrl = jitoCfg.blockEngineUrl ?? "https://mainnet.block-engine.jito.wtf";
        const tipLamports = jitoCfg.tipLamports ?? 10000;
        const connection = this.config.connection;
        const payer = this.config.wallet.payer;
        // Add Jito tip transfer to a known tip account
        // Jito tip accounts rotate — use their API to get current one, fallback to known address
        const JITO_TIP_ACCOUNTS = [
            "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
            "HFqU5x63VTqvQss8hp11i4bPqSNjEBkNwR5PLRK73o5h",
            "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
            "ADaUMid9yfUytqMBgopwjb2DTLSLJYfyDiSnwToYUJ1R",
            "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
            "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
            "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
            "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
        ];
        const tipAccount = new web3_js_1.PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
        const tipIx = web3_js_1.SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tipAccount,
            lamports: tipLamports,
        });
        const allIx = [...instructions, tipIx];
        // Build versioned transaction
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        const messageV0 = new web3_js_1.TransactionMessage({
            payerKey: payer.publicKey,
            recentBlockhash: blockhash,
            instructions: allIx,
        }).compileToV0Message();
        const tx = new web3_js_1.VersionedTransaction(messageV0);
        tx.sign([payer]);
        // Submit bundle to Jito
        const serialized = Buffer.from(tx.serialize()).toString("base64");
        const bundleRes = await fetchWithTimeout(`${blockEngineUrl}/api/v1/bundles`, {
            timeoutMs: 5000,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "sendBundle",
                params: [[serialized]],
            }),
        });
        if (!bundleRes.ok) {
            throw new Error(`Jito bundle submission failed: ${bundleRes.status}`);
        }
        const bundleJson = (await bundleRes.json());
        if (bundleJson.error) {
            throw new Error(`Jito bundle error: ${bundleJson.error.message}`);
        }
        return bundleJson.result ?? "jito-bundle-submitted";
    }
    // ── Logging ──
    log(msg) {
        if (this.config.onLog)
            this.config.onLog(msg);
        else
            console.log(`[OracleCranker] ${msg}`);
    }
    handleError(err, context) {
        if (this.config.onError)
            this.config.onError(err, context);
        else
            console.error(`[OracleCranker] ${context}: ${err.message}`);
    }
    // ── Lifecycle ──
    /** Start the oracle cranker loop. */
    start() {
        if (this.running)
            return;
        this.running = true;
        this.log("Starting oracle cranker...");
        const interval = this.config.updateIntervalMs ?? 3000;
        this.tick();
        this.intervalId = setInterval(() => this.tick(), interval);
    }
    /** Stop the oracle cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
    stop(timeoutMs = 30000) {
        this.running = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.log("Oracle cranker stopping...");
        return new Promise((resolve) => {
            const deadline = Date.now() + timeoutMs;
            const check = () => {
                if (!this.tickInProgress) {
                    this.log("Oracle cranker stopped.");
                    resolve();
                }
                else if (Date.now() >= deadline) {
                    this.log("Oracle cranker stop timed out — tick still in progress.");
                    resolve();
                }
                else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    }
    /** Returns true if the oracle cranker is currently running. */
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
            mintsProcessed: 0,
            updatesPosted: 0,
            sourcesFetched: 0,
            outlierRejections: 0,
            errors: 0,
        };
        const mints = this.config.tokenMints;
        const minSources = this.config.minSources ?? 1;
        const maxDeviationPct = this.config.maxSourceDeviationPct ?? 0.01;
        const fetchTimeout = this.config.fetchTimeoutMs ?? 5000;
        try {
            // Batch-fetch prices from all sources in parallel
            const [jupiterPrices, birdeyePrices, raydiumPrices] = await Promise.all([
                fetchJupiterPrices(mints, fetchTimeout).catch((err) => {
                    this.handleError(err, "fetchJupiterPrices");
                    metrics.errors++;
                    return new Map();
                }),
                this.config.birdeyeApiKey
                    ? fetchBirdeyePrices(mints, this.config.birdeyeApiKey, fetchTimeout).catch((err) => {
                        this.handleError(err, "fetchBirdeyePrices");
                        metrics.errors++;
                        return new Map();
                    })
                    : Promise.resolve(new Map()),
                fetchRaydiumPrices(mints, this.config.connection).catch((err) => {
                    this.handleError(err, "fetchRaydiumPrices");
                    metrics.errors++;
                    return new Map();
                }),
            ]);
            // Count total sources fetched
            metrics.sourcesFetched =
                jupiterPrices.size + birdeyePrices.size + raydiumPrices.size;
            // Process each mint individually
            for (const mint of mints) {
                metrics.mintsProcessed++;
                const mintKey = mint.toBase58();
                try {
                    // Collect sources for this mint
                    const sources = [];
                    const jupPrice = jupiterPrices.get(mintKey);
                    if (jupPrice)
                        sources.push(jupPrice);
                    const birdPrice = birdeyePrices.get(mintKey);
                    if (birdPrice)
                        sources.push(birdPrice);
                    const rayPrice = raydiumPrices.get(mintKey);
                    if (rayPrice)
                        sources.push(rayPrice);
                    // Aggregate
                    const { result, outlierRejections } = aggregatePrice(sources, minSources, maxDeviationPct);
                    metrics.outlierRejections += outlierRejections;
                    if (!result) {
                        this.log(`Skipping ${mintKey.slice(0, 8)} — insufficient sources (${sources.length} fetched, ${minSources} required)`);
                        continue;
                    }
                    // Scale to on-chain representation
                    const scaledPrice = Math.round(result.price * constants_1.PRICE_SCALE);
                    const scaledConfidence = Math.round(result.confidence * constants_1.PRICE_SCALE);
                    // Post on-chain — via Jito bundle (private) or normal RPC
                    let sig;
                    if (this.config.jito) {
                        try {
                            const ix = await this.client.buildUpdatePerkOracleIx(mint, {
                                price: new anchor_1.BN(scaledPrice),
                                confidence: new anchor_1.BN(scaledConfidence),
                                numSources: result.numSources,
                            });
                            sig = await this.sendViaJito(ix);
                            this.log(`Posted price for ${mintKey.slice(0, 8)} via Jito: $${result.price.toFixed(6)} (${result.numSources} sources, conf=${result.confidence.toFixed(6)}): ${sig}`);
                        }
                        catch (jitoErr) {
                            if (this.config.jito.jitoOnly) {
                                // jitoOnly mode: do NOT leak to public mempool — skip this update
                                this.handleError(jitoErr, "jito-only-failed");
                                this.log(`⚠️ Jito failed for ${mintKey.slice(0, 8)}, jitoOnly=true — skipping to prevent mempool leak`);
                                continue;
                            }
                            // Fallback to normal RPC if Jito fails
                            this.handleError(jitoErr, "jito-fallback");
                            sig = await this.client.updatePerkOracle(mint, {
                                price: new anchor_1.BN(scaledPrice),
                                confidence: new anchor_1.BN(scaledConfidence),
                                numSources: result.numSources,
                            });
                            this.log(`Posted price for ${mintKey.slice(0, 8)} via RPC (Jito fallback): $${result.price.toFixed(6)} (${result.numSources} sources): ${sig}`);
                        }
                    }
                    else {
                        sig = await this.client.updatePerkOracle(mint, {
                            price: new anchor_1.BN(scaledPrice),
                            confidence: new anchor_1.BN(scaledConfidence),
                            numSources: result.numSources,
                        });
                        this.log(`Posted price for ${mintKey.slice(0, 8)}: $${result.price.toFixed(6)} (${result.numSources} sources, conf=${result.confidence.toFixed(6)}): ${sig}`);
                    }
                    metrics.updatesPosted++;
                }
                catch (err) {
                    metrics.errors++;
                    this.handleError(err, `mint ${mintKey.slice(0, 8)}`);
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
}
exports.PerkOracleCranker = PerkOracleCranker;
//# sourceMappingURL=oracle-cranker.js.map