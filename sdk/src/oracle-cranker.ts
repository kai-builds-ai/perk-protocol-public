import {
  Connection,
  PublicKey,
  TransactionInstruction,
  ComputeBudgetProgram,
  VersionedTransaction,
  TransactionMessage,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";
import { PerkClient } from "./client";
import { PRICE_SCALE } from "./constants";

// ── Types ──

export interface OracleCrankerConfig {
  connection: Connection;
  wallet: Wallet; // Must be the oracle authority
  /** Token mints to post prices for. */
  tokenMints: PublicKey[];
  /** Update interval in ms (default: 3000 — ~every 7-8 slots). */
  updateIntervalMs?: number;
  /** Birdeye API key (optional — if not provided, skip Birdeye source). */
  birdeyeApiKey?: string;
  /** Priority fee in microlamports per CU (default: 50000). */
  priorityFeeMicroLamports?: number;
  /** Max deviation between sources before rejecting an outlier (default: 0.01 = 1%).
   *  Must be ≤ half of on-chain ORACLE_CONFIDENCE_BPS (2%) because confidence = max-min,
   *  so two sources at ±X% produce 2X% confidence. 1% deviation → max 2% confidence → passes. */
  maxSourceDeviationPct?: number;
  /** Minimum number of valid sources required (should match on-chain min_sources).
   *  Default: 1 (since Raydium is stubbed, requiring 2 would deadlock when one API is down). */
  minSources?: number;
  /** HTTP fetch timeout in ms (default: 5000). Prevents hung connections from freezing the cranker. */
  fetchTimeoutMs?: number;
  /** Jito bundle configuration. If provided, oracle updates are submitted as private Jito bundles
   *  to prevent front-running / MEV extraction on oracle price updates. */
  jito?: {
    /** Jito Block Engine URL (default: mainnet). */
    blockEngineUrl?: string;
    /** Tip in lamports to include in the bundle (default: 10000 = 0.00001 SOL). */
    tipLamports?: number;
    /** If true, do NOT fall back to normal RPC when Jito fails. Prevents mempool leakage
     *  at the cost of missed updates when Jito is down. Default: false. */
    jitoOnly?: boolean;
  };
  /** Auto-discover new token mints from active markets on-chain.
   *  When enabled, the cranker periodically fetches all active markets and
   *  adds any new token mints to its list automatically. Default: false. */
  autoDiscover?: boolean;
  /** How often to check for new markets in ms (default: 30000 = 30s).
   *  Only used when autoDiscover is true. */
  discoveryIntervalMs?: number;
  /** Callback for logging. */
  onLog?: (msg: string) => void;
  /** Callback for errors. */
  onError?: (err: Error, context: string) => void;
  /** Callback for metrics. */
  onMetrics?: (metrics: OracleCrankerMetrics) => void;
}

export interface OracleCrankerMetrics {
  tickDurationMs: number;
  mintsProcessed: number;
  updatesPosted: number;
  sourcesFetched: number;
  outlierRejections: number;
  errors: number;
}

interface PriceSource {
  name: string;
  price: number; // In USD (raw, not scaled)
  confidence: number; // Spread/uncertainty
  timestamp: number;
}

interface AggregatedPrice {
  price: number;
  confidence: number;
  numSources: number;
}

// ── Helpers ──

/** Fetch with timeout using AbortController. Prevents hung connections from freezing the cranker. */
async function fetchWithTimeout(
  url: string,
  opts: RequestInit & { timeoutMs: number }
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Price Source Fetchers ──

/**
 * Fetch prices from Jupiter Price API v2.
 * Batches all mints in a single request.
 */
async function fetchJupiterPrices(
  mints: PublicKey[],
  timeoutMs: number
): Promise<Map<string, PriceSource>> {
  const results = new Map<string, PriceSource>();
  if (mints.length === 0) return results;

  const ids = mints.map((m) => m.toBase58()).join(",");
  const url = `https://api.jup.ag/price/v2?ids=${ids}`;

  const res = await fetchWithTimeout(url, { timeoutMs });
  if (!res.ok) {
    throw new Error(`Jupiter API returned ${res.status}: ${res.statusText}`);
  }

  const json = (await res.json()) as {
    data?: Record<string, { id?: string; price?: string; type?: string } | null>;
  };
  // Schema validation: ensure data is an object
  if (!json.data || typeof json.data !== "object") {
    throw new Error("Jupiter API returned unexpected schema (missing data)");
  }

  const now = Math.floor(Date.now() / 1000);
  for (const mint of mints) {
    const key = mint.toBase58();
    const entry = json.data[key];
    if (!entry?.price || typeof entry.price !== "string") continue;

    const price = parseFloat(entry.price);
    if (!isFinite(price) || price <= 0) continue;

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
async function fetchBirdeyePrices(
  mints: PublicKey[],
  apiKey: string,
  timeoutMs: number
): Promise<Map<string, PriceSource>> {
  const results = new Map<string, PriceSource>();
  if (mints.length === 0) return results;

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

  const json = (await res.json()) as {
    data?: Record<
      string,
      { value?: number; updateUnixTime?: number } | null
    >;
  };
  // Schema validation
  if (!json.data || typeof json.data !== "object") {
    throw new Error("Birdeye API returned unexpected schema (missing data)");
  }

  const now = Math.floor(Date.now() / 1000);
  for (const mint of mints) {
    const key = mint.toBase58();
    const entry = json.data[key];
    if (!entry?.value || typeof entry.value !== "number") continue;

    const price = entry.value;
    if (!isFinite(price) || price <= 0) continue;

    // M-03 mitigation: reject prices with timestamps older than 60s
    const ts = entry.updateUnixTime ?? now;
    if (now - ts > 60) continue;

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
async function fetchRaydiumPrices(
  _mints: PublicKey[],
  _connection: Connection
): Promise<Map<string, PriceSource>> {
  // TODO: Implement on-chain Raydium pool reads.
  // Will deserialize Raydium AMM accounts, compute price from reserves,
  // and use TWAP observations for manipulation resistance.
  return new Map();
}

// ── Aggregation ──

function computeMedian(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function aggregatePrice(
  sources: PriceSource[],
  minSources: number,
  maxDeviationPct: number
): { result: AggregatedPrice | null; outlierRejections: number } {
  // 1. Filter out null/zero/negative prices
  const valid = sources.filter(
    (s) => isFinite(s.price) && s.price > 0
  );

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

export class PerkOracleCranker {
  private client: PerkClient;
  private config: OracleCrankerConfig;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private discoveryIntervalId: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;


  constructor(config: OracleCrankerConfig) {
    this.config = config;

    // Build preInstructions for priority fees
    const preInstructions: TransactionInstruction[] = [];
    const priorityFee =
      config.priorityFeeMicroLamports ?? 50_000;
    if (priorityFee > 0) {
      preInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        })
      );
    }

    this.client = new PerkClient({
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
  private async sendViaJito(
    instructions: TransactionInstruction[]
  ): Promise<string> {
    const jitoCfg = this.config.jito!;
    const blockEngineUrl =
      jitoCfg.blockEngineUrl ?? "https://mainnet.block-engine.jito.wtf";
    const tipLamports = jitoCfg.tipLamports ?? 10_000;

    const connection = this.config.connection;
    const payer = this.config.wallet.payer as Keypair;

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
    const tipAccount = new PublicKey(
      JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]
    );

    const tipIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });

    const allIx = [...instructions, tipIx];

    // Build versioned transaction
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: allIx,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([payer]);

    // Submit bundle to Jito
    const serialized = Buffer.from(tx.serialize()).toString("base64");
    const bundleRes = await fetchWithTimeout(
      `${blockEngineUrl}/api/v1/bundles`,
      {
        timeoutMs: 5000,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "sendBundle",
          params: [[serialized]],
        }),
      }
    );

    if (!bundleRes.ok) {
      throw new Error(`Jito bundle submission failed: ${bundleRes.status}`);
    }

    const bundleJson = (await bundleRes.json()) as {
      result?: string;
      error?: { message: string };
    };
    if (bundleJson.error) {
      throw new Error(`Jito bundle error: ${bundleJson.error.message}`);
    }

    return bundleJson.result ?? "jito-bundle-submitted";
  }

  // ── Logging ──

  private log(msg: string) {
    if (this.config.onLog) this.config.onLog(msg);
    else console.log(`[OracleCranker] ${msg}`);
  }

  private handleError(err: Error, context: string) {
    if (this.config.onError) this.config.onError(err, context);
    else console.error(`[OracleCranker] ${context}: ${err.message}`);
  }

  // ── Lifecycle ──

  /** Discover new token mints from active on-chain markets and add them to the cranker. */
  private async discoverMints() {
    try {
      const markets = await this.client.fetchAllMarkets();
      const existingSet = new Set(this.config.tokenMints.map((m) => m.toBase58()));
      let added = 0;

      for (const m of markets) {
        if (!m.account.active) continue;
        const mintStr = m.account.tokenMint.toBase58();
        if (!existingSet.has(mintStr)) {
          this.config.tokenMints.push(new PublicKey(mintStr));
          existingSet.add(mintStr);
          added++;
          this.log(`Discovered new mint: ${mintStr.slice(0, 8)}...`);
        }
      }

      if (added > 0) {
        this.log(`Auto-discovery: added ${added} new mint(s). Total: ${this.config.tokenMints.length}`);
      }
    } catch (err) {
      this.handleError(err as Error, "discoverMints");
    }
  }

  /** Start the oracle cranker loop. */
  start() {
    if (this.running) return;
    this.running = true;
    this.log("Starting oracle cranker...");

    // Auto-discover new mints from on-chain markets
    if (this.config.autoDiscover) {
      const discoveryInterval = this.config.discoveryIntervalMs ?? 30_000;
      this.discoverMints(); // run immediately (async, non-blocking)
      this.discoveryIntervalId = setInterval(
        () => this.discoverMints(),
        discoveryInterval
      );
    }

    const interval = this.config.updateIntervalMs ?? 3000;
    this.tick();
    this.intervalId = setInterval(() => this.tick(), interval);
  }

  /** Stop the oracle cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
  stop(timeoutMs: number = 30_000): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.discoveryIntervalId) {
      clearInterval(this.discoveryIntervalId);
      this.discoveryIntervalId = null;
    }
    this.log("Oracle cranker stopping...");

    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (!this.tickInProgress) {
          this.log("Oracle cranker stopped.");
          resolve();
        } else if (Date.now() >= deadline) {
          this.log(
            "Oracle cranker stop timed out — tick still in progress."
          );
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /** Returns true if the oracle cranker is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Tick ──

  private async tick() {
    if (!this.running || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      return await this._tickInner();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async _tickInner() {
    const tickStart = Date.now();
    const metrics: OracleCrankerMetrics = {
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
      const [jupiterPrices, birdeyePrices, raydiumPrices] =
        await Promise.all([
          fetchJupiterPrices(mints, fetchTimeout).catch((err) => {
            this.handleError(err as Error, "fetchJupiterPrices");
            metrics.errors++;
            return new Map<string, PriceSource>();
          }),
          this.config.birdeyeApiKey
            ? fetchBirdeyePrices(mints, this.config.birdeyeApiKey, fetchTimeout).catch(
                (err) => {
                  this.handleError(err as Error, "fetchBirdeyePrices");
                  metrics.errors++;
                  return new Map<string, PriceSource>();
                }
              )
            : Promise.resolve(new Map<string, PriceSource>()),
          fetchRaydiumPrices(mints, this.config.connection).catch(
            (err) => {
              this.handleError(err as Error, "fetchRaydiumPrices");
              metrics.errors++;
              return new Map<string, PriceSource>();
            }
          ),
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
          const sources: PriceSource[] = [];
          const jupPrice = jupiterPrices.get(mintKey);
          if (jupPrice) sources.push(jupPrice);
          const birdPrice = birdeyePrices.get(mintKey);
          if (birdPrice) sources.push(birdPrice);
          const rayPrice = raydiumPrices.get(mintKey);
          if (rayPrice) sources.push(rayPrice);

          // Aggregate
          const { result, outlierRejections } = aggregatePrice(
            sources,
            minSources,
            maxDeviationPct
          );
          metrics.outlierRejections += outlierRejections;

          if (!result) {
            this.log(
              `Skipping ${mintKey.slice(0, 8)} — insufficient sources (${sources.length} fetched, ${minSources} required)`
            );
            continue;
          }

          // Scale to on-chain representation
          const scaledPrice = Math.round(result.price * PRICE_SCALE);
          const scaledConfidence = Math.round(
            result.confidence * PRICE_SCALE
          );

          // Post on-chain — via Jito bundle (private) or normal RPC
          let sig: string;
          if (this.config.jito) {
            try {
              const ix = await this.client.buildUpdatePerkOracleIx(mint, {
                price: new BN(scaledPrice),
                confidence: new BN(scaledConfidence),
                numSources: result.numSources,
              });
              sig = await this.sendViaJito(ix);
              this.log(
                `Posted price for ${mintKey.slice(0, 8)} via Jito: $${result.price.toFixed(6)} (${result.numSources} sources, conf=${result.confidence.toFixed(6)}): ${sig}`
              );
            } catch (jitoErr) {
              if (this.config.jito!.jitoOnly) {
                // jitoOnly mode: do NOT leak to public mempool — skip this update
                this.handleError(jitoErr as Error, "jito-only-failed");
                this.log(
                  `⚠️ Jito failed for ${mintKey.slice(0, 8)}, jitoOnly=true — skipping to prevent mempool leak`
                );
                continue;
              }
              // Fallback to normal RPC if Jito fails
              this.handleError(jitoErr as Error, "jito-fallback");
              sig = await this.client.updatePerkOracle(mint, {
                price: new BN(scaledPrice),
                confidence: new BN(scaledConfidence),
                numSources: result.numSources,
              });
              this.log(
                `Posted price for ${mintKey.slice(0, 8)} via RPC (Jito fallback): $${result.price.toFixed(6)} (${result.numSources} sources): ${sig}`
              );
            }
          } else {
            sig = await this.client.updatePerkOracle(mint, {
              price: new BN(scaledPrice),
              confidence: new BN(scaledConfidence),
              numSources: result.numSources,
            });
            this.log(
              `Posted price for ${mintKey.slice(0, 8)}: $${result.price.toFixed(6)} (${result.numSources} sources, conf=${result.confidence.toFixed(6)}): ${sig}`
            );
          }

          metrics.updatesPosted++;
        } catch (err) {
          metrics.errors++;
          this.handleError(
            err as Error,
            `mint ${mintKey.slice(0, 8)}`
          );
        }
      }
    } catch (err) {
      metrics.errors++;
      this.handleError(err as Error, "tick");
    }

    metrics.tickDurationMs = Date.now() - tickStart;
    if (this.config.onMetrics) {
      this.config.onMetrics(metrics);
    }
  }
}
