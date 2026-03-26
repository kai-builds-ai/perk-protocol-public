"use client";

import React from "react";
import { useParams } from "next/navigation";
import { TopBar } from "@/components/TopBar";
import { MarketStats } from "@/components/MarketStats";
import { Chart } from "@/components/Chart";
import { TradePanel } from "@/components/TradePanel";
import { DepositWithdraw } from "@/components/DepositWithdraw";
import { Positions } from "@/components/Positions";
import { TriggerOrders } from "@/components/TriggerOrders";
import { useMarket } from "@/hooks/useMarkets";
import { usePositionsForMarket } from "@/hooks/usePosition";
import { usePythPrice } from "@/hooks/usePythPrice";
import { usePythCandles } from "@/hooks/usePythCandles";

export default function TradingView() {
  const params = useParams();
  const marketKey = params.market as string;
  const { market } = useMarket(marketKey);
  const symbol = market?.symbol ?? "";
  const marketAddress = market?.address ?? null;
  const { positions, triggerOrders } = usePositionsForMarket(marketAddress);
  const { price: livePrice, connected } = usePythPrice(
    symbol,
    market?.markPrice
  );
  const { candles, isReal } = usePythCandles(symbol, "60", 200);

  if (!market) {
    return (
      <div className="flex flex-col h-screen">
        <TopBar />
        <div className="flex-1 flex items-center justify-center text-text-secondary font-sans text-sm">
          Market not found: {marketKey}
        </div>
      </div>
    );
  }

  // Override market price with live Pyth price
  const displayMarket = {
    ...market,
    markPrice: livePrice || market.markPrice,
    indexPrice: livePrice || market.indexPrice,
  };

  return (
    <div className="flex flex-col h-screen">
      <TopBar solPrice={symbol === "SOL" ? displayMarket.markPrice : undefined} />
      <div className="flex items-center gap-2 px-4 overflow-x-auto flex-nowrap" style={{ WebkitOverflowScrolling: "touch" }}>
        <MarketStats market={displayMarket} />
        {connected && (
          <span className="text-xs font-mono text-profit ml-2 flex-shrink-0">● LIVE</span>
        )}
        {isReal && (
          <span className="text-xs font-mono text-text-tertiary flex-shrink-0">PYTH</span>
        )}
      </div>
      {/* Desktop: side-by-side. Mobile: stacked single column */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 overflow-auto no-scrollbar">
        {/* Left: Chart + Positions (desktop) */}
        <div className="flex flex-col md:flex-1 md:border-r border-border min-w-0">
          <div className="h-[200px] md:h-auto md:flex-1 md:min-h-[300px]">
            <Chart data={candles} symbol={symbol} />
          </div>
          {/* Positions + Orders — below chart on desktop, below everything on mobile */}
          <div className="hidden md:block border-t border-border overflow-auto max-h-[240px]">
            <Positions positions={positions} market={displayMarket} />
            <TriggerOrders orders={triggerOrders} market={displayMarket} />
          </div>
        </div>
        {/* Right: Trade Panel */}
        <div className="w-full md:w-[320px] flex flex-col md:border-l border-border bg-surface">
          <TradePanel market={displayMarket} />
          <DepositWithdraw market={displayMarket} />
        </div>
        {/* Positions + Orders — mobile only, below trade panel */}
        <div className="md:hidden border-t border-border">
          <Positions positions={positions} market={displayMarket} />
          <TriggerOrders orders={triggerOrders} market={displayMarket} />
        </div>
      </div>
    </div>
  );
}
