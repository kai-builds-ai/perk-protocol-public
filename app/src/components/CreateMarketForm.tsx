"use client";

import React, { useState, useMemo, useCallback } from "react";
import { MOCK_TOKEN_LIST } from "@/lib/mock-data";
import { TokenLogo } from "./TokenLogo";
import { formatUsdCompact } from "@/lib/format";
import { usePerk } from "@/providers/PerkProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  OracleSource as SdkOracleSource,
  LEVERAGE_SCALE,
  MIN_INITIAL_K,
} from "@perk/sdk";
import { useRouter } from "next/navigation";
import { getTokenMeta } from "@/lib/token-metadata";
import toast from "react-hot-toast";

type OracleChoice = "perkOracle" | "pyth" | "dexPool";

/** Validate a string as a Solana public key */
function isValidPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

interface ResolvedToken {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
}

export function CreateMarketForm() {
  const [search, setSearch] = useState("");
  const [selectedToken, setSelectedToken] = useState<
    (typeof MOCK_TOKEN_LIST)[0] | null
  >(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [oracleSource, setOracleSource] = useState<OracleChoice>("perkOracle");
  const [oracleAddress, setOracleAddress] = useState(""); // for pyth/dexPool
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [tradingFee, setTradingFee] = useState(0.1);
  const [initialDepth, setInitialDepth] = useState(50);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Custom mint address input (when pasting an address not in the list)
  const [customMint, setCustomMint] = useState<ResolvedToken | null>(null);
  const [resolvingMint, setResolvingMint] = useState(false);

  const { client, readonlyClient } = usePerk();
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const router = useRouter();

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

  // Resolve a pasted mint address
  const handleSearchChange = useCallback(
    async (value: string) => {
      setSearch(value);
      setSelectedToken(null);
      setCustomMint(null);
      setShowDropdown(true);

      // If it looks like a valid pubkey and not in the known list, resolve it
      if (isValidPubkey(value) && !MOCK_TOKEN_LIST.find((t) => t.mint === value)) {
        setResolvingMint(true);
        try {
          const meta = await getTokenMeta(value, connection);
          setCustomMint({
            mint: value,
            symbol: meta.symbol,
            name: meta.name,
            logoUrl: meta.logoUrl,
          });
        } catch {
          setCustomMint({
            mint: value,
            symbol: value.slice(0, 4) + "...",
            name: "Unknown Token",
            logoUrl: null,
          });
        } finally {
          setResolvingMint(false);
        }
      }
    },
    [connection]
  );

  const revenue = useMemo(() => {
    const feeRate = tradingFee / 100;
    const creatorShare = 0.1;
    return {
      daily100k: 100000 * feeRate * creatorShare,
      daily1m: 1000000 * feeRate * creatorShare,
    };
  }, [tradingFee]);

  // Map initial depth slider to K value
  const initialK = useMemo(() => {
    if (initialDepth < 33) {
      // Low: 1e18
      return MIN_INITIAL_K;
    } else if (initialDepth < 66) {
      // Medium: 1e19
      return MIN_INITIAL_K.mul(new BN(10));
    } else {
      // High: 1e20
      return MIN_INITIAL_K.mul(new BN(100));
    }
  }, [initialDepth]);

  const selectedMint = selectedToken?.mint ?? customMint?.mint ?? null;

  const sdkOracleSource = useMemo(() => {
    switch (oracleSource) {
      case "perkOracle":
        return SdkOracleSource.PerkOracle;
      case "pyth":
        return SdkOracleSource.Pyth;
      case "dexPool":
        return SdkOracleSource.DexPool;
    }
  }, [oracleSource]);

  const handleCreate = useCallback(async () => {
    if (!selectedMint) return;

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    if ((oracleSource === "pyth" || oracleSource === "dexPool") && !isValidPubkey(oracleAddress)) {
      toast.error("Please enter a valid oracle address.");
      return;
    }

    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(selectedMint);

      // Determine oracle address
      let oracle: PublicKey;
      if (oracleSource === "perkOracle") {
        // Check if PerkOracle exists for this token
        const existing = await readonlyClient.fetchPerkOracleNullable(tokenMint);
        if (!existing) {
          toast.error(
            "No PerkOracle exists for this token yet. " +
            "Please contact the protocol admin to initialize one, or use Pyth/DexPool oracle."
          );
          setIsSubmitting(false);
          return;
        }
        oracle = readonlyClient.getPerkOracleAddress(tokenMint);
      } else {
        oracle = new PublicKey(oracleAddress);
      }

      const tradingFeeBps = Math.round(tradingFee * 100); // 0.10% → 10 bps
      const maxLeverageScaled = maxLeverage * LEVERAGE_SCALE;

      const sig = await client.createMarket(tokenMint, oracle, {
        oracleSource: sdkOracleSource,
        maxLeverage: maxLeverageScaled,
        tradingFeeBps,
        initialK,
      });

      toast.success("Market created!\nTX: " + sig.slice(0, 16) + "...");

      // Redirect to the new market's trade page
      const symbol = selectedToken?.symbol ?? customMint?.symbol ?? selectedMint.slice(0, 4);
      router.push(`/trade/${symbol.toLowerCase()}`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Create market failed:", err);
      toast.error("Failed to create market: " + message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    client,
    publicKey,
    selectedMint,
    oracleSource,
    oracleAddress,
    tradingFee,
    maxLeverage,
    initialK,
    sdkOracleSource,
    readonlyClient,
    selectedToken,
    customMint,
    router,
  ]);

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
              onChange={(e) => handleSearchChange(e.target.value)}
              onFocus={() => setShowDropdown(true)}
              placeholder="Search token or paste mint address..."
              className="w-full bg-transparent border border-zinc-800 rounded-[4px] px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary focus:border-zinc-500 transition-colors duration-100"
            />
            {showDropdown && !selectedToken && (filtered.length > 0 || customMint) && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-border bg-surface rounded-[2px] max-h-48 overflow-y-auto">
                {/* Custom mint address result */}
                {customMint && (
                  <button
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] text-left transition-colors duration-75 border-b border-border"
                    onClick={() => {
                      setSelectedToken(null);
                      setSearch("");
                      setShowDropdown(false);
                    }}
                  >
                    <TokenLogo mint={customMint.mint} logoUrl={customMint.logoUrl ?? undefined} size={20} />
                    <span className="font-sans text-sm text-white">
                      {customMint.symbol}
                    </span>
                    <span className="text-xs text-text-secondary">{customMint.name}</span>
                    <span className="ml-auto text-xs font-mono text-text-tertiary truncate max-w-[120px]">
                      {customMint.mint}
                    </span>
                  </button>
                )}
                {resolvingMint && (
                  <div className="px-3 py-2 text-xs text-text-tertiary font-sans">
                    Resolving mint address...
                  </div>
                )}
                {filtered.map((t) => (
                  <button
                    key={t.mint}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-white/[0.02] text-left transition-colors duration-75"
                    onClick={() => {
                      setSelectedToken(t);
                      setCustomMint(null);
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
            {!selectedToken && customMint && !showDropdown && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <TokenLogo mint={customMint.mint} logoUrl={customMint.logoUrl ?? undefined} size={20} />
                <span className="font-sans text-white">{customMint.symbol}</span>
                <span className="text-text-secondary">({customMint.name})</span>
                <span className="text-text-tertiary font-mono truncate max-w-[200px]">
                  {customMint.mint}
                </span>
              </div>
            )}
          </div>

          {/* Oracle source */}
          <div>
            <label className="text-xs font-sans text-text-secondary block mb-2">
              Oracle
            </label>
            <div className="flex gap-3 flex-wrap">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="oracle"
                  checked={oracleSource === "perkOracle"}
                  onChange={() => setOracleSource("perkOracle")}
                  className="accent-white"
                />
                <span
                  className={`text-xs font-sans ${
                    oracleSource === "perkOracle" ? "text-white" : "text-text-secondary"
                  }`}
                >
                  Perk Oracle
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
                  Pyth
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="oracle"
                  checked={oracleSource === "dexPool"}
                  onChange={() => setOracleSource("dexPool")}
                  className="accent-white"
                />
                <span
                  className={`text-xs font-sans ${
                    oracleSource === "dexPool" ? "text-white" : "text-text-secondary"
                  }`}
                >
                  DEX Pool
                </span>
              </label>
            </div>
            {/* Oracle address input (for Pyth/DexPool) */}
            {oracleSource !== "perkOracle" && (
              <div className="mt-2">
                <input
                  type="text"
                  value={oracleAddress}
                  onChange={(e) => setOracleAddress(e.target.value)}
                  placeholder={
                    oracleSource === "pyth"
                      ? "Pyth price feed address..."
                      : "DEX pool address..."
                  }
                  className="w-full bg-transparent border border-zinc-800 rounded-[4px] px-3 py-2 text-xs font-mono text-white outline-none placeholder:text-text-tertiary focus:border-zinc-500 transition-colors duration-100"
                />
              </div>
            )}
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
                min={2}
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
              <span className="font-mono text-text-secondary">~1 SOL + rent</span>
            </div>
            <button
              onClick={handleCreate}
              disabled={!selectedMint || isSubmitting}
              className={`w-full py-2.5 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
                !selectedMint || isSubmitting
                  ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
                  : "border-white/80 text-white hover:bg-white/10"
              }`}
            >
              {isSubmitting ? "Creating Market..." : "Create Market"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
