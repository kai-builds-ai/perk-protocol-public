"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { TokenLogo } from "./TokenLogo";
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
import { getTokenLogo, getTokenInfo } from "@/lib/token-metadata";
import toast from "react-hot-toast";
import { sanitizeError } from "@/lib/error-utils";

// NOTE: Pyth Pull Oracle integration deferred to v2 (requires program upgrade
// to accept oracle accounts as instruction parameters per-transaction).
// All tokens use PerkOracle for now — cranker maintains prices from Jupiter+Birdeye.

/** Supported collateral stablecoins (all 6 decimals) */
const COLLATERAL_OPTIONS = [
  {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    symbol: "USDC",
    name: "USD Coin",
    logoUrl: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  },
  {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    symbol: "USDT",
    name: "Tether USD",
    logoUrl: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg",
  },
  {
    mint: "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
    symbol: "PYUSD",
    name: "PayPal USD",
    logoUrl: "https://assets.coingecko.com/coins/images/31212/small/PYUSD_Logo_%282%29.png",
  },
] as const;

/** Validate a string as a Solana public key */
function isValidPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

interface TokenInfo {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
}

interface ResolvedToken {
  mint: string;
  symbol: string;
  name: string;
  logoUrl: string | null;
}

export function CreateMarketForm() {
  const [search, setSearch] = useState("");
  const [selectedToken, setSelectedToken] = useState<TokenInfo | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [maxLeverage, setMaxLeverage] = useState(10);
  const [tradingFee, setTradingFee] = useState(0.1);
  const [collateralMint, setCollateralMint] = useState(COLLATERAL_OPTIONS[0].mint);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Jupiter token list
  const [jupiterTokens, setJupiterTokens] = useState<TokenInfo[]>([]);
  const [tokensLoading, setTokensLoading] = useState(true);
  const [tokensError, setTokensError] = useState(false);

  // Custom mint address input (when pasting an address not in the list)
  const [customMint, setCustomMint] = useState<ResolvedToken | null>(null);
  const [resolvingMint, setResolvingMint] = useState(false);

  // Outside-click dismiss ref
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Oracle existence check
  const [oracleExists, setOracleExists] = useState<boolean | null>(null);
  const [checkingOracle, setCheckingOracle] = useState(false);

  // Oracle wait state for new markets
  const [oracleWaitPhase, setOracleWaitPhase] = useState<
    null | "initializing" | "waiting" | "ready" | "failed"
  >(null);
  const [oracleWaitProgress, setOracleWaitProgress] = useState(0);

  const { client, readonlyClient } = usePerk();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const router = useRouter();

  // Search Jupiter tokens API on query change (debounced)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (!search || search.length < 2) {
      setJupiterTokens([]);
      setTokensLoading(false);
      setTokensError(false);
      return;
    }
    setTokensLoading(true);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(async () => {
      try {
        const res = await fetch(
          `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(search)}&limit=20`,
          { headers: { "x-api-key": process.env.NEXT_PUBLIC_JUPITER_API_KEY || "" } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: Array<{
          id: string;
          symbol: string;
          name: string;
          decimals: number;
          icon: string;
          isVerified: boolean;
        }> = await res.json();
        setJupiterTokens(
          data
            .filter((t) => t.isVerified)
            .map((t) => ({
              mint: t.id,
              symbol: t.symbol,
              name: t.name,
              decimals: t.decimals,
              logoUrl: t.icon || null,
            }))
        );
        setTokensError(false);
      } catch {
        setTokensError(true);
      } finally {
        setTokensLoading(false);
      }
    }, 300);
    return () => clearTimeout(searchTimerRef.current);
  }, [search]);

  // Outside-click dismiss
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Check oracle existence when a token is selected
  const selectedMintForOracle = selectedToken?.mint ?? customMint?.mint ?? null;
  useEffect(() => {
    if (!selectedMintForOracle) {
      setOracleExists(null);
      return;
    }
    let cancelled = false;
    setCheckingOracle(true);
    setOracleExists(null);

    (async () => {
      try {
        const oracle = await readonlyClient.fetchPerkOracleNullable(new PublicKey(selectedMintForOracle));
        if (!cancelled) setOracleExists(oracle !== null);
      } catch {
        if (!cancelled) setOracleExists(false);
      } finally {
        if (!cancelled) setCheckingOracle(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedMintForOracle, readonlyClient]);

  // Jupiter search is server-side, results are already filtered
  const filtered = jupiterTokens;

  // Resolve a pasted mint address
  const handleSearchChange = useCallback(
    async (value: string) => {
      setSearch(value);
      setSelectedToken(null);
      setCustomMint(null);
      setShowDropdown(true);

      // If it looks like a valid pubkey and not in the Jupiter list, resolve it
      if (
        isValidPubkey(value) &&
        !jupiterTokens.find((t) => t.mint === value)
      ) {
        setResolvingMint(true);
        try {
          const info = await getTokenInfo(value, connection);
          setCustomMint({
            mint: value,
            symbol: info.symbol || value.slice(0, 4) + "...",
            name: info.name || "Custom Token",
            logoUrl: info.logoUrl,
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
    [connection, jupiterTokens]
  );

  const revenue = useMemo(() => {
    const feeRate = tradingFee / 100;
    const creatorShare = 0.1;
    return {
      daily100k: 100000 * feeRate * creatorShare,
      daily1m: 1000000 * feeRate * creatorShare,
    };
  }, [tradingFee]);

  // Default K = Medium (1e19)
  // K = 10^23 — supports ~$63K max position size, reasonable for early markets
  const initialK = MIN_INITIAL_K.mul(new BN(100_000));

  const selectedMint = selectedMintForOracle;

  const handleCreate = useCallback(async () => {
    if (!selectedMint) return;

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(selectedMint);
      const oracle = readonlyClient.getPerkOracleAddress(tokenMint);

      // Auto-initialize oracle if it doesn't exist (permissionless)
      const existingOracle = await readonlyClient.fetchPerkOracleNullable(tokenMint);
      if (!existingOracle) {
        setOracleWaitPhase("initializing");
        setOracleWaitProgress(0);
        await client.initializePerkOracle(tokenMint, {
          minSources: 2,
          maxStalenessSeconds: 30,
          maxPriceChangeBps: 0, // no banding — memecoins move freely
          circuitBreakerDeviationBps: 0, // disabled
        });
        setOracleWaitPhase("waiting");
        // Wait for cranker to feed at least one price (polls every 5s, up to 90s)
        let priceFed = false;
        const maxPolls = 18;
        for (let i = 0; i < maxPolls; i++) {
          setOracleWaitProgress(Math.round(((i + 1) / maxPolls) * 100));
          await new Promise((r) => setTimeout(r, 5000));
          const oracleData = await readonlyClient.fetchPerkOracleNullable(tokenMint);
          if (oracleData && !oracleData.price.isZero()) {
            priceFed = true;
            break;
          }
        }
        if (!priceFed) {
          setOracleWaitPhase("failed");
          setIsSubmitting(false);
          return;
        }
        setOracleWaitPhase("ready");
        // Brief pause so user sees the "ready" state
        await new Promise((r) => setTimeout(r, 1000));
      }

      const oracleSource = SdkOracleSource.PerkOracle;

      const tradingFeeBps = Math.round(tradingFee * 100); // 0.10% → 10 bps
      const maxLeverageScaled = maxLeverage * LEVERAGE_SCALE;

      const sig = await client.createMarket(
        tokenMint,
        oracle,
        {
          oracleSource,
          maxLeverage: maxLeverageScaled,
          tradingFeeBps,
          initialK,
        },
        new PublicKey(collateralMint),
      );

      setOracleWaitPhase(null);
      toast.success("Market created!\nTX: " + sig.slice(0, 16) + "...");

      // Brief delay to let the account finalize before redirecting
      await new Promise((r) => setTimeout(r, 2000));

      // Redirect to the new market's trade page using PDA address
      const marketAddress = client.getMarketAddress(tokenMint, publicKey);
      router.push(`/trade/${marketAddress.toBase58()}`);
    } catch (err: unknown) {
      // Temporary debug: dump EVERYTHING about the error
      console.error("[create-market] FULL ERROR:", err);
      try {
        console.error("[create-market] JSON:", JSON.stringify(err, Object.getOwnPropertyNames(err as object)));
      } catch { /* ignore */ }
      if (err && typeof err === "object") {
        const e = err as Record<string, unknown>;
        console.error("[create-market] keys:", Object.keys(e));
        if (e.simulationResponse) console.error("[create-market] simulationResponse:", JSON.stringify(e.simulationResponse));
        if (e.logs) console.error("[create-market] logs:", JSON.stringify(e.logs));
        if (e.error) console.error("[create-market] .error:", JSON.stringify(e.error));
        if (e.cause) console.error("[create-market] .cause:", e.cause);
        if (e.code) console.error("[create-market] .code:", e.code);
        if ((e as any).simulationLogs) console.error("[create-market] simulationLogs:", (e as any).simulationLogs);
      }
      if (err instanceof Error) {
        console.error("[create-market] message:", err.message);
      }
      toast.error(sanitizeError(err, "create-market"));
    } finally {
      setIsSubmitting(false);
      if (oracleWaitPhase !== "failed") setOracleWaitPhase(null);
    }
  }, [
    client,
    publicKey,
    selectedMint,
    tradingFee,
    maxLeverage,
    initialK,
    collateralMint,
    readonlyClient,
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
          <div className="relative" ref={dropdownRef}>
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
            {showDropdown && !selectedToken && (
              <div className="absolute z-10 top-full left-0 right-0 mt-1 border border-border bg-surface rounded-[2px] max-h-48 overflow-y-auto">
                {/* Loading state */}
                {tokensLoading && (
                  <div className="px-3 py-2 text-xs text-text-tertiary font-sans">
                    Loading tokens...
                  </div>
                )}
                {/* Error state */}
                {tokensError && !tokensLoading && (
                  <div className="px-3 py-2 text-xs text-text-tertiary font-sans">
                    Failed to load token list. Paste a mint address instead.
                  </div>
                )}
                {/* Custom mint address result — hide if Jupiter already found it */}
                {customMint && !filtered.some(t => t.mint === customMint.mint) && (
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
                    <TokenLogo mint={t.mint} logoUrl={t.logoUrl ?? undefined} size={20} />
                    <span className="font-sans text-sm text-white">
                      {t.symbol}
                    </span>
                    <span className="text-xs text-text-secondary">{t.name}</span>
                    <span className="ml-auto text-xs font-mono text-text-tertiary truncate max-w-[120px]">
                      {t.mint.slice(0, 4)}...{t.mint.slice(-4)}
                    </span>
                  </button>
                ))}
                {!tokensLoading && !tokensError && filtered.length === 0 && !customMint && !resolvingMint && search.length >= 2 && (
                  <div className="px-3 py-2 text-xs text-text-tertiary font-sans">
                    No tokens found. Try pasting a mint address.
                  </div>
                )}
                {!tokensLoading && search.length < 2 && !customMint && (
                  <div className="px-3 py-2 text-xs text-text-tertiary font-sans">
                    Type to search or paste a mint address.
                  </div>
                )}
              </div>
            )}
            {selectedToken && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                <TokenLogo mint={selectedToken.mint} logoUrl={selectedToken.logoUrl ?? undefined} size={20} />
                <span className="font-sans text-white">
                  {selectedToken.symbol}
                </span>
                <span className="text-text-secondary">
                  ({selectedToken.name})
                </span>
                <span className="text-text-tertiary font-mono">
                  {selectedToken.mint.slice(0, 4)}...{selectedToken.mint.slice(-4)}
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

          {/* Oracle — always PerkOracle, cranker handles feed selection */}

          {/* Parameters + Revenue — shown when token is selected */}
          {selectedMint && (<>
          <div className="border-t border-border pt-4 space-y-5">
            <div className="text-xs font-sans text-text-secondary uppercase tracking-wider mb-3">
              Parameters
            </div>

            {/* Collateral Stablecoin */}
            <div>
              <label className="text-xs font-sans text-text-secondary block mb-2">
                Collateral
              </label>
              <div className="grid grid-cols-3 gap-2">
                {COLLATERAL_OPTIONS.map((opt) => (
                  <button
                    key={opt.mint}
                    type="button"
                    onClick={() => setCollateralMint(opt.mint)}
                    className={`flex items-center justify-center gap-1.5 px-3 py-2 rounded-[4px] border text-xs font-sans transition-colors duration-100 ${
                      collateralMint === opt.mint
                        ? "border-emerald-500/60 bg-emerald-500/[0.06] text-white"
                        : "border-zinc-800 text-text-secondary hover:border-zinc-600 hover:text-white"
                    }`}
                  >
                    <img
                      src={opt.logoUrl}
                      alt={opt.symbol}
                      className="w-4 h-4 rounded-full"
                      onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                    />
                    {opt.symbol}
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-text-tertiary mt-1.5 font-sans">
                All traders on this market will use {COLLATERAL_OPTIONS.find(o => o.mint === collateralMint)?.symbol ?? "this stablecoin"} as collateral.
              </p>
            </div>

            {/* Max Leverage */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-sans text-text-secondary">
                  Max Leverage
                </span>
                <span className="text-xs font-mono text-white">
                  {maxLeverage}x
                </span>
              </div>
              <div className="relative w-full h-6 flex items-center">
                <div className="absolute left-0 right-0 h-2 rounded-full bg-zinc-800" />
                <div
                  className="absolute left-0 h-2 rounded-full bg-gradient-to-r from-emerald-500/60 to-emerald-400/80"
                  style={{ width: `${((maxLeverage - 2) / (20 - 2)) * 100}%` }}
                />
                <input
                  type="range"
                  min={2}
                  max={20}
                  step={1}
                  value={maxLeverage}
                  onChange={(e) => setMaxLeverage(parseInt(e.target.value))}
                  className="relative w-full h-2 appearance-none cursor-pointer bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-900 [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.5),0_0_0_3px_rgba(255,255,255,0.1)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:hover:shadow-[0_0_12px_rgba(52,211,153,0.7),0_0_0_3px_rgba(255,255,255,0.2)] [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-900 [&::-moz-range-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.5)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent"
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[10px] font-mono text-zinc-600">2x</span>
                <span className="text-[10px] font-mono text-zinc-600">20x</span>
              </div>
            </div>

            {/* Trading Fee */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-sans text-text-secondary">
                  Trading Fee
                </span>
                <span className="text-xs font-mono text-white">
                  {tradingFee.toFixed(2)}%
                </span>
              </div>
              <div className="relative w-full h-6 flex items-center">
                <div className="absolute left-0 right-0 h-2 rounded-full bg-zinc-800" />
                <div
                  className="absolute left-0 h-2 rounded-full bg-gradient-to-r from-emerald-500/60 to-emerald-400/80"
                  style={{ width: `${((tradingFee * 100 - 3) / (100 - 3)) * 100}%` }}
                />
                <input
                  type="range"
                  min={3}
                  max={100}
                  step={1}
                  value={tradingFee * 100}
                  onChange={(e) =>
                    setTradingFee(parseInt(e.target.value) / 100)
                  }
                  className="relative w-full h-2 appearance-none cursor-pointer bg-transparent [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-5 [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-900 [&::-webkit-slider-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.5),0_0_0_3px_rgba(255,255,255,0.1)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-shadow [&::-webkit-slider-thumb]:hover:shadow-[0_0_12px_rgba(52,211,153,0.7),0_0_0_3px_rgba(255,255,255,0.2)] [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-900 [&::-moz-range-thumb]:shadow-[0_0_8px_rgba(52,211,153,0.5)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:bg-transparent"
                />
              </div>
              <div className="flex justify-between mt-1.5">
                <span className="text-[10px] font-mono text-zinc-600">0.03%</span>
                <span className="text-[10px] font-mono text-zinc-600">1.00%</span>
              </div>
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
          </>)}

          {/* Oracle initialization waiting state */}
          {oracleWaitPhase && oracleWaitPhase !== "failed" && (
            <div className="border border-accent/20 rounded-[4px] bg-accent/[0.03] px-4 py-5">
              <div className="flex items-center gap-3 mb-3">
                {oracleWaitPhase === "ready" ? (
                  <div className="w-5 h-5 rounded-full bg-profit/20 flex items-center justify-center">
                    <svg className="w-3 h-3 text-profit" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                ) : (
                  <div className="w-5 h-5 border-2 border-accent/50 border-t-accent rounded-full animate-spin" />
                )}
                <span className="font-mono text-sm text-white">
                  {oracleWaitPhase === "initializing" && "Initializing oracle..."}
                  {oracleWaitPhase === "waiting" && "Waiting for price feed..."}
                  {oracleWaitPhase === "ready" && "Price feed active!"}
                </span>
              </div>
              <p className="text-xs text-text-secondary font-sans mb-3">
                {oracleWaitPhase === "initializing" && "Creating the oracle account on-chain. Please approve the transaction in your wallet."}
                {oracleWaitPhase === "waiting" && "The cranker is picking up your new oracle and feeding the first price. This usually takes 30–60 seconds."}
                {oracleWaitPhase === "ready" && "Creating your market now..."}
              </p>
              {oracleWaitPhase === "waiting" && (
                <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent/60 rounded-full transition-all duration-[4500ms] ease-linear"
                    style={{ width: `${oracleWaitProgress}%` }}
                  />
                </div>
              )}
            </div>
          )}

          {oracleWaitPhase === "failed" && (
            <div className="border border-loss/20 rounded-[4px] bg-loss/[0.03] px-4 py-4">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-loss font-mono text-sm">Price feed timed out</span>
              </div>
              <p className="text-xs text-text-secondary font-sans mb-3">
                The cranker hasn&apos;t fed a price yet. The oracle was created — try again in a minute and it should go through.
              </p>
              <button
                onClick={() => { setOracleWaitPhase(null); setIsSubmitting(false); }}
                className="font-mono text-xs px-4 py-2 rounded-[2px] border border-border text-text-secondary hover:text-white hover:bg-white/5 transition-colors"
              >
                Try Again
              </button>
            </div>
          )}

          {/* Cost + Create button */}
          <div className="pt-2">
            {/* Unified Create Market flow — oracle auto-initialized if needed */}
            {selectedMint && !checkingOracle && !oracleWaitPhase && (
              <>
                <div className="flex items-center justify-between text-xs mb-3">
                  <span className="text-text-secondary font-sans">Cost</span>
                  <span className="font-mono text-text-secondary">
                    {oracleExists ? "~1 SOL + rent" : "~1 SOL + oracle rent"}
                  </span>
                </div>
                {oracleExists === false && (
                  <div className="border border-blue-500/20 rounded-[4px] bg-blue-500/[0.04] px-3 py-2.5 mb-3">
                    <p className="text-xs text-blue-400/90 font-sans">
                      No oracle exists for this token yet. One will be created automatically — the cranker starts feeding prices within ~60 seconds.
                    </p>
                  </div>
                )}
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
              </>
            )}

            {/* No token selected yet */}
            {!selectedMint && (
              <button
                disabled
                className="w-full py-2.5 text-sm font-sans font-medium rounded-[4px] border border-zinc-800 text-zinc-600 cursor-not-allowed transition-colors duration-100"
              >
                Select a Token
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
