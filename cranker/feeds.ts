import BN from "bn.js";
import { createLogger } from "./logger";

const log = createLogger("feeds");

const FETCH_TIMEOUT_MS = 5_000;
const BATCH_FETCH_TIMEOUT_MS = 15_000;
const PRICE_SCALE = 1_000_000;

// Fix 10: Frozen API detection — track consecutive identical prices per token
const lastPrices = new Map<string, { price: number; sameCount: number }>();

/**
 * Fix 6: Safe float→BN conversion with bounds checking.
 * Prevents zero/overflow issues when scaling prices to on-chain representation.
 */
export function safeScalePrice(priceUsd: number): BN {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new Error(`Price must be a positive finite number, got: ${priceUsd}`);
  }
  const scaled = Math.round(priceUsd * PRICE_SCALE);
  if (scaled <= 0) {
    throw new Error(`Price too small to represent: $${priceUsd} → ${scaled} after PRICE_SCALE`);
  }
  if (scaled > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Price too large for safe integer: $${priceUsd} → ${scaled}`);
  }
  return new BN(scaled);
}

export interface PriceSource {
  name: string;
  price: number; // USD
  timestamp: number;
}

export interface AggregatedPrice {
  price: BN;        // in PRICE_SCALE (1e6)
  confidence: BN;   // |price1 - price2| in PRICE_SCALE, or 0 for single source
  numSources: number;
  sources: PriceSource[];
}

async function fetchWithTimeout(url: string, options?: RequestInit, timeoutMs: number = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJupiterPrice(tokenMint: string, apiKey?: string): Promise<PriceSource | null> {
  try {
    const url = `https://api.jup.ag/price/v3?ids=${tokenMint}`;
    const headers: Record<string, string> = {};
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await fetchWithTimeout(url, { headers });
    if (!res.ok) {
      log.warn("Jupiter API returned non-OK", { status: res.status }, tokenMint);
      return null;
    }
    const json = (await res.json()) as Record<string, { usdPrice: number } | null | undefined>;
    const entry = json[tokenMint];
    if (!entry || entry.usdPrice == null) {
      log.warn("Jupiter returned no price data", undefined, tokenMint);
      return null;
    }
    const price = entry.usdPrice;
    if (!isFinite(price) || price <= 0) {
      log.warn("Jupiter returned invalid price", { rawPrice: entry.usdPrice }, tokenMint);
      return null;
    }
    return { name: "jupiter", price, timestamp: Date.now() };
  } catch (err) {
    log.warn("Jupiter fetch failed", { error: String(err) }, tokenMint);
    return null;
  }
}

async function fetchBirdeyePrice(tokenMint: string, apiKey: string): Promise<PriceSource | null> {
  try {
    const url = `https://public-api.birdeye.so/defi/price?address=${tokenMint}`;
    const res = await fetchWithTimeout(url, {
      headers: { "X-API-KEY": apiKey, "x-chain": "solana" },
    });
    if (!res.ok) {
      log.warn("Birdeye API returned non-OK", { status: res.status }, tokenMint);
      return null;
    }
    const json = (await res.json()) as {
      data?: { value?: number };
      success?: boolean;
    };
    if (!json.success || !json.data?.value) {
      log.warn("Birdeye returned no price data", undefined, tokenMint);
      return null;
    }
    const price = json.data.value;
    if (!isFinite(price) || price <= 0) {
      log.warn("Birdeye returned invalid price", { rawPrice: price }, tokenMint);
      return null;
    }
    return { name: "birdeye", price, timestamp: Date.now() };
  } catch (err) {
    log.warn("Birdeye fetch failed", { error: String(err) }, tokenMint);
    return null;
  }
}

/**
 * Pure aggregation logic — validates sources, checks divergence, returns averaged price.
 * Extracted for testability.
 */
export function aggregateSources(
  sources: PriceSource[],
  minSources: number,
  maxDivergencePct: number,
  tokenMint: string = "unknown",
): { finalPriceUsd: number; confidenceUsd: number; validSources: PriceSource[] } {
  // Filter invalid sources
  const valid = sources.filter((s) => isFinite(s.price) && s.price > 0);

  if (valid.length === 0) {
    throw new Error(`No price sources returned data for ${tokenMint}`);
  }
  if (valid.length < minSources) {
    throw new Error(`Need at least ${minSources} price sources, only got ${valid.length} for ${tokenMint}`);
  }

  let finalPriceUsd: number;
  let confidenceUsd: number;

  if (valid.length === 2) {
    const divergencePct = Math.abs(valid[0].price - valid[1].price) / Math.min(valid[0].price, valid[1].price);
    if (divergencePct > maxDivergencePct) {
      throw new Error(
        `Price sources diverge by ${(divergencePct * 100).toFixed(1)}%: ` +
        `${valid[0].name}=$${valid[0].price}, ${valid[1].name}=$${valid[1].price}`
      );
    }
    finalPriceUsd = (valid[0].price + valid[1].price) / 2;
    confidenceUsd = Math.abs(valid[0].price - valid[1].price);
  } else {
    finalPriceUsd = valid[0].price;
    confidenceUsd = 0;
  }

  return { finalPriceUsd, confidenceUsd, validSources: valid };
}

