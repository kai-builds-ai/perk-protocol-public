"use client";

import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { Market, OrderTab, Side } from "@/types";
import { LeverageSlider } from "./LeverageSlider";
import { formatUsd } from "@/lib/format";
import { usePerk } from "@/providers/PerkProvider";
import toast from "react-hot-toast";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  Side as SdkSide,
  TriggerOrderType as SdkTriggerOrderType,
  LEVERAGE_SCALE,
  POS_SCALE,
  PRICE_SCALE,
} from "@perk/sdk";
import { sanitizeError } from "@/lib/error-utils";
import { getTokenSymbol } from "@/lib/token-meta";

interface TradePanelProps {
  market: Market;
  hasOpenPosition?: boolean;
}

const MAX_SLIPPAGE_BPS = 300; // 3% — vAMM with low liquidity needs higher tolerance

export function TradePanel({ market, hasOpenPosition: hasOpenPositionProp }: TradePanelProps) {
  const [tab, setTab] = useState<OrderTab>("market");
  const [side, setSide] = useState<Side>(Side.Long);
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [triggerPrice, setTriggerPrice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false); // M-01 fix: synchronous lock for double-click

  const { client } = usePerk();
  const { publicKey } = useWallet();

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === "b" || e.key === "B") setSide(Side.Long);
      if (e.key === "s" || e.key === "S") setSide(Side.Short);
      if (e.key === "Escape") {
        setSize("");
        setTriggerPrice("");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sizeNum = parseFloat(size) || 0;

  // Size = collateral (USDC). Notional = Size × Leverage (USDC).
  // positionSize is in USDC notional terms.
  const positionSize = sizeNum * leverage;

  const estimates = useMemo(() => {
    if (!sizeNum) return null;
    const entryPrice =
      tab === "limit" || tab === "stop"
        ? parseFloat(triggerPrice) || market.markPrice
        : market.markPrice;
    const notional = positionSize; // already in USDC (collateral × leverage)
    const fee = notional * (market.tradingFeeBps / 10000);
    const margin = sizeNum; // collateral in USDC
    const liqDistance = margin * 0.95;
    const tokenCount = positionSize / entryPrice; // token units for liq price calc
    const liqPrice =
      side === Side.Long
        ? entryPrice - liqDistance / tokenCount
        : entryPrice + liqDistance / tokenCount;
    // M-04 fix: estimate slippage from vAMM constant product (x*y=k)
    const slippagePct = market.baseReserve > 0
      ? Math.abs(tokenCount) / market.baseReserve
      : 0;
    return { entryPrice, fee, liqPrice: Math.max(0, liqPrice), slippage: slippagePct };
  }, [sizeNum, positionSize, market, leverage, side, tab, triggerPrice]);

  const isLong = side === Side.Long;

  const handleSubmit = useCallback(async () => {
    // M-01 fix: synchronous lock prevents double-submit
    if (submitLockRef.current) return;
    // H-02/H-03 fix: client-side validation (reject NaN, Infinity, zero, negative)
    if (!Number.isFinite(sizeNum) || sizeNum <= 0) return;
    if (!market.active) {
      toast.error("This market is currently inactive.");
      return;
    }
    if (leverage > market.maxLeverage) {
      toast.error(`Max leverage for this market is ${market.maxLeverage}x.`);
      return;
    }

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(market.tokenMint);
      const oracle = new PublicKey(market.oracleAddress);
      const sdkSide = side === Side.Long ? SdkSide.Long : SdkSide.Short;
      const creator = new PublicKey(market.creator);

      // Wallet balance check happens after free collateral check (inside market tab block)

      if (tab === "market") {
        // Ensure position account exists
        const marketAddr = client.getMarketAddress(tokenMint, creator);
        try {
          await client.fetchPosition(marketAddr, publicKey);
        } catch {
          // Position doesn't exist — initialize it
          toast("Initializing position account...", { icon: "⏳" });
          await client.initializePosition(tokenMint, creator);
        }

        // Auto-deposit: only deposit what's needed beyond free collateral
        const decimals = 6; // USDC/USDT/PYUSD all 6 decimals
        const markPrice = market.markPrice || 1;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conn = (client as any).program.provider.connection as import("@solana/web3.js").Connection;
        const { getAssociatedTokenAddress } = await import("@solana/spl-token");
        const colMint = new PublicKey(market.collateralMint);
        const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const userAta = await getAssociatedTokenAddress(colMint, publicKey, false, tokenProgramId);

        // Step 1: Determine how much to deposit from wallet
        // - Existing position (adding): ALWAYS deposit size from wallet to maintain leverage
        // - No position: use free vault collateral, deposit only difference
        // Use React state prop (not stale RPC fetch) to determine if position exists
        let freeCollateral = 0;
        if (!hasOpenPositionProp) {
          try {
            const pos = await client.fetchPosition(marketAddr, publicKey);
            if (pos.baseSize.toNumber() === 0) {
              freeCollateral = pos.depositedCollateral.toNumber() / 10 ** decimals;
            }
          } catch {
            // No position account yet
          }
        }

        const needed = hasOpenPositionProp ? sizeNum : Math.max(0, sizeNum - freeCollateral);
        if (needed > 0) {
          // Check wallet balance
          try {
            const ataInfo = await conn.getTokenAccountBalance(userAta);
            const walletBalance = parseFloat(ataInfo.value.uiAmountString ?? "0");
            if (walletBalance < needed) {
              if (hasPosition) {
                toast.error(`Insufficient wallet balance. Have ${walletBalance.toFixed(2)} ${getTokenSymbol(market.collateralMint)}, need ${sizeNum.toFixed(2)}.`);
              } else {
                toast.error(`Insufficient funds. Need ${sizeNum.toFixed(2)} (wallet: ${walletBalance.toFixed(2)}, vault: ${freeCollateral.toFixed(2)}).`);
              }
              submitLockRef.current = false;
              setIsSubmitting(false);
              return;
            }
          } catch {
            toast.error(`No ${getTokenSymbol(market.collateralMint)} in wallet.`);
            submitLockRef.current = false;
            setIsSubmitting(false);
            return;
          }

          const depositAmount = new BN(Math.floor(needed * 10 ** decimals));
          toast(`Depositing ${needed.toFixed(2)} ${getTokenSymbol(market.collateralMint)}...`, { icon: "⏳" });
          await client.deposit(tokenMint, creator, oracle, depositAmount);
        } else {
          toast("Using vault collateral", { icon: "✓" });
        }

        // Step 2: Open position
        const tokenCount = positionSize / markPrice;
        const baseSize = new BN(Math.floor(tokenCount * POS_SCALE));
        const leverageScaled = Math.floor(leverage * LEVERAGE_SCALE);

        toast("Opening position...", { icon: "⏳" });
        let sig: string;
        try {
          sig = await client.openPosition(
            tokenMint, creator, oracle, sdkSide, baseSize, leverageScaled, MAX_SLIPPAGE_BPS,
          );
        } catch (openErr: unknown) {
          // Open failed but deposit already went through — warn user
          console.error("[trade] openPosition failed after deposit:", openErr);
          toast.error(`Position failed to open. Your ${needed > 0 ? needed.toFixed(2) : sizeNum.toFixed(2)} ${getTokenSymbol(market.collateralMint)} deposit is in your vault — withdraw it or try again.`);
          throw openErr; // re-throw to hit the outer catch
        }

        // Excess auto-withdrawal REMOVED — caused 3 incidents where stale RPC data
        // led to incorrect withdrawals that nearly liquidated positions.
        // Users can manually withdraw excess via the Withdraw button.

        toast.success("Position opened!\nTX: " + sig.slice(0, 16) + "...");
        setSize("");
      } else {
        // Limit or Stop/TP trigger order
        const price = parseFloat(triggerPrice);
        if (!price) {
          toast.error("Enter a trigger price.");
          submitLockRef.current = false;
          setIsSubmitting(false);
          return;
        }

        // Determine order type
        let orderType: SdkTriggerOrderType;
        let reduceOnly = false;

        if (tab === "limit") {
          orderType = SdkTriggerOrderType.Limit;
        } else {
          // Stop/TP tab — determine type from trigger price vs mark price
          const isBelowMark = price < market.markPrice;
          if (side === Side.Long) {
            // Long: trigger below mark = StopLoss, above = TakeProfit
            orderType = isBelowMark
              ? SdkTriggerOrderType.StopLoss
              : SdkTriggerOrderType.TakeProfit;
          } else {
            // Short: trigger above mark = StopLoss, below = TakeProfit
            orderType = isBelowMark
              ? SdkTriggerOrderType.TakeProfit
              : SdkTriggerOrderType.StopLoss;
          }
          reduceOnly = true;
        }

        // Ensure position account exists for trigger orders
        const marketAddr = client.getMarketAddress(tokenMint, creator);
        try {
          await client.fetchPosition(marketAddr, publicKey);
        } catch {
          await client.initializePosition(tokenMint, creator);
        }

        const triggerTokenCount = positionSize / (parseFloat(triggerPrice) || market.markPrice);
        const sig = await client.placeTriggerOrder(tokenMint, creator, {
          orderType,
          side: sdkSide,
          size: new BN(Math.floor(triggerTokenCount * POS_SCALE)),
          triggerPrice: new BN(Math.floor(price * PRICE_SCALE)),
          leverage: Math.floor(leverage * LEVERAGE_SCALE),
          reduceOnly,
          expiry: new BN(0), // no expiry
        });
        toast.success("Order placed!\nTX: " + sig.slice(0, 16) + "...");
        setSize("");
        setTriggerPrice("");
      }
    } catch (err: unknown) {
      console.error("[trade] FULL ERROR:", err);
      try { console.error("[trade] JSON:", JSON.stringify(err, Object.getOwnPropertyNames(err as object))); } catch { /* */ }
      toast.error(sanitizeError(err, "trade"));
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [client, publicKey, sizeNum, positionSize, side, leverage, tab, triggerPrice, market]);

  const tabs: OrderTab[] = ["market", "limit", "stop"];

  return (
    <div className="flex flex-col h-full">
      {/* Tabs */}
      <div className="flex border-b border-border">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-3 text-sm font-sans uppercase tracking-wide transition-colors duration-100 ${
              tab === t
                ? "text-white border-b-2 border-white"
                : "text-text-secondary hover:text-white border-b-2 border-transparent"
            }`}
          >
            {t === "stop" ? "Stop/TP" : t}
          </button>
        ))}
      </div>

      <div className="p-4 space-y-4 flex-1">
        {/* Side toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => setSide(Side.Long)}
            className={`flex-1 py-2.5 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
              isLong
                ? "bg-profit/10 border-profit/50 text-profit"
                : "bg-transparent border-zinc-700 text-text-secondary hover:text-white"
            }`}
          >
            LONG
          </button>
          <button
            onClick={() => setSide(Side.Short)}
            className={`flex-1 py-2.5 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
              !isLong
                ? "bg-loss/10 border-loss/50 text-loss"
                : "bg-transparent border-zinc-700 text-text-secondary hover:text-white"
            }`}
          >
            SHORT
          </button>
        </div>

        {/* Size input */}
        <div>
          <label className="text-sm font-sans text-text-secondary block mb-1.5">
            Size (collateral)
          </label>
          <div className="flex items-center border border-zinc-700 rounded-[4px] focus-within:border-zinc-400 transition-colors duration-100">
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="0.00"
              disabled={isSubmitting}
              className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary disabled:opacity-50"
            />
            <span className="pr-3 text-sm font-sans text-text-secondary">
              {getTokenSymbol(market.collateralMint)}
            </span>
          </div>
        </div>

        {/* Trigger price (limit/stop only) */}
        {tab !== "market" && (
          <div>
            <label className="text-sm font-sans text-text-secondary block mb-1.5">
              {tab === "limit" ? "Limit Price" : "Trigger Price"}
            </label>
            <div className="flex items-center border border-zinc-700 rounded-[4px] focus-within:border-zinc-400 transition-colors duration-100">
              <input
                type="number"
                value={triggerPrice}
                onChange={(e) => setTriggerPrice(e.target.value)}
                placeholder={market.markPrice.toString()}
                disabled={isSubmitting}
                className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary disabled:opacity-50"
              />
              <span className="pr-3 text-sm font-sans text-text-secondary">
                USD
              </span>
            </div>
          </div>
        )}

        {/* Leverage slider */}
        <LeverageSlider
          value={leverage}
          maxLeverage={market.maxLeverage}
          onChange={setLeverage}
        />

        {/* Estimates */}
        {estimates && (
          <div className="space-y-1.5 py-3 border-t border-border">
            <Row label="Collateral" value={`${sizeNum.toFixed(4)} ${getTokenSymbol(market.collateralMint)}`} />
            <Row label="Position" value={`${positionSize.toFixed(4)} ${getTokenSymbol(market.collateralMint)}`} />
            <Row label="Entry" value={formatUsd(estimates.entryPrice)} />
            <Row label="Liq Price" value={formatUsd(estimates.liqPrice)} />
            <Row label="Fee" value={formatUsd(estimates.fee)} />
            <Row
              label="Slippage"
              value={`~${(estimates.slippage * 100).toFixed(2)}%`}
            />
          </div>
        )}

        {/* Submit */}
        <button
          onClick={handleSubmit}
          disabled={!sizeNum || isSubmitting}
          className={`w-full py-3 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
            !sizeNum || isSubmitting
              ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
              : isLong
              ? "bg-profit/10 border-profit/50 text-profit hover:bg-profit/20"
              : "bg-loss/10 border-loss/50 text-loss hover:bg-loss/20"
          }`}
        >
          {isSubmitting
            ? "Submitting..."
            : isLong
            ? "Open Long"
            : "Open Short"}
        </button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary font-sans">{label}</span>
      <span className="font-mono text-white">{value}</span>
    </div>
  );
}
