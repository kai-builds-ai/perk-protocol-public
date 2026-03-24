"use client";

import { useState, useEffect, useRef } from "react";
import { Market } from "@/types";
import { MOCK_MARKETS } from "@/lib/mock-data";

// WebSocket-ready: replace setInterval with real WS stream later
export function useMarkets() {
  const [markets, setMarkets] = useState<Market[]>(MOCK_MARKETS);
  const marketsRef = useRef(markets);
  marketsRef.current = markets;

  useEffect(() => {
    // Simulate price ticks every 2s
    const interval = setInterval(() => {
      setMarkets((prev) =>
        prev.map((m) => {
          const jitter = (Math.random() - 0.5) * m.markPrice * 0.002;
          const newPrice = m.markPrice + jitter;
          return {
            ...m,
            markPrice: newPrice,
            indexPrice: newPrice - (Math.random() - 0.5) * m.markPrice * 0.0005,
          };
        })
      );
    }, 2000);

    return () => clearInterval(interval);
  }, []);

  return { markets };
}

export function useMarket(symbol: string) {
  const { markets } = useMarkets();
  const market = markets.find(
    (m) => m.symbol.toLowerCase() === symbol.toLowerCase()
  );
  return { market: market ?? null };
}
