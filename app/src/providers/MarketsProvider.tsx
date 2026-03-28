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
import { TOKEN_META, getTokenDecimals, setTokenDecimals } from "@/lib/token-meta";
import { getTokenInfo } from "@/lib/token-metadata";
import { fetch24hChanges } from "@/lib/price-change";
import { recordVolumeSnapshot, getVolume24h } from "@/lib/volume-tracker";
import { useConnection } from "@solana/wallet-adapter-react";
import { getMint } from "@solana/spl-token";

// ── Mapping helpers ──

function mapOracleSource(src: SDKOracleSource | Record<string, unknown>): OracleSource {
  // Anchor deserializes Rust enums as objects like { perkOracle: {} }
  if (typeof src === "object" && src !== null) {
    const key = Object.keys(src)[0];
    if (key === "perkOracle") return OracleSource.PerkOracle;
    if (key === "dexPool") return OracleSource.DexPool;
    if (key === "pyth") return OracleSource.Pyth;
  }
  // Numeric enum fallback
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
    address: address.toBase58(),
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
    volume24h: 0, // computed below after mapping (needs address)
    totalVolume: (m.totalVolume?.toNumber() ?? 0) / (10 ** getTokenDecimals(m.collateralMint.toBase58())),
    vaultBalance: (m.vaultBalance?.toNumber() ?? 0) / (10 ** getTokenDecimals(m.collateralMint.toBase58())),
    openInterest,
    change24h: 0,

    active: m.active,
    totalUsers: m.totalUsers,
    totalPositions: m.totalPositions,
    createdAt: m.createdAt.toNumber() * 1000,

    // Creator fees: convert from raw units to human-readable using token decimals
    creatorClaimableFees: (m.creatorClaimableFees?.toNumber() ?? 0) / (10 ** getTokenDecimals(mintStr)),
    creatorFeesEarned: (m.creatorFeesEarned?.toNumber() ?? 0) / (10 ** getTokenDecimals(mintStr)),
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
  const { connection } = useConnection();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // H-03 fix: generation counter prevents stale fetches from overwriting state
  const generationRef = useRef(0);
  // P-07: Track mints we've already fetched decimals for
  const resolvedDecimalsRef = useRef<Set<string>>(new Set());
  // Track mints we've already resolved metadata for (name/symbol/logo)
  const resolvedMetaRef = useRef<Set<string>>(new Set());

  const fetchMarkets = useCallback(async () => {
    const gen = ++generationRef.current;
    const perkClient = client ?? readonlyClient;
    try {
      const raw = await perkClient.fetchAllMarkets();
      // Only apply if this is still the latest generation
      if (gen !== generationRef.current) return;

      // P-07: Fetch on-chain decimals for unknown mints before mapping
      const unknownMints = raw
        .map((r) => r.account.tokenMint.toBase58())
        .filter((mint) => getTokenDecimals(mint) === 6 && !resolvedDecimalsRef.current.has(mint));
      const uniqueUnknown = [...new Set(unknownMints)];
      await Promise.all(
        uniqueUnknown.map(async (mint) => {
          try {
            const mintInfo = await getMint(connection, new PublicKey(mint));
            setTokenDecimals(mint, mintInfo.decimals);
          } catch {
            // RPC failure — fall back to default 6
          }
          resolvedDecimalsRef.current.add(mint);
        })
      );

      // Resolve metadata for unknown mints before mapping
      const unknownMetas = raw
        .map((r) => r.account.tokenMint.toBase58())
        .filter((mint) => !TOKEN_META[mint] && !resolvedMetaRef.current.has(mint));
      const uniqueUnknownMetas = [...new Set(unknownMetas)];
      await Promise.all(
        uniqueUnknownMetas.map(async (mint) => {
          try {
            const info = await getTokenInfo(mint, connection);
            if (info && (info.symbol || info.name)) {
              TOKEN_META[mint] = {
                symbol: info.symbol || mint.slice(0, 6),
                name: info.name || mint.slice(0, 8) + "…",
                logoUrl: info.logoUrl ?? undefined,
              };
            }
          } catch { /* fall back to truncated mint */ }
          resolvedMetaRef.current.add(mint);
        })
      );

      const mapped = raw
        .map((r) => toFrontendMarket(r.address, r.account))
        .filter((m) => m.active); // Hide deactivated markets from public view
      mapped.sort((a, b) => a.marketIndex - b.marketIndex);

      // 24h volume tracking: record snapshots + compute 24h volume
      for (const m of mapped) {
        recordVolumeSnapshot(m.address, m.totalVolume);
        m.volume24h = getVolume24h(m.address, m.totalVolume);
      }

      // Fetch 24h price changes from DexScreener (cached, max 1 req/60s)
      const mints = mapped.map((m) => m.tokenMint);
      const changes = await fetch24hChanges(mints);
      for (const m of mapped) {
        if (changes[m.tokenMint] != null) {
          m.change24h = changes[m.tokenMint];
        }
      }

      setMarkets(mapped);
      setError(null);
    } catch (err: any) {
      if (gen !== generationRef.current) return;
      console.error("[MarketsProvider] fetch error");
      setError("Failed to fetch markets");
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [client, readonlyClient, connection]);

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
