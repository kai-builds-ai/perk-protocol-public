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
  const token = (params.token as string).toUpperCase();
  const { market } = useMarket(token);
  const { positions, triggerOrders } = usePositionsForMarket(token);
  const { price: livePrice, connected } = usePythPrice(
    token,
    market?.markPrice
  );
  const { candles, isReal } = usePythCandles(token, "60", 200);

  if (!market) {
    return (
      <div className="flex flex-col h-screen">
        <TopBar />
        <div className="flex-1 flex items-center justify-center text-text-secondary font-sans text-sm">
          Market not found: {token}
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
      <TopBar solPrice={token === "SOL" ? displayMarket.markPrice : undefined} />
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
      <div className="flex flex-col md:flex-row flex-1 min-h-0">
        {/* Left: Chart */}
        <div className="flex-1 flex flex-col md:border-r border-border min-w-0">
          <div className="flex-1 min-h-0 min-h-[300px]">
            <Chart data={candles} symbol={token} />
          </div>
        </div>
        {/* Right: Trade Panel */}
        <div className="w-full md:w-[320px] flex flex-col md:border-l border-border bg-surface">
          <div className="flex-1 overflow-auto">
            <TradePanel market={displayMarket} />
          </div>
          <DepositWithdraw market={displayMarket} />
        </div>
        {/* Positions + Orders — below on all screens */}
      </div>
      <div className="border-t border-border overflow-auto max-h-[300px] md:max-h-[240px]">
        <Positions positions={positions} market={displayMarket} />
        <TriggerOrders orders={triggerOrders} market={displayMarket} />
      </div>
    </div>
  );
}
