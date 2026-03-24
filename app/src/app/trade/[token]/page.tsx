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
      <div className="flex items-center gap-2 px-4">
        <MarketStats market={displayMarket} />
        {connected && (
          <span className="text-xs font-mono text-profit ml-2">● LIVE</span>
        )}
        {isReal && (
          <span className="text-xs font-mono text-text-tertiary">PYTH</span>
        )}
      </div>
      <div className="flex flex-1 min-h-0">
        {/* Left: Chart */}
        <div className="flex-1 flex flex-col border-r border-border min-w-0">
          <div className="flex-1 min-h-0">
            <Chart data={candles} symbol={token} />
          </div>
          {/* Positions + Orders below chart */}
          <div className="border-t border-border overflow-auto max-h-[240px]">
            <Positions positions={positions} />
            <TriggerOrders orders={triggerOrders} />
          </div>
        </div>
        {/* Right: Trade Panel */}
        <div className="w-[320px] flex flex-col border-l border-border bg-surface">
          <div className="flex-1 overflow-auto">
            <TradePanel market={displayMarket} />
          </div>
          <DepositWithdraw market={displayMarket} />
        </div>
      </div>
    </div>
  );
}
