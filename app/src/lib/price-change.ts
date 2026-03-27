/**
 * Fetch 24h price change for Solana tokens via CoinGecko.
 * Batches all mints in a single API call.
 * Returns a map of mint → change as decimal (e.g. -0.038 = -3.8%).
 */

const CACHE_TTL = 60_000; // 60s
let cache: { data: Record<string, number>; ts: number } | null = null;

/**
 * Wrapped SOL mint — CoinGecko recognizes this as "solana".
 */
const WSOL = "So11111111111111111111111111111111111111112";

export async function fetch24hChanges(
  mints: string[]
): Promise<Record<string, number>> {
  // Return cache if fresh
  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return cache.data;
  }

  // Deduplicate and include WSOL for SOL markets
  const uniqueMints = [...new Set(mints)];
  if (uniqueMints.length === 0) return {};

  const result: Record<string, number> = {};

  try {
    const addresses = uniqueMints.join(",");
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${addresses}&vs_currencies=usd&include_24hr_change=true`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!resp.ok) return cache?.data ?? {};

    const data = await resp.json();
    for (const mint of uniqueMints) {
      const entry = data[mint] || data[mint.toLowerCase()];
      if (entry?.usd_24h_change != null) {
        // Convert from percentage to decimal (e.g. -3.8 → -0.038)
        result[mint] = entry.usd_24h_change / 100;
      }
    }
  } catch {
    // On error, return stale cache or empty
    return cache?.data ?? {};
  }

  cache = { data: result, ts: Date.now() };
  return result;
}
