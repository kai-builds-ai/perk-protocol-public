"use client";

import React, { memo, useState, useCallback, useRef } from "react";
import { UserPosition, Market, Side, TriggerOrder } from "@/types";
import { formatUsd, formatPct } from "@/lib/format";
import { usePerk } from "@/providers/PerkProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  Side as SdkSide,
  TriggerOrderType as SdkTriggerOrderType,
  POS_SCALE,
  PRICE_SCALE,
} from "@perk/sdk";
import toast from "react-hot-toast";
import { sanitizeError } from "@/lib/error-utils";

interface PositionsProps {
  positions: UserPosition[];
  market?: Market;
  livePrice?: number; // streaming price for real-time PNL
  triggerOrders?: TriggerOrder[];
}

export const Positions = memo(function Positions({ positions, market, livePrice, triggerOrders }: PositionsProps) {
  const { client } = usePerk();
  const { publicKey } = useWallet();
  const [closingIndex, setClosingIndex] = useState<number | null>(null);
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // TP/SL inline input state: { posIndex, type }
  const [tpslInput, setTpslInput] = useState<{ posIndex: number; type: "tp" | "sl" } | null>(null);
  const [tpslPrice, setTpslPrice] = useState("");
  const [tpslSubmitting, setTpslSubmitting] = useState(false);

  // Clear confirm state after 3s if user doesn't click again
  const startConfirmTimer = useCallback(() => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    confirmTimerRef.current = setTimeout(() => setConfirmIndex(null), 3000);
  }, []);

  const handleTpsl = useCallback(
    async (pos: UserPosition, type: "tp" | "sl") => {
      const price = parseFloat(tpslPrice);
      if (!price || price <= 0) {
        toast.error("Enter a valid price.");
        return;
      }
      if (!client || !publicKey) {
        toast.error("Connect wallet first.");
        return;
      }
      if (!pos.tokenMint || !pos.creator || !pos.oracleAddress) {
        toast.error("Position data incomplete.");
        return;
      }

      const isLong = pos.baseSize > 0;
      const markPrice = market?.markPrice || 0;

      // Validate TP/SL direction
      if (type === "tp") {
        if (isLong && price <= markPrice) {
          toast.error(`Take Profit must be above mark price (${formatUsd(markPrice)})`);
          return;
        }
        if (!isLong && price >= markPrice) {
          toast.error(`Take Profit must be below mark price (${formatUsd(markPrice)})`);
          return;
        }
      } else {
        if (isLong && price >= markPrice) {
          toast.error(`Stop Loss must be below mark price (${formatUsd(markPrice)})`);
          return;
        }
        if (!isLong && price <= markPrice) {
          toast.error(`Stop Loss must be above mark price (${formatUsd(markPrice)})`);
          return;
        }
      }

      setTpslSubmitting(true);
      try {
        const tokenMint = new PublicKey(pos.tokenMint);
        const creator = new PublicKey(pos.creator);
        const sdkSide = isLong ? SdkSide.Long : SdkSide.Short;
        const orderType = type === "tp" ? SdkTriggerOrderType.TakeProfit : SdkTriggerOrderType.StopLoss;
        const size = new BN(Math.floor(Math.abs(pos.baseSize) * POS_SCALE));

        const sig = await client.placeTriggerOrder(tokenMint, creator, {
          orderType,
          side: sdkSide,
          size,
          triggerPrice: new BN(Math.floor(price * PRICE_SCALE)),
          leverage: 0, // reduce-only, leverage doesn't matter
          reduceOnly: true,
          expiry: new BN(0),
        });

        toast.success(`${type === "tp" ? "Take Profit" : "Stop Loss"} set at ${formatUsd(price)}!\nTX: ${sig.slice(0, 16)}...`);
        setTpslInput(null);
        setTpslPrice("");
      } catch (err: unknown) {
        toast.error(sanitizeError(err, "place-tpsl"));
      } finally {
        setTpslSubmitting(false);
      }
    },
    [client, publicKey, tpslPrice, market]
  );

  const handleClose = useCallback(
    async (posIndex: number) => {
      // First click → "Confirm?" state
      if (confirmIndex !== posIndex) {
        setConfirmIndex(posIndex);
        startConfirmTimer();
        return;
      }
      // Second click → execute close
      setConfirmIndex(null);
      if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);

      if (!client || !publicKey) {
        toast.error("Please connect your wallet.");
        return;
      }

      const pos = positions[posIndex];
      if (!pos) return;

      if (!pos.tokenMint || !pos.creator || !pos.oracleAddress) {
        toast.error("Position data incomplete");
        return;
      }

      setClosingIndex(posIndex);
      try {
        // Use market data from the position itself, not the parent market prop.
        // This ensures we target the correct market even when positions
        // from multiple markets are displayed together.
        const tokenMint = new PublicKey(pos.tokenMint);
        const creator = new PublicKey(pos.creator);
        const oracle = new PublicKey(pos.oracleAddress);

        // Auto-cancel trigger orders for this market before closing
        const marketOrders = (triggerOrders ?? []).filter(o => o.market === pos.market);
        if (marketOrders.length > 0) {
          toast(`Cancelling ${marketOrders.length} trigger order${marketOrders.length > 1 ? "s" : ""}...`, { icon: "⏳" });
          for (const order of marketOrders) {
            try {
              await client.cancelTriggerOrder(tokenMint, creator, order.orderId);
            } catch (cancelErr) {
              console.warn("[close] Failed to cancel trigger order", order.orderId, cancelErr);
            }
          }
        }

        const sig = await client.closePosition(tokenMint, creator, oracle);
        toast.success("Position closed!\nTX: " + sig.slice(0, 16) + "...");
      } catch (err: unknown) {
        toast.error(sanitizeError(err, "close-position"));
      } finally {
        setClosingIndex(null);
      }
    },
    [client, publicKey, positions, confirmIndex, startConfirmTimer, triggerOrders]
  );

  if (positions.length === 0) {
    return (
      <div className="p-3 text-xs text-text-tertiary font-sans">
        No open positions
      </div>
    );
  }

  return (
    <div>
      <div className="px-3 py-2 text-xs font-sans font-medium text-text-secondary uppercase tracking-wider border-b border-border">
        Positions ({positions.length})
      </div>
      <div className="overflow-x-auto no-scrollbar" style={{ WebkitOverflowScrolling: "touch" }}>
      <table className="w-full text-xs min-w-[640px]">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-1.5 text-left text-[10px] font-sans uppercase text-text-secondary tracking-wider">Market</th>
            <th className="px-3 py-1.5 text-left text-[10px] font-sans uppercase text-text-secondary tracking-wider">Side</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Size</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Leverage</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Entry</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">PnL</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Liq Price</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Actions</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p, i) => {
            const isLong = p.baseSize > 0;
            // Real-time PNL: use current mark price (from poll or live stream)
            const currentPrice = livePrice && livePrice > 0 ? livePrice : (market?.markPrice || 0);
            // Hybrid PNL: on-chain settled PNL + estimated unrealized from price movement
            // On-chain PNL is the base (includes K-coefficient + funding settlement)
            // Price delta estimates additional unrealized PNL since last on-chain update
            const pricePnl = currentPrice > 0 && p.entryPrice > 0
              ? (currentPrice - p.entryPrice) * Math.abs(p.baseSize) * (isLong ? 1 : -1)
              : 0;
            // Use the larger magnitude between on-chain and price-based as a floor
            // On-chain PNL resets to settled value; price PNL tracks live movement
            const displayPnl = Math.abs(pricePnl) > Math.abs(p.pnl) ? pricePnl : p.pnl;
            const displayPnlPct = p.depositedCollateral > 0 ? (displayPnl / p.depositedCollateral) * 100 : p.pnlPercent;
            const pnlPositive = displayPnl >= 0;
            const isClosing = closingIndex === i;
            return (
              <tr key={`${p.authority}-${p.market}`} className="border-b border-border hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-sans text-white">{p.marketSymbol}-PERP</td>
                <td className={`px-3 py-2 font-sans font-medium ${isLong ? "text-profit" : "text-loss"}`}>
                  {isLong ? "LONG" : "SHORT"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-white">
                  {Math.abs(p.baseSize).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {p.leverage}x
                </td>
                <td className="px-3 py-2 text-right font-mono text-white">
                  {formatUsd(p.entryPrice)}
                </td>
                <td className={`px-3 py-2 text-right font-mono ${pnlPositive ? "text-profit" : "text-loss"}`}>
                  {pnlPositive ? "+" : ""}{formatUsd(displayPnl)}
                  <span className="ml-1 text-[10px]">
                    {formatPct(displayPnlPct / 100)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {formatUsd(p.liquidationPrice)}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => {
                        if (tpslInput?.posIndex === i && tpslInput.type === "tp") {
                          setTpslInput(null); setTpslPrice("");
                        } else {
                          setTpslInput({ posIndex: i, type: "tp" }); setTpslPrice("");
                        }
                      }}
                      className={`px-2 py-1 text-xs font-sans rounded-[4px] border transition-colors duration-100 ${
                        tpslInput?.posIndex === i && tpslInput.type === "tp"
                          ? "text-profit border-profit/50 bg-profit/10"
                          : "text-text-secondary border-zinc-700 hover:text-white hover:border-zinc-500"
                      }`}
                    >
                      TP
                    </button>
                    <button
                      onClick={() => {
                        if (tpslInput?.posIndex === i && tpslInput.type === "sl") {
                          setTpslInput(null); setTpslPrice("");
                        } else {
                          setTpslInput({ posIndex: i, type: "sl" }); setTpslPrice("");
                        }
                      }}
                      className={`px-2 py-1 text-xs font-sans rounded-[4px] border transition-colors duration-100 ${
                        tpslInput?.posIndex === i && tpslInput.type === "sl"
                          ? "text-loss border-loss/50 bg-loss/10"
                          : "text-text-secondary border-zinc-700 hover:text-white hover:border-zinc-500"
                      }`}
                    >
                      SL
                    </button>
                    <button
                      onClick={() => handleClose(i)}
                      disabled={isClosing}
                      className={`px-2 py-1 text-xs font-sans rounded-[4px] border transition-colors duration-100 ${
                        isClosing
                          ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
                          : confirmIndex === i
                            ? "text-yellow-400 border-yellow-400/50 bg-yellow-400/10"
                            : "text-loss/80 border-loss/30 hover:text-loss hover:border-loss/50"
                      }`}
                    >
                      {isClosing ? "..." : confirmIndex === i ? "Confirm?" : "Close"}
                    </button>
                  </div>
                  {/* Inline TP/SL price input */}
                  {tpslInput?.posIndex === i && (
                    <div className="flex items-center gap-1.5 mt-2 justify-end">
                      <input
                        type="number"
                        value={tpslPrice}
                        onChange={(e) => setTpslPrice(e.target.value)}
                        placeholder={tpslInput.type === "tp"
                          ? (isLong ? "Above mark..." : "Below mark...")
                          : (isLong ? "Below mark..." : "Above mark...")}
                        autoFocus
                        className="w-24 bg-transparent border border-zinc-700 rounded-[4px] px-2 py-1 text-xs font-mono text-white outline-none focus:border-zinc-400 placeholder:text-text-tertiary"
                      />
                      <button
                        onClick={() => handleTpsl(p, tpslInput.type)}
                        disabled={tpslSubmitting}
                        className={`px-2 py-1 text-xs font-sans rounded-[4px] border transition-colors duration-100 ${
                          tpslSubmitting
                            ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
                            : tpslInput.type === "tp"
                              ? "text-profit border-profit/50 hover:bg-profit/10"
                              : "text-loss border-loss/50 hover:bg-loss/10"
                        }`}
                      >
                        {tpslSubmitting ? "..." : "Set"}
                      </button>
                      <button
                        onClick={() => { setTpslInput(null); setTpslPrice(""); }}
                        className="px-1.5 py-1 text-xs font-sans text-text-tertiary hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </div>
  );
});
