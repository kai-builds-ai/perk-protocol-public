"use client";

import { useState, useEffect, useRef } from "react";
import { fetchHistoricalCandles, PYTH_FEEDS } from "@/lib/pyth";
import { CandleData } from "@/types";
import { MOCK_CANDLES } from "@/lib/mock-data";

/** Map our resolution strings to GeckoTerminal OHLCV endpoints */
function geckoTimeframe(resolution: string): { period: string; aggregate: number } {
  switch (resolution) {
    case "5":  return { period: "minute", aggregate: 5 };
    case "15": return { period: "minute", aggregate: 15 };
    case "60": return { period: "hour", aggregate: 1 };
    case "240": return { period: "hour", aggregate: 4 };
    case "D":  return { period: "day", aggregate: 1 };
    default:   return { period: "hour", aggregate: 1 };
  }
}

/**
 * Fetch candle data from GeckoTerminal for any Solana token by mint.
 * Finds the highest-liquidity pool, then fetches OHLCV.
 */
async function fetchGeckoTerminalCandles(
  mint: string,
  count: number = 200,
  resolution: string = "60"
): Promise<CandleData[]> {
  try {
    // 1. Find top pool for this token
    const poolsResp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?sort=h24_volume_usd_desc&page=1`,
      { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } }
    );
    if (!poolsResp.ok) return [];
    const poolsData = await poolsResp.json();
    const topPool = poolsData.data?.[0]?.attributes?.address;
    if (!topPool) return [];

    // 2. Fetch OHLCV at requested resolution
    const { period, aggregate } = geckoTimeframe(resolution);
    const ohlcvResp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${topPool}/ohlcv/${period}?aggregate=${aggregate}&limit=${Math.min(count, 1000)}&currency=usd`,
      { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } }
    );
    if (!ohlcvResp.ok) return [];
    const ohlcvData = await ohlcvResp.json();
    const list = ohlcvData.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) return [];

    // 3. Map to CandleData format [timestamp, open, high, low, close, volume]
    const raw = list
      .map((c: number[]) => ({
        time: c[0] as number,
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
      }))
      .filter((c: CandleData) => c.open > 0 && c.close > 0 && c.high > 0 && c.low > 0)
      .sort((a: CandleData, b: CandleData) => (a.time as number) - (b.time as number));

    // 4. Trim to last 7 days — launch-day pump spikes crush the chart
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    const recent = raw.filter((c: CandleData) => (c.time as number) >= sevenDaysAgo);
    // Fall back to last 48 candles if all data is older than 7 days
    const trimmed = recent.length > 10 ? recent : raw.slice(-48);

    // 5. Clamp extreme wicks — cap high/low to 3x the open/close range
    return trimmed.map((c: CandleData) => {
      const body = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      const maxWick = body * 3;
      const minWick = bodyLow / 3;
      return {
        ...c,
        high: Math.min(c.high, maxWick),
        low: Math.max(c.low, minWick),
      };
    });
  } catch {
    return [];
  }
}

/**
 * Fetch real historical candles from Pyth Benchmarks API.
 * Falls back to GeckoTerminal for non-Pyth tokens (any Solana token).
 * Falls back to mock candles as last resort.
 */
export function usePythCandles(
  symbol: string,
  resolution: string = "60",
  count: number = 200,
  mint?: string
) {
  const [candles, setCandles] = useState<CandleData[]>(
    MOCK_CANDLES[symbol] || []
  );
  const [loading, setLoading] = useState(true);
  const [isReal, setIsReal] = useState(false);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    if (!symbol) {
      setCandles([]);
      setLoading(false);
      setIsReal(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    (async () => {
      // 1. Try Pyth first (for tokens with Pyth feeds)
      if (PYTH_FEEDS[symbol]) {
        const data = await fetchHistoricalCandles(symbol, resolution, count);
        if (!cancelled && symbolRef.current === symbol && data.length > 0) {
          setCandles(data);
          setIsReal(true);
          setLoading(false);
          return;
        }
      }

      // 2. Fall back to GeckoTerminal (works for any Solana token)
      if (mint) {
        const data = await fetchGeckoTerminalCandles(mint, count, resolution);
        if (!cancelled && symbolRef.current === symbol && data.length > 0) {
          setCandles(data);
          setIsReal(true);
          setLoading(false);
          return;
        }
      }

      // 3. Last resort — mock data
      if (!cancelled && symbolRef.current === symbol) {
        setCandles(MOCK_CANDLES[symbol] || []);
        setIsReal(false);
        setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [symbol, resolution, count, mint]);

  // Auto-refresh candles every 60s
  useEffect(() => {
    if (!symbol) return;
    const interval = setInterval(async () => {
      // Try Pyth first
      if (PYTH_FEEDS[symbol]) {
        const data = await fetchHistoricalCandles(symbol, resolution, count);
        if (symbolRef.current === symbol && data.length > 0) {
          setCandles(data);
          return;
        }
      }
      // Fallback to GeckoTerminal
      if (mint) {
        const data = await fetchGeckoTerminalCandles(mint, count, resolution);
        if (symbolRef.current === symbol && data.length > 0) {
          setCandles(data);
        }
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [symbol, resolution, count, mint]);

  return { candles, loading, isReal };
}
