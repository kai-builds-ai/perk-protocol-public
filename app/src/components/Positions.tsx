"use client";

import React, { memo } from "react";
import { UserPosition } from "@/types";
import { formatUsd, formatPct } from "@/lib/format";

interface PositionsProps {
  positions: UserPosition[];
}

export const Positions = memo(function Positions({ positions }: PositionsProps) {
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
      <table className="w-full text-xs">
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
            return (
              <tr key={i} className="border-b border-border hover:bg-white/[0.02]">
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
                  <div className="flex items-center justify-end gap-1">
                    <button className="px-1.5 py-0.5 text-[10px] font-sans text-text-secondary border border-zinc-800 rounded-[4px] hover:text-white hover:border-zinc-600 transition-colors duration-100">
                      TP
                    </button>
                    <button className="px-1.5 py-0.5 text-[10px] font-sans text-text-secondary border border-zinc-800 rounded-[4px] hover:text-white hover:border-zinc-600 transition-colors duration-100">
                      SL
                    </button>
                    <button className="px-1.5 py-0.5 text-[10px] font-sans text-loss/80 border border-loss/30 rounded-[4px] hover:text-loss hover:border-loss/50 transition-colors duration-100">
                      Close
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
