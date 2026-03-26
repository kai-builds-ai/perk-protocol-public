"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { TopBar } from "@/components/TopBar";
import { MarketTable } from "@/components/MarketTable";
import { useMarkets } from "@/hooks/useMarkets";
import { Market, OracleSource } from "@/types";

type Tab = "trending" | "new" | "gainers" | "losers" | "all" | "watchlist" | "mine";

const TABS: { key: Tab; label: string }[] = [
  { key: "trending", label: "Trending" },
  { key: "new", label: "New" },
  { key: "gainers", label: "Gainers" },
  { key: "losers", label: "Losers" },
  { key: "all", label: "All" },
  { key: "watchlist", label: "★ Watchlist" },
];

function getWatchlist(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem("perk-watchlist-v2");
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch { return new Set(); }
}

function saveWatchlist(set: Set<string>) {
  localStorage.setItem("perk-watchlist-v2", JSON.stringify(Array.from(set)));
}

export default function MarketExplorer() {
  const { markets } = useMarkets();
  const { publicKey } = useWallet();
  const searchParams = useSearchParams();
  const [filter, setFilter] = useState("");
  const [tab, setTab] = useState<Tab>("trending");

  // Handle ?filter=mine from wallet dropdown (apply once)
  const appliedFilterRef = useRef(false);
  useEffect(() => {
    if (!appliedFilterRef.current && searchParams.get("filter") === "mine" && publicKey) {
      setTab("mine");
      appliedFilterRef.current = true;
    }
  }, [searchParams, publicKey]);
  const [watchlist, setWatchlist] = useState<Set<string>>(getWatchlist);
  const [oracleFilter, setOracleFilter] = useState<"all" | "pyth" | "dex">("all");
  const [minVolume, setMinVolume] = useState<number>(0);
  const [leverageFilter, setLeverageFilter] = useState<number>(0);

  const totalVolume = markets.reduce((s, m) => s + m.volume24h, 0);
  const solMarket = markets.find((m) => m.symbol === "SOL");

  const toggleWatchlist = useCallback((address: string) => {
    setWatchlist((prev) => {
      const next = new Set(prev);
      if (next.has(address)) {
        next.delete(address);
      } else {
        next.add(address);
      }
      saveWatchlist(next);
      return next;
    });
  }, []);

  const filtered = useMemo(() => {
    let list = [...markets];

    // Text search
    if (filter) {
      const q = filter.toLowerCase();
      list = list.filter(
        (m) =>
          m.symbol.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q)
      );
    }

    // Oracle filter
    if (oracleFilter === "pyth") {
      list = list.filter((m) => m.oracleSource === OracleSource.Pyth);
    } else if (oracleFilter === "dex") {
      list = list.filter((m) => m.oracleSource === OracleSource.DexPool);
    }

    // Min volume
    if (minVolume > 0) {
      list = list.filter((m) => m.volume24h >= minVolume);
    }

    // Leverage filter
    if (leverageFilter > 0) {
      list = list.filter((m) => m.maxLeverage >= leverageFilter);
    }

    // Tab sorting/filtering
    switch (tab) {
      case "trending":
        list.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case "new":
        list.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "gainers":
        list.sort((a, b) => b.change24h - a.change24h);
        break;
      case "losers":
        list.sort((a, b) => a.change24h - b.change24h);
        break;
      case "watchlist":
        list = list.filter((m) => watchlist.has(m.address));
        list.sort((a, b) => b.volume24h - a.volume24h);
        break;
      case "mine":
        if (publicKey) {
          list = list.filter((m) => m.creator === publicKey.toBase58());
        } else {
          list = [];
        }
        list.sort((a, b) => b.createdAt - a.createdAt);
        break;
      case "all":
      default:
        break;
    }

    return list;
  }, [markets, filter, tab, oracleFilter, minVolume, leverageFilter, watchlist, publicKey]);

  const volumeChips = [
    { label: "All", value: 0 },
    { label: ">$100K", value: 100000 },
    { label: ">$500K", value: 500000 },
    { label: ">$1M", value: 1000000 },
  ];

  const leverageChips = [
    { label: "Any", value: 0 },
    { label: "≥5x", value: 5 },
    { label: "≥10x", value: 10 },
    { label: "≥20x", value: 20 },
  ];

  return (
    <div className="flex flex-col h-screen max-w-7xl mx-auto w-full">
      <TopBar
        totalVolume={totalVolume}
        totalMarkets={markets.length}
        solPrice={solMarket?.markPrice}
      />

      {/* Tabs */}
      <div className="flex items-center gap-0 px-4 border-b border-border bg-surface overflow-x-auto no-scrollbar flex-nowrap" style={{ WebkitOverflowScrolling: "touch" }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2.5 text-sm font-sans transition-colors duration-100 border-b-2 whitespace-nowrap flex-shrink-0 ${
              tab === t.key
                ? "text-white border-white"
                : "text-text-secondary border-transparent hover:text-text-primary"
            }`}
          >
            {t.label}
          </button>
        ))}
        {publicKey && (
          <button
            onClick={() => setTab("mine")}
            className={`px-4 py-2.5 text-sm font-sans transition-colors duration-100 border-b-2 whitespace-nowrap flex-shrink-0 ${
              tab === "mine"
                ? "text-white border-white"
                : "text-text-secondary border-transparent hover:text-text-primary"
            }`}
          >
            My Markets
          </button>
        )}
      </div>

      {/* Filters row */}
      <div className="flex items-center gap-4 md:gap-6 px-4 py-2.5 border-b border-border bg-bg overflow-x-auto no-scrollbar flex-nowrap" style={{ WebkitOverflowScrolling: "touch" }}>
        {/* Search */}
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Search..."
          className="w-36 md:w-48 bg-transparent border border-zinc-800 rounded-[4px] px-3 py-1.5 text-sm font-sans text-white outline-none placeholder:text-text-tertiary focus:border-zinc-500 transition-colors duration-100 flex-shrink-0"
        />

        {/* Oracle */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sm font-sans text-text-secondary mr-1">Oracle</span>
          {(["all", "pyth", "dex"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setOracleFilter(v)}
              className={`px-3 py-1.5 text-sm font-sans rounded-[4px] border transition-colors duration-75 ${
                oracleFilter === v
                  ? "border-zinc-400 text-white bg-white/[0.05]"
                  : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
              }`}
            >
              {v === "all" ? "All" : v === "pyth" ? "Pyth" : "DEX"}
            </button>
          ))}
        </div>

        {/* Min volume */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sm font-sans text-text-secondary mr-1">Volume</span>
          {volumeChips.map((c) => (
            <button
              key={c.value}
              onClick={() => setMinVolume(c.value)}
              className={`px-3 py-1.5 text-sm font-sans rounded-[4px] border transition-colors duration-75 ${
                minVolume === c.value
                  ? "border-zinc-400 text-white bg-white/[0.05]"
                  : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Leverage */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="text-sm font-sans text-text-secondary mr-1">Leverage</span>
          {leverageChips.map((c) => (
            <button
              key={c.value}
              onClick={() => setLeverageFilter(c.value)}
              className={`px-3 py-1.5 text-sm font-sans rounded-[4px] border transition-colors duration-75 ${
                leverageFilter === c.value
                  ? "border-zinc-400 text-white bg-white/[0.05]"
                  : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>

        {/* Result count */}
        <span className="ml-auto text-xs font-mono text-text-tertiary">
          {filtered.length} market{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto" style={{ WebkitOverflowScrolling: "touch" }}>
        {tab === "watchlist" && filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <span className="text-text-tertiary text-2xl">★</span>
            <span className="text-sm font-sans text-text-secondary">No markets in your watchlist</span>
            <span className="text-xs font-sans text-text-tertiary">Click the star on any market to add it</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-sm font-sans text-text-secondary">No markets match your filters</span>
          </div>
        ) : (
          <MarketTable
            markets={filtered}
            filter=""
            watchlist={watchlist}
            onToggleWatchlist={toggleWatchlist}
          />
        )}
      </div>
    </div>
  );
}
