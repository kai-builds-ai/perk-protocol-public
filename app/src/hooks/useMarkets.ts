"use client";

import { useContext } from "react";
import { MarketsContext } from "@/providers/MarketsProvider";

export function useMarkets() {
  return useContext(MarketsContext);
}

/**
 * Look up a market by address (preferred) or symbol (backward compat).
 * Tries exact address match first, then falls back to case-insensitive symbol.
 */
export function useMarket(key: string) {
  const { markets, loading, error } = useMarkets();

  const byAddress = markets.find((m) => m.address === key);
  const market = byAddress
    ?? markets.find((m) => m.symbol.toLowerCase() === key.toLowerCase())
    ?? null;

  return { market, loading, error };
}
