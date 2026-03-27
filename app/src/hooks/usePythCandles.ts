"use client";

import { useState, useEffect, useRef } from "react";
import { fetchHistoricalCandles, PYTH_FEEDS } from "@/lib/pyth";
import { CandleData } from "@/types";
import { MOCK_CANDLES } from "@/lib/mock-data";

/**
 * Fetch candle data from GeckoTerminal for any Solana token by mint.
 * Finds the highest-liquidity pool, then fetches OHLCV.
 */
async function fetchGeckoTerminalCandles(
  mint: string,
  count: number = 200
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

    // 2. Fetch hourly OHLCV
    const ohlcvResp = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${topPool}/ohlcv/hour?aggregate=1&limit=${Math.min(count, 1000)}&currency=usd`,
      { signal: AbortSignal.timeout(8000), headers: { Accept: "application/json" } }
    );
    if (!ohlcvResp.ok) return [];
    const ohlcvData = await ohlcvResp.json();
    const list = ohlcvData.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list) || list.length === 0) return [];

    // 3. Map to CandleData format [timestamp, open, high, low, close, volume]
    return list
      .map((c: number[]) => ({
        time: c[0] as number,
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
      }))
      .sort((a: CandleData, b: CandleData) => (a.time as number) - (b.time as number));
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
        const data = await fetchGeckoTerminalCandles(mint, count);
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

  return { candles, loading, isReal };
}
