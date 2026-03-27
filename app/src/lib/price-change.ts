/**
 * Fetch 24h price change for Solana tokens via DexScreener.
 * Free, no auth required, tracks all tokens including pump.fun.
 * Returns a map of mint → change as decimal (e.g. -0.0359 = -3.59%).
 */

const CACHE_TTL = 60_000; // 60s
let cache: { data: Record<string, number>; ts: number } | null = null;

export async function fetch24hChanges(
  mints: string[]
): Promise<Record<string, number>> {
  // Return cache if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return cache.data;
  }

  const uniqueMints = [...new Set(mints)];
  if (uniqueMints.length === 0) return {};

  const result: Record<string, number> = {};

  try {
    // DexScreener supports up to 30 addresses per call, comma-separated
    const batchSize = 30;
    for (let i = 0; i < uniqueMints.length; i += batchSize) {
      const batch = uniqueMints.slice(i, i + batchSize);
      const addresses = batch.join(",");
      const resp = await fetch(
        `https://api.dexscreener.com/tokens/v1/solana/${addresses}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (!resp.ok) continue;

      const pairs = await resp.json();
      if (!Array.isArray(pairs)) continue;

      // DexScreener returns multiple pairs per token — use the highest-liquidity pair
      const bestPair: Record<string, any> = {};
      for (const pair of pairs) {
        const mint = pair.baseToken?.address;
        if (!mint || !batch.includes(mint)) continue;
        const liquidity = pair.liquidity?.usd ?? 0;
        if (!bestPair[mint] || liquidity > (bestPair[mint].liquidity?.usd ?? 0)) {
          bestPair[mint] = pair;
        }
      }

      for (const [mint, pair] of Object.entries(bestPair)) {
        if (pair.priceChange?.h24 != null) {
          // Convert from percentage to decimal (e.g. -3.59 → -0.0359)
          result[mint] = pair.priceChange.h24 / 100;
        }
      }
    }
  } catch {
    return cache?.data ?? {};
  }

  cache = { data: result, ts: Date.now() };
  return result;
}
