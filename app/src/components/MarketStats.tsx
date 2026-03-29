"use client";

import React, { memo } from "react";
import { Market } from "@/types";
import { formatUsd, formatUsdCompact, formatFunding } from "@/lib/format";

interface MarketStatsProps {
  market: Market;
}

export const MarketStats = memo(function MarketStats({ market }: MarketStatsProps) {
  return (
    <div className="flex items-center gap-3 md:gap-6 px-4 py-2 border-b border-border bg-surface text-xs flex-shrink-0">
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="font-sans font-semibold text-white text-sm">
          {market.symbol}-PERP
        </span>
      </div>
      <Stat label="Mark" value={formatUsd(market.markPrice)} />
      <span className="hidden sm:contents">
        <Stat label="Index" value={formatUsd(market.indexPrice)} />
      </span>
      <Stat
        label="Funding"
        value={formatFunding(market.fundingRate)}
        color={market.fundingRate >= 0 ? "text-profit" : "text-loss"}
      />
      <span className="hidden sm:contents">
        <Stat label="OI" value={formatUsdCompact(market.openInterest)} />
      </span>
      <Stat label="24h Vol" value={formatUsdCompact(market.volume24h)} />
      <span className="hidden md:contents">
        <Stat label="Vault" value={formatUsdCompact(market.vaultBalance)} />
      </span>
    </div>
  );
});

function Stat({
  label,
  value,
  color = "text-white",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-text-secondary font-sans">{label}</span>
      <span className={`font-mono ${color}`}>{value}</span>
    </div>
  );
}
