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
import {
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { useRouter } from "next/navigation";
import { getTokenLogo, getTokenInfo } from "@/lib/token-metadata";
import toast from "react-hot-toast";
import { sanitizeError } from "@/lib/error-utils";

// NOTE: Pyth Pull Oracle integration deferred to v2 (requires program upgrade
// to accept oracle accounts as instruction parameters per-transaction).
// All tokens use PerkOracle for now — cranker maintains prices from Jupiter+Birdeye.

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
  const [requestingMarket, setRequestingMarket] = useState(false);

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
    readonlyClient
      .fetchPerkOracleNullable(new PublicKey(selectedMintForOracle))
      .then((oracle) => {
        if (!cancelled) setOracleExists(oracle !== null);
      })
      .catch(() => {
        if (!cancelled) setOracleExists(false);
      })
      .finally(() => {
        if (!cancelled) setCheckingOracle(false);
      });
    return () => { cancelled = true; };
  }, [selectedMintForOracle, readonlyClient]);

  // Protocol PDA for request market payment
  const PROGRAM_ID = useMemo(
    () => new PublicKey("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2"),
    [],
  );
  const protocolPDA = useMemo(
    () => PublicKey.findProgramAddressSync([Buffer.from("protocol")], PROGRAM_ID)[0],
    [PROGRAM_ID],
  );

  const handleRequestMarket = useCallback(async () => {
    if (!selectedMintForOracle || !publicKey) {
      toast.error("Please connect your wallet and select a token.");
      return;
    }

    setRequestingMarket(true);
    try {
      // Build 0.01 SOL transfer to protocol PDA
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: protocolPDA,
          lamports: 10_000_000, // 0.01 SOL
        }),
      );

      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = publicKey;

      const sig = await sendTransaction(tx, connection);

      // Wait for confirmation
      await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      // POST to request-market API
      const tokenInfo = selectedToken ?? customMint;
      const res = await fetch("/api/request-market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mint: selectedMintForOracle,
          txSignature: sig,
          requester: publicKey.toBase58(),
          symbol: tokenInfo?.symbol,
          name: tokenInfo?.name,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      toast.success("Market requested! The team will review and initialize it.");
    } catch (err: unknown) {
      console.error("[request-market] error:", err);
      toast.error(sanitizeError(err, "request-market"));
    } finally {
      setRequestingMarket(false);
    }
  }, [
    selectedMintForOracle,
    publicKey,
    protocolPDA,
    connection,
    sendTransaction,
    selectedToken,
    customMint,
  ]);

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
  const initialK = MIN_INITIAL_K.mul(new BN(10));

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

      // Oracle existence already verified in UI — only show Create Market when oracle exists
      const oracle = readonlyClient.getPerkOracleAddress(tokenMint);
      const oracleSource = SdkOracleSource.PerkOracle;

      const tradingFeeBps = Math.round(tradingFee * 100); // 0.10% → 10 bps
      const maxLeverageScaled = maxLeverage * LEVERAGE_SCALE;

      const sig = await client.createMarket(tokenMint, oracle, {
        oracleSource,
        maxLeverage: maxLeverageScaled,
        tradingFeeBps,
        initialK,
      });

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
    }
  }, [
    client,
    publicKey,
    selectedMint,
    tradingFee,
    maxLeverage,
    initialK,
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

          {/* Parameters + Revenue — only shown when oracle exists (Create Market flow) */}
          {oracleExists !== false && (<>
          <div className="border-t border-border pt-4 space-y-5">
            <div className="text-xs font-sans text-text-secondary uppercase tracking-wider mb-3">
              Parameters
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

          {/* Cost + Create/Request button */}
          <div className="pt-2">
            {/* Show oracle check status */}
            {selectedMint && checkingOracle && (
              <div className="text-xs text-text-tertiary font-sans mb-3 animate-pulse">
                Checking oracle availability...
              </div>
            )}

            {/* Oracle exists → normal Create Market flow */}
            {selectedMint && oracleExists === true && !checkingOracle && (
              <>
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
              </>
            )}

            {/* Oracle doesn't exist → Request Market flow */}
            {selectedMint && oracleExists === false && !checkingOracle && (
              <>
                <div className="border border-yellow-500/20 rounded-[4px] bg-yellow-500/[0.04] px-3 py-2.5 mb-3">
                  <p className="text-xs text-yellow-400/90 font-sans">
                    No oracle exists for this token yet. You can request the team to add it by paying a small fee (0.01 SOL).
                  </p>
                </div>
                <div className="flex items-center justify-between text-xs mb-3">
                  <span className="text-text-secondary font-sans">Request Fee</span>
                  <span className="font-mono text-text-secondary">0.01 SOL</span>
                </div>
                <button
                  onClick={handleRequestMarket}
                  disabled={requestingMarket || !publicKey}
                  className={`w-full py-2.5 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
                    requestingMarket || !publicKey
                      ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
                      : "border-yellow-500/60 text-yellow-400 hover:bg-yellow-500/10"
                  }`}
                >
                  {requestingMarket
                    ? "Requesting..."
                    : !publicKey
                      ? "Connect Wallet to Request"
                      : "Request Market (0.01 SOL)"}
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
