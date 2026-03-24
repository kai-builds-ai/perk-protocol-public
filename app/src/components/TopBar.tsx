"use client";

import React from "react";
import Link from "next/link";
import { WalletButton } from "./WalletButton";
import { formatUsdCompact } from "@/lib/format";

interface TopBarProps {
  totalVolume?: number;
  totalMarkets?: number;
  solPrice?: number;
}

export function TopBar({
  totalVolume = 7100000,
  totalMarkets = 7,
  solPrice,
}: TopBarProps) {
  return (
    <div className="border-b border-border bg-surface">
    <div className="flex items-center justify-between h-12 px-6 max-w-7xl mx-auto">
      <div className="flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-[3px] overflow-hidden bg-bg flex-shrink-0"><img src="/logo.png" alt="Perk" width={32} height={32} className="mix-blend-lighten" /></div>
          <span className="font-sans font-semibold text-base text-white tracking-[0.2em]">PERK</span>
        </Link>
        {solPrice != null && (
          <span className="text-sm text-text-secondary font-sans">
            SOL{" "}
            <span className="text-white font-mono">
              ${solPrice.toFixed(2)}
            </span>
          </span>
        )}
        <span className="text-sm text-text-secondary font-sans">
          Vol{" "}
          <span className="text-white font-mono">
            {formatUsdCompact(totalVolume)}
          </span>
        </span>
        <span className="text-sm text-text-secondary font-sans">
          Markets{" "}
          <span className="text-white font-mono">{totalMarkets}</span>
        </span>
      </div>
      <div className="flex items-center gap-4">
        <Link
          href="/launch"
          className="text-sm font-sans font-medium border border-zinc-600 text-white px-4 py-1.5 rounded-[4px] hover:bg-white/10 hover:border-zinc-400 transition-colors duration-100"
        >
          + Create Market
        </Link>
        <WalletButton />
      </div>
    </div>
    </div>
  );
}