// ---------------------------------------------------------------------------
// Batch fetch functions — fetch prices for multiple mints in a single API call
// ---------------------------------------------------------------------------

const BATCH_CHUNK_SIZE = 100;

/** Split an array into chunks of `size`. */
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function fetchJupiterBatch(
  mints: string[],
  apiKey?: string,
): Promise<Map<string, PriceSource>> {
  const result = new Map<string, PriceSource>();
  if (mints.length === 0) return result;

  const chunks = chunk(mints, BATCH_CHUNK_SIZE);
  for (const batch of chunks) {
    try {
      const url = `https://api.jup.ag/price/v3?ids=${batch.join(",")}`;
      const headers: Record<string, string> = {};
      if (apiKey) headers["x-api-key"] = apiKey;
      const res = await fetchWithTimeout(url, { headers }, BATCH_FETCH_TIMEOUT_MS);
      if (!res.ok) {
        log.warn("Jupiter batch API returned non-OK", { status: res.status, batchSize: batch.length });
        continue;
      }
      const json = (await res.json()) as Record<string, { usdPrice: number } | null | undefined>;
      const now = Date.now();
      for (const mint of batch) {
        const entry = json[mint];
        if (!entry || entry.usdPrice == null) continue;
        const price = entry.usdPrice;
        if (!isFinite(price) || price <= 0) {
          log.warn("Jupiter batch returned invalid price", { rawPrice: entry.usdPrice }, mint);
          continue;
        }
        result.set(mint, { name: "jupiter", price, timestamp: now });
      }
    } catch (err) {
      log.warn("Jupiter batch fetch failed", { error: String(err), batchSize: batch.length });
    }
  }
  return result;
}

export async function fetchBirdeyeBatch(
  mints: string[],
  apiKey: string,
): Promise<Map<string, PriceSource>> {
  const result = new Map<string, PriceSource>();
  if (mints.length === 0) return result;

  // Try batch endpoint first (requires paid plan)
  const chunks = chunk(mints, BATCH_CHUNK_SIZE);
  let batchAvailable = true;
  for (const batch of chunks) {
    try {
      const url = `https://public-api.birdeye.so/defi/multi_price?list_address=${batch.join(",")}`;
      const res = await fetchWithTimeout(url, {
        headers: {
          "X-API-KEY": apiKey,
          "x-chain": "solana",
        },
      }, BATCH_FETCH_TIMEOUT_MS);
      if (res.status === 401 || res.status === 403) {
        // multi_price requires paid plan — fall back to individual calls
        log.warn("Birdeye batch requires paid plan, falling back to individual calls", { status: res.status });
        batchAvailable = false;
        break;
      }
      if (!res.ok) {
        log.warn("Birdeye batch API returned non-OK", { status: res.status, batchSize: batch.length });
        continue;
      }
      const json = (await res.json()) as {
        data?: Record<string, { value?: number } | null | undefined>;
        success?: boolean;
      };
      if (!json.success || !json.data) {
        log.warn("Birdeye batch returned unsuccessful response", { batchSize: batch.length });
        continue;
      }
      const now = Date.now();
      for (const mint of batch) {
        const entry = json.data[mint];
        if (!entry || entry.value == null) continue;
        const price = entry.value;
        if (!isFinite(price) || price <= 0) {
          log.warn("Birdeye batch returned invalid price", { rawPrice: price }, mint);
          continue;
        }
        result.set(mint, { name: "birdeye", price, timestamp: now });
      }
    } catch (err) {
      log.warn("Birdeye batch fetch failed", { error: String(err), batchSize: batch.length });
    }
  }

  // Fallback: individual calls for free tier
  if (!batchAvailable) {
    const promises = mints.map((mint) =>
      fetchBirdeyePrice(mint, apiKey).then((src) => {
        if (src) result.set(mint, src);
      }),
    );
    await Promise.all(promises);
  }

  return result;
}

/**
 * Fetch and aggregate prices for multiple mints in batch (2 API calls total).
 * Returns a Map of mint → AggregatedPrice. Mints that fail are omitted.
 */
