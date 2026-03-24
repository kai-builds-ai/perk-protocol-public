"use client";

import { useState, useEffect, useRef } from "react";
import { fetchHistoricalCandles, PYTH_FEEDS } from "@/lib/pyth";
import { CandleData } from "@/types";
import { MOCK_CANDLES } from "@/lib/mock-data";

/**
 * Fetch real historical candles from Pyth Benchmarks API.
 * Falls back to mock candles if Pyth doesn't have the feed or fetch fails.
 */
export function usePythCandles(
  symbol: string,
  resolution: string = "60",
  count: number = 200
) {
  const [candles, setCandles] = useState<CandleData[]>(
    MOCK_CANDLES[symbol] || []
  );
  const [loading, setLoading] = useState(true);
  const [isReal, setIsReal] = useState(false);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  useEffect(() => {
    if (!PYTH_FEEDS[symbol]) {
      // No Pyth feed — stay on mock data
      setCandles(MOCK_CANDLES[symbol] || []);
      setLoading(false);
      setIsReal(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    fetchHistoricalCandles(symbol, resolution, count).then((data) => {
      if (cancelled || symbolRef.current !== symbol) return;

      if (data.length > 0) {
        setCandles(data);
        setIsReal(true);
      } else {
        // Fetch failed — use mock
        setCandles(MOCK_CANDLES[symbol] || []);
        setIsReal(false);
      }
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [symbol, resolution, count]);

  return { candles, loading, isReal };
}
