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
import { getTokenLogo } from "@/lib/token-metadata";
import toast from "react-hot-toast";
import { sanitizeError } from "@/lib/error-utils";

/** Mainnet Pyth price feed accounts (Solana on-chain accounts) for major tokens.
 *  Source: https://pyth.network/developers/price-feed-ids#solana-mainnet */
const PYTH_FEEDS: Record<string, PublicKey> = {
  // SOL/USD
  "So11111111111111111111111111111111111111112": new PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"),
  // BTC/USD (wBTC Portal)
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": new PublicKey("GVXRSBjFk6e6J3NbVPXohDJwcHs1RkWXCMyd4H5hDEZr"),
  // ETH/USD (wETH Portal)
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": new PublicKey("JBu1AL4obBcCMqKBBxhpWCNUt136ijcuMZLFvTP7iWdB"),
  // BONK/USD
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": new PublicKey("8ihFLu5FimgTQ1Unh4dVyEHUGodJ5gJQCR9B6Kz5VVaS"),
  // JTO/USD
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": new PublicKey("D8UUgr8a3aR3yUeHLu7v8FWK7E8Y5sSU7qrBQUkKwtKM"),
  // JUP/USD
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": new PublicKey("g6eRCbboSwK4tSWngn773RCMexr1APQr4uA9bGZBYfo"),
  // WIF/USD
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": new PublicKey("6ABgrEZk8urs6kJ1JNdC1sspH5zKXRqxy8sg3ZG2cQps"),
  // RNDR/USD (Render)
  "rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof": new PublicKey("AnLf8tVYCM816gmBjiy8n53eXKKEDydT5piYjjQDPgTB"),
  // PYTH/USD
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3": new PublicKey("nrYkQQQur7z8rYTST3G9GqATviK5SZTKz5a3GKaVqjE"),
  // RAY/USD (Raydium)
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": new PublicKey("AnLf8tVYCM816gmBjiy8n53eXKKEDydT5piYjjQDPgTB"),
  // ORCA/USD
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE": new PublicKey("4ivThkX8uRxBpHsdWSqyXYihzKF3zpRGAUCqyuagnLoV"),
  // USDC (stablecoin — useful for pairs)
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": new PublicKey("Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD"),
  // USDT
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": new PublicKey("3vxLXJqLqF3JG5TCbYycbKWRBbCJQLxQmBGCkyqEEefL"),
};

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

  const { client, readonlyClient } = usePerk();
  const { publicKey } = useWallet();
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
          const logoUrl = await getTokenLogo(value, connection);
          setCustomMint({
            mint: value,
            symbol: value.slice(0, 4) + "...",
            name: "Custom Token",
            logoUrl,
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

  const selectedMint = selectedToken?.mint ?? customMint?.mint ?? null;

  const handleCreate = useCallback(async () => {
    if (!selectedMint) return;

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(selectedMint);

      // Determine oracle source: Pyth for major tokens, PerkOracle for everything else
      let oracle: PublicKey;
      let oracleSource: SdkOracleSource;
      const pythFeed = PYTH_FEEDS[selectedMint];

      if (pythFeed) {
        // Major token with Pyth feed
        oracle = pythFeed;
        oracleSource = SdkOracleSource.Pyth;
      } else {
        // Low-cap token — use PerkOracle
        const existing = await readonlyClient.fetchPerkOracleNullable(tokenMint);
        if (!existing) {
          toast.error(
            "No PerkOracle exists for this token yet. The cranker will initialize one automatically when price feeds are available."
          );
          setIsSubmitting(false);
          return;
        }
        oracle = readonlyClient.getPerkOracleAddress(tokenMint);
        oracleSource = SdkOracleSource.PerkOracle;
      }

      const tradingFeeBps = Math.round(tradingFee * 100); // 0.10% → 10 bps
      const maxLeverageScaled = maxLeverage * LEVERAGE_SCALE;

      const sig = await client.createMarket(tokenMint, oracle, {
        oracleSource,
        maxLeverage: maxLeverageScaled,
        tradingFeeBps,
        initialK,
      });

      toast.success("Market created!\nTX: " + sig.slice(0, 16) + "...");

      // Redirect to the new market's trade page using PDA address
      const marketAddress = client.getMarketAddress(tokenMint, publicKey);
      router.push(`/trade/${marketAddress.toBase58()}`);
    } catch (err: unknown) {
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
    sdkOracleSource,
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
                <TokenLogo mint={selectedToken.mint} size={20} />
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
                <span className="font-sans text-white">{customMint.symbol}</span>
                <span className="text-text-secondary">({customMint.name})</span>
                <span className="text-text-tertiary font-mono truncate max-w-[200px]">
                  {customMint.mint}
                </span>
              </div>
            )}
          </div>

          {/* Oracle — always PerkOracle, cranker handles feed selection */}

          {/* Parameters */}
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
              <input
                type="range"
                min={2}
                max={20}
                step={1}
                value={maxLeverage}
                onChange={(e) => setMaxLeverage(parseInt(e.target.value))}
                className="w-full h-1.5 appearance-none cursor-pointer rounded-full bg-zinc-800 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-900 [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(255,255,255,0.15)] [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-900 [&::-moz-range-thumb]:cursor-pointer"
              />
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
              <input
                type="range"
                min={3}
                max={100}
                step={1}
                value={tradingFee * 100}
                onChange={(e) =>
                  setTradingFee(parseInt(e.target.value) / 100)
                }
                className="w-full h-1.5 appearance-none cursor-pointer rounded-full bg-zinc-800 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-zinc-900 [&::-webkit-slider-thumb]:shadow-[0_0_0_2px_rgba(255,255,255,0.15)] [&::-webkit-slider-thumb]:cursor-pointer [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-zinc-900 [&::-moz-range-thumb]:cursor-pointer"
              />
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
