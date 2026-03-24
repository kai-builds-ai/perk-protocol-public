"use client";

import React, { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Market } from "@/types";
import { TokenLogo } from "./TokenLogo";
import { formatUsd, formatUsdCompact, formatPct, formatFunding } from "@/lib/format";

type SortKey =
  | "symbol"
  | "markPrice"
  | "change24h"
  | "volume24h"
  | "openInterest"
  | "fundingRate"
  | "maxLeverage";

interface MarketTableProps {
  markets: Market[];
  filter: string;
  watchlist?: Set<string>;
  onToggleWatchlist?: (mint: string) => void;
}

export function MarketTable({ markets, filter, watchlist, onToggleWatchlist }: MarketTableProps) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("volume24h");
  const [sortAsc, setSortAsc] = useState(false);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortAsc((a) => !a);
      } else {
        setSortKey(key);
        setSortAsc(false);
      }
    },
    [sortKey]
  );

  const filtered = useMemo(() => {
    const q = filter.toLowerCase();
    let list = markets;
    if (q) {
      list = list.filter(
        (m) =>
          m.symbol.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q)
      );
    }
    list = [...list].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "string" && typeof bv === "string") {
        return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortAsc
        ? (av as number) - (bv as number)
        : (bv as number) - (av as number);
    });
    return list;
  }, [markets, filter, sortKey, sortAsc]);

  const header = (label: string, key: SortKey, align = "text-right") => (
    <th
      className={`px-3 py-2 text-xs font-sans font-medium uppercase tracking-wider text-text-secondary cursor-pointer select-none hover:text-text-primary ${align}`}
      onClick={() => handleSort(key)}
    >
      {label}
      {sortKey === key && (
        <span className="ml-1 text-text-tertiary">{sortAsc ? "↑" : "↓"}</span>
      )}
    </th>
  );

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          {watchlist && <th className="w-8" />}
          {header("Token", "symbol", "text-left")}
          {header("Price", "markPrice")}
          {header("24h Change", "change24h")}
          {header("24h Volume", "volume24h")}
          {header("Open Interest", "openInterest")}
          {header("Funding Rate", "fundingRate")}
          {header("Max Leverage", "maxLeverage")}
          <th className="w-8" />
        </tr>
      </thead>
      <tbody>
        {filtered.map((m) => {
          const isWatched = watchlist?.has(m.tokenMint) ?? false;
          return (
            <tr
              key={m.marketIndex}
              className="border-b border-border hover:bg-white/[0.02] cursor-pointer transition-colors duration-75"
              onClick={() => router.push(`/trade/${m.symbol.toLowerCase()}`)}
            >
              {watchlist && (
                <td className="px-2 py-2.5 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleWatchlist?.(m.tokenMint);
                    }}
                    className={`text-base transition-colors duration-100 ${
                      isWatched
                        ? "text-yellow-400"
                        : "text-zinc-600 hover:text-zinc-400"
                    }`}
                    aria-label={isWatched ? "Remove from watchlist" : "Add to watchlist"}
                  >
                    {isWatched ? "★" : "☆"}
                  </button>
                </td>
              )}
              <td className="px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <TokenLogo mint={m.tokenMint} logoUrl={m.logoUrl} size={24} />
                  <span className="font-sans font-medium text-white">
                    {m.symbol}
                  </span>
                  <span className="text-text-secondary text-xs">{m.name}</span>
                </div>
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-white">
                {formatUsd(m.markPrice)}
              </td>
              <td
                className={`px-3 py-2.5 text-right font-mono ${
                  m.change24h >= 0 ? "text-profit" : "text-loss"
                }`}
              >
                {formatPct(m.change24h)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-white">
                {formatUsdCompact(m.volume24h)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-white">
                {formatUsdCompact(m.openInterest)}
              </td>
              <td
                className={`px-3 py-2.5 text-right font-mono ${
                  m.fundingRate >= 0 ? "text-profit" : "text-loss"
                }`}
              >
                {formatFunding(m.fundingRate)}
              </td>
              <td className="px-3 py-2.5 text-right font-mono text-text-secondary">
                {m.maxLeverage}x
              </td>
              <td className="px-3 py-2.5 text-right text-text-tertiary">→</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
