"use client";

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  calculateMarkPrice,
  priceToNumber,
  PRICE_SCALE,
  POS_SCALE,
  LEVERAGE_SCALE,
  MarketAccount as SDKMarketAccount,
  OracleSource as SDKOracleSource,
} from "@perk/sdk";
import { Market, OracleSource } from "@/types";
import { usePerk } from "@/providers/PerkProvider";
import { TOKEN_META } from "@/lib/token-meta";

// ── Mapping helpers ──

function mapOracleSource(src: SDKOracleSource): OracleSource {
  switch (src) {
    case SDKOracleSource.Pyth:
      return OracleSource.Pyth;
    case SDKOracleSource.PerkOracle:
      return OracleSource.PerkOracle;
    case SDKOracleSource.DexPool:
      return OracleSource.DexPool;
    default:
      return OracleSource.Pyth;
  }
}

function toFrontendMarket(address: PublicKey, m: SDKMarketAccount): Market {
  const mintStr = m.tokenMint.toBase58();
  const meta = TOKEN_META[mintStr] ?? {
    symbol: mintStr.slice(0, 6),
    name: mintStr.slice(0, 8) + "…",
  };

  const markPrice = calculateMarkPrice(m);
  const indexPrice =
    m.lastOraclePrice && !m.lastOraclePrice.isZero()
      ? priceToNumber(m.lastOraclePrice)
      : markPrice;

  const fundingRateRaw = m.fundingRateBpsPerSlotLast?.toNumber() ?? 0;
  const fundingRate = (fundingRateRaw * 9000) / 1_000_000;

  const totalLong = m.totalLongPosition.toNumber() / POS_SCALE;
  const totalShort = m.totalShortPosition.toNumber() / POS_SCALE;
  const openInterest = (totalLong + totalShort) * markPrice;

  return {
    marketIndex: m.marketIndex.toNumber(),
    tokenMint: mintStr,
    collateralMint: m.collateralMint.toBase58(),
    creator: m.creator.toBase58(),
    symbol: meta.symbol,
    name: meta.name,
    logoUrl: meta.logoUrl,

    baseReserve: parseFloat(m.baseReserve.toString()),
    quoteReserve: parseFloat(m.quoteReserve.toString()),
    k: parseFloat(m.k.toString()),
    pegMultiplier: parseFloat(m.pegMultiplier.toString()),
    totalLongPosition: totalLong,
    totalShortPosition: totalShort,

    maxLeverage: Math.floor(m.maxLeverage / LEVERAGE_SCALE),
    tradingFeeBps: m.tradingFeeBps,
    liquidationFeeBps: m.liquidationFeeBps,
    maintenanceMarginBps: m.maintenanceMarginBps,

    oracleSource: mapOracleSource(m.oracleSource),
    oracleAddress: m.oracleAddress.toBase58(),

    markPrice,
    indexPrice,
    fundingRate,
    volume24h: 0,
    openInterest,
    change24h: 0,

    active: m.active,
    totalUsers: m.totalUsers,
    totalPositions: m.totalPositions,
    createdAt: m.createdAt.toNumber() * 1000,
  };
}

// ── Context ──

interface MarketsContextValue {
  markets: Market[];
  loading: boolean;
  error: string | null;
}

const MarketsContext = createContext<MarketsContextValue>({
  markets: [],
  loading: true,
  error: null,
});

const POLL_INTERVAL = 10_000;

export function MarketsProvider({ children }: { children: React.ReactNode }) {
  const { readonlyClient, client } = usePerk();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // H-03 fix: generation counter prevents stale fetches from overwriting state
  const generationRef = useRef(0);

  const fetchMarkets = useCallback(async () => {
    const gen = ++generationRef.current;
    const perkClient = client ?? readonlyClient;
    try {
      const raw = await perkClient.fetchAllMarkets();
      // Only apply if this is still the latest generation
      if (gen !== generationRef.current) return;
      const mapped = raw.map((r) => toFrontendMarket(r.address, r.account));
      mapped.sort((a, b) => a.marketIndex - b.marketIndex);
      setMarkets(mapped);
      setError(null);
    } catch (err: any) {
      if (gen !== generationRef.current) return;
      console.error("[MarketsProvider] fetch error:", err);
      setError(err?.message ?? "Failed to fetch markets");
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [client, readonlyClient]);

  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, POLL_INTERVAL);
    return () => {
      clearInterval(interval);
    };
  }, [fetchMarkets]);

  return (
    <MarketsContext.Provider value={{ markets, loading, error }}>
      {children}
    </MarketsContext.Provider>
  );
}

export { MarketsContext };