export async function fetchPricesBatch(
  mints: string[],
  birdeyeApiKey?: string,
  minSources: number = 2,
  maxDivergencePct: number = 0.05,
  jupiterApiKey?: string,
): Promise<Map<string, AggregatedPrice>> {
  const result = new Map<string, AggregatedPrice>();
  if (mints.length === 0) return result;

  // Fetch both sources in parallel
  const [jupiterPrices, birdeyePrices] = await Promise.all([
    fetchJupiterBatch(mints, jupiterApiKey),
    birdeyeApiKey
      ? fetchBirdeyeBatch(mints, birdeyeApiKey)
      : Promise.resolve(new Map<string, PriceSource>()),
  ]);

  // Aggregate per mint
  for (const mint of mints) {
    const sources: PriceSource[] = [];
    const jup = jupiterPrices.get(mint);
    if (jup) sources.push(jup);
    const bird = birdeyePrices.get(mint);
    if (bird) sources.push(bird);

    try {
      const { finalPriceUsd, confidenceUsd, validSources } = aggregateSources(
        sources,
        minSources,
        maxDivergencePct,
        mint,
      );

      // Frozen API detection (same logic as single-token fetchPrice)
      const last = lastPrices.get(mint);
      if (last && Math.abs(last.price - finalPriceUsd) < 0.0001) {
        last.sameCount++;
        if (last.sameCount >= 5) {
          log.warn(`Price unchanged for ${last.sameCount} consecutive fetches`, {
            tokenMint: mint,
            price: finalPriceUsd,
          }, mint);
        }
      } else {
        lastPrices.set(mint, { price: finalPriceUsd, sameCount: 1 });
      }

      const priceScaled = safeScalePrice(finalPriceUsd);
      const confidenceScaled = new BN(Math.round(confidenceUsd * PRICE_SCALE));

      result.set(mint, {
        price: priceScaled,
        confidence: confidenceScaled,
        numSources: validSources.length,
        sources: validSources,
      });
    } catch (err) {
      log.warn("Batch price aggregation failed", { mint, error: String(err) });
    }
  }

  // Throw on total blackout so oracle loop's consecutiveFailures counter works
  if (result.size === 0 && mints.length > 0) {
    throw new Error(`Total price blackout: 0/${mints.length} mints got valid prices`);
  }

  return result;
}

export async function fetchPrice(
  tokenMint: string,
  birdeyeApiKey?: string,
  minSources: number = 2,
  maxDivergencePct: number = 0.05,
  jupiterApiKey?: string,
): Promise<AggregatedPrice> {
  // Fetch from both sources in parallel
  const jupiterPromise = fetchJupiterPrice(tokenMint, jupiterApiKey);
  const birdeyePromise = birdeyeApiKey
    ? fetchBirdeyePrice(tokenMint, birdeyeApiKey)
    : Promise.resolve(null);

  const [jupiter, birdeye] = await Promise.all([jupiterPromise, birdeyePromise]);

  const sources: PriceSource[] = [];
  if (jupiter) sources.push(jupiter);
  if (birdeye) sources.push(birdeye);

  if (sources.length === 0) {
    throw new Error(`No price sources returned data for ${tokenMint}`);
  }

  // Fix 5: Enforce minimum source count
  if (sources.length < minSources) {
    throw new Error(`Need at least ${minSources} price sources, only got ${sources.length} for ${tokenMint}`);
  }

  let finalPriceUsd: number;
  let confidenceUsd: number;

  if (sources.length === 2) {
    // Fix 4: Max divergence check — reject if sources disagree too much
    const divergencePct = Math.abs(sources[0].price - sources[1].price) / Math.min(sources[0].price, sources[1].price);
    if (divergencePct > maxDivergencePct) {
      throw new Error(
        `Price sources diverge by ${(divergencePct * 100).toFixed(1)}%: ` +
        `${sources[0].name}=$${sources[0].price}, ${sources[1].name}=$${sources[1].price}`
      );
    }

    // Both sources: average price, confidence = |price1 - price2|
    finalPriceUsd = (sources[0].price + sources[1].price) / 2;
    confidenceUsd = Math.abs(sources[0].price - sources[1].price);
  } else {
    // Single source: use directly, confidence = 0
    finalPriceUsd = sources[0].price;
    confidenceUsd = 0;
  }

  // Fix 10: Frozen API detection
  const last = lastPrices.get(tokenMint);
  if (last && Math.abs(last.price - finalPriceUsd) < 0.0001) {
    last.sameCount++;
    if (last.sameCount >= 5) {
      log.warn(`Price unchanged for ${last.sameCount} consecutive fetches`, {
        tokenMint,
        price: finalPriceUsd,
      }, tokenMint);
    }
  } else {
    lastPrices.set(tokenMint, { price: finalPriceUsd, sameCount: 1 });
  }

  // Fix 6: Convert to on-chain scale with safe bounds checking
  const priceScaled = safeScalePrice(finalPriceUsd);
  const confidenceScaled = new BN(Math.round(confidenceUsd * PRICE_SCALE));

  return {
    price: priceScaled,
    confidence: confidenceScaled,
    numSources: sources.length,
    sources,
  };
}
