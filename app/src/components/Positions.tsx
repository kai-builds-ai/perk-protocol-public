"use client";

import React, { memo, useState, useCallback } from "react";
import { UserPosition, Market } from "@/types";
import { formatUsd, formatPct } from "@/lib/format";
import { usePerk } from "@/providers/PerkProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import toast from "react-hot-toast";
import { sanitizeError } from "@/lib/error-utils";

interface PositionsProps {
  positions: UserPosition[];
  market?: Market;
}

export const Positions = memo(function Positions({ positions, market }: PositionsProps) {
  const { client } = usePerk();
  const { publicKey } = useWallet();
  const [closingIndex, setClosingIndex] = useState<number | null>(null);

  const handleClose = useCallback(
    async (posIndex: number) => {
      if (!client || !publicKey) {
        toast.error("Please connect your wallet.");
        return;
      }

      const pos = positions[posIndex];
      if (!pos) return;

      const confirmed = window.confirm(
        "Are you sure you want to close this position? This will close the entire position."
      );
      if (!confirmed) return;

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
        const sig = await client.closePosition(tokenMint, creator, oracle);
        toast.success("Position closed!\nTX: " + sig.slice(0, 16) + "...");
      } catch (err: unknown) {
        toast.error(sanitizeError(err, "close-position"));
      } finally {
        setClosingIndex(null);
      }
    },
    [client, publicKey, positions]
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
            const pnlPositive = p.pnl >= 0;
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
                  {pnlPositive ? "+" : ""}{formatUsd(p.pnl)}
                  <span className="ml-1 text-[10px]">
                    {formatPct(p.pnlPercent / 100)}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {formatUsd(p.liquidationPrice)}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex items-center justify-end gap-1.5">
                    <button
                      onClick={() => toast("Use the STOP/TP tab above to set a Take Profit.", { icon: "💰" })}
                      className="px-2 py-1 text-xs font-sans text-text-secondary border border-zinc-700 rounded-[4px] hover:text-white hover:border-zinc-500 transition-colors duration-100"
                    >
                      TP
                    </button>
                    <button
                      onClick={() => toast("Use the STOP/TP tab above to set a Stop Loss.", { icon: "🛡️" })}
                      className="px-2 py-1 text-xs font-sans text-text-secondary border border-zinc-700 rounded-[4px] hover:text-white hover:border-zinc-500 transition-colors duration-100"
                    >
                      SL
                    </button>
                    <button
                      onClick={() => handleClose(i)}
                      disabled={isClosing}
                      className={`px-2 py-1 text-xs font-sans rounded-[4px] border transition-colors duration-100 ${
                        isClosing
                          ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
                          : "text-loss/80 border-loss/30 hover:text-loss hover:border-loss/50"
                      }`}
                    >
                      {isClosing ? "..." : "Close"}
                    </button>
                  </div>
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
