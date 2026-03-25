"use client";

import { useContext } from "react";
import { MarketsContext } from "@/providers/MarketsProvider";

export function useMarkets() {
  return useContext(MarketsContext);
}

export function useMarket(symbol: string) {
  const { markets, loading, error } = useMarkets();
  const market = markets.find(
    (m) => m.symbol.toLowerCase() === symbol.toLowerCase(),
  );
  return { market: market ?? null, loading, error };
}
