"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  fetchLatestPrice,
  subscribePriceUpdates,
  PythPrice,
  PYTH_FEEDS,
} from "@/lib/pyth";

/**
 * Hook for real-time Pyth price data via SSE.
 * Falls back to mock jitter if Pyth feed doesn't exist for the symbol.
 */
const STALE_THRESHOLD_MS = 30_000; // 30 seconds

export function usePythPrice(symbol: string, fallbackPrice?: number) {
  const [price, setPrice] = useState<number>(fallbackPrice || 0);
  const [conf, setConf] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<number>(0);
  const [stale, setStale] = useState(false);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;

  // Fetch initial price
  useEffect(() => {
    if (!symbol || !PYTH_FEEDS[symbol]) {
      // No symbol or no Pyth feed — use fallback with jitter
      if (fallbackPrice) setPrice(fallbackPrice);
      return;
    }

    let cancelled = false;
    fetchLatestPrice(symbol).then((result) => {
      if (!cancelled && result && symbolRef.current === symbol) {
        setPrice(result.price);
        setConf(result.conf);
      }
    });

    return () => { cancelled = true; };
  }, [symbol, fallbackPrice]);

  // Subscribe to SSE stream
  useEffect(() => {
    if (!symbol || !PYTH_FEEDS[symbol]) {
      // No symbol or no Pyth feed — mock jitter for tokens without Pyth feeds
      if (!fallbackPrice) return;
      const interval = setInterval(() => {
        setPrice((p) => p + (Math.random() - 0.5) * p * 0.001);
      }, 2000);
      return () => clearInterval(interval);
    }

    const unsub = subscribePriceUpdates([symbol], (sym, pythPrice) => {
      if (sym === symbolRef.current) {
        setPrice(pythPrice.price);
        setConf(pythPrice.conf);
        setConnected(true);
        setLastUpdate(Date.now());
        setStale(false);
      }
    });

    return unsub;
  }, [symbol, fallbackPrice]);

  // Staleness detection: check every 5s if the price is stale
  useEffect(() => {
    if (!connected || !lastUpdate) return;
    const interval = setInterval(() => {
      const elapsed = Date.now() - lastUpdate;
      setStale(elapsed > STALE_THRESHOLD_MS);
    }, 5_000);
    return () => clearInterval(interval);
  }, [connected, lastUpdate]);

  return { price, conf, connected, stale };
}

/**
 * Hook for multiple Pyth prices at once (for market tables).
 */
export function usePythPrices(symbols: string[]) {
  const [prices, setPrices] = useState<Map<string, number>>(new Map());
  const symbolsKey = symbols.join(",");

  useEffect(() => {
    const validSymbols = symbols.filter((s) => PYTH_FEEDS[s]);
    if (validSymbols.length === 0) return;

    // Subscribe to all feeds
    const unsub = subscribePriceUpdates(validSymbols, (sym, pythPrice) => {
      setPrices((prev) => {
        const next = new Map(prev);
        next.set(sym, pythPrice.price);
        return next;
      });
    });

    return unsub;
  }, [symbolsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return prices;
}
