"use client";

import React, { useState, useMemo } from "react";
import { MOCK_TOKEN_LIST } from "@/lib/mock-data";
import { TokenLogo } from "./TokenLogo";
import { formatUsdCompact } from "@/lib/format";

export function CreateMarketForm() {
  const [search, setSearch] = useState("");
  const [selectedToken, setSelectedToken] = useState<
    (typeof MOCK_TOKEN_LIST)[0] | null
  >(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [oracleSource, setOracleSource] = useState<"dex" | "pyth">("dex");
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [tradingFee, setTradingFee] = useState(0.1);
  const [initialDepth, setInitialDepth] = useState(50);

  const filtered = useMemo(() => {
    if (!search) return MOCK_TOKEN_LIST;
    const q = search.toLowerCase();
    return MOCK_TOKEN_LIST.filter(
      (t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.name.toLowerCase().includes(q) ||
        t.mint.toLowerCase().includes(q)
    );
  }, [search]);

  const revenue = useMemo(() => {
    const feeRate = tradingFee / 100;
    const creatorShare = 0.1;
    return {
      daily100k: 100000 * feeRate * creatorShare,
      daily1m: 1000000 * feeRate * creatorShare,
    };
  }, [tradingFee]);

  return (
    <div className="max-w-xl mx-auto mt-8">
      <div className="border border-border rounded-[2px] bg-surface">
        <div className="px-4 py-3 border-b border-border">
          <h1 className="font-sans font-semibold text-sm text-white uppercase tracking-wider">
            Create Market
          </h1>
        </div>

        <div className="p-4 space-y-5">
          {/* Token search */}
          <div className="relative">
            <label className="text-xs font-sans text-text-secondary block mb-1">
              Token
            </label>
            <input
              type="text"
              value={selectedToken ? selectedToken.symbol : search}
              onChange={(e) => {
                setSearch(e.target.value);
                setSelectedToken(null);
                setShowDropdown(true);
              }}
              onFocus={() => setShowDropdown(true)}
              placeholder="Search token or paste mint..."
              className="w-full bg-transparent border border-zinc-800 rounded-[4px] px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary focus:border-zinc-500 transition-colors duration-100"
            />
            {showDropdown && !selectedToken && filtered.length > 0 && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-border bg-surface rounded-[2px] max-h-48 overflow-y-auto">
                {filtered.map((t) => (
                  <button
                    key={t.mint}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] text-left transition-colors duration-75"
                    onClick={() => {
                      setSelectedToken(t);
                      setSearch("");
                      setShowDropdown(false);
                    }}
                  >
                    <TokenLogo mint={t.mint} size={20} />
                    <span className="font-sans text-sm text-white">
                      {t.symbol}
                    </span>
                    <span className="text-xs text-text-secondary">{t.name}</span>
                    <span className="ml-auto text-xs font-mono text-text-secondary">
                      {formatUsdCompact(t.liquidity)} liq
                    </span>
                  </button>
                ))}
              </div>
            )}
            {selectedToken && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <TokenLogo mint={selectedToken.mint} size={20} />
                <span className="font-sans text-white">
                  {selectedToken.symbol}
                </span>
                <span className="text-text-secondary">
                  ({selectedToken.name})
                </span>
                <span className="text-text-secondary font-mono">
                  {formatUsdCompact(selectedToken.liquidity)} liq
                </span>
              </div>
            )}
          </div>

          {/* Oracle source */}
          <div>
            <label className="text-xs font-sans text-text-secondary block mb-2">
              Oracle
            </label>
            <div className="flex gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="oracle"
                  checked={oracleSource === "dex"}
                  onChange={() => setOracleSource("dex")}
                  className="accent-white"
                />
                <span
                  className={`text-xs font-sans ${
                    oracleSource === "dex" ? "text-white" : "text-text-secondary"
                  }`}
                >
                  DEX Pool (Raydium)
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="oracle"
                  checked={oracleSource === "pyth"}
                  onChange={() => setOracleSource("pyth")}
                  className="accent-white"
                />
                <span
                  className={`text-xs font-sans ${
                    oracleSource === "pyth" ? "text-white" : "text-text-secondary"
                  }`}
                >
                  Pyth Price Feed
                </span>
              </label>
            </div>
          </div>

          {/* Parameters */}
          <div className="border-t border-border pt-4 space-y-4">
            <div className="text-xs font-sans text-text-secondary uppercase tracking-wider mb-3">
              Parameters
            </div>

            {/* Max Leverage */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-sans text-text-secondary">
                  Max Leverage
                </span>
                <span className="text-xs font-mono text-white">
                  {maxLeverage}x
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={maxLeverage}
                onChange={(e) => setMaxLeverage(parseInt(e.target.value))}
                className="w-full h-1 bg-zinc-800 appearance-none cursor-pointer accent-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-0"
              />
            </div>

            {/* Trading Fee */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-sans text-text-secondary">
                  Trading Fee
                </span>
                <span className="text-xs font-mono text-white">
                  {tradingFee.toFixed(2)}%
                </span>
              </div>
              <input
                type="range"
                min={3}
                max={100}
                step={1}
                value={tradingFee * 100}
                onChange={(e) =>
                  setTradingFee(parseInt(e.target.value) / 100)
                }
                className="w-full h-1 bg-zinc-800 appearance-none cursor-pointer accent-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-0"
              />
            </div>

            {/* Initial Depth */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-sans text-text-secondary">
                  Initial Depth
                </span>
                <span className="text-xs font-mono text-white">
                  {initialDepth < 33
                    ? "Low"
                    : initialDepth < 66
                    ? "Medium"
                    : "High"}
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                value={initialDepth}
                onChange={(e) =>
                  setInitialDepth(parseInt(e.target.value))
                }
                className="w-full h-1 bg-zinc-800 appearance-none cursor-pointer accent-white [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-0"
              />
            </div>
          </div>

          {/* Revenue estimate */}
          <div className="border-t border-border pt-4">
            <div className="text-xs font-sans text-text-secondary uppercase tracking-wider mb-2">
              Your Revenue
            </div>
            <p className="text-xs text-text-secondary font-sans mb-2">
              You earn 10% of all trading fees on this market.
            </p>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-secondary font-sans">
                  At $100K daily volume
                </span>
                <span className="font-mono text-white">
                  ${revenue.daily100k.toFixed(0)}/day ($
                  {(revenue.daily100k * 30).toFixed(0)}/mo)
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-secondary font-sans">
                  At $1M daily volume
                </span>
                <span className="font-mono text-white">
                  ${revenue.daily1m.toFixed(0)}/day ($
                  {(revenue.daily1m * 30).toFixed(0)}/mo)
                </span>
              </div>
            </div>
          </div>

          {/* Cost + Create button */}
          <div className="pt-2">
            <div className="flex items-center justify-between text-xs mb-3">
              <span className="text-text-secondary font-sans">Cost</span>
              <span className="font-mono text-text-secondary">~0.05 SOL</span>
            </div>
            <button
              disabled={!selectedToken}
              className={`w-full py-2.5 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
                selectedToken
                  ? "border-white/80 text-white hover:bg-white/10"
                  : "border-zinc-800 text-zinc-600 cursor-not-allowed"
              }`}
            >
              Create Market
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
