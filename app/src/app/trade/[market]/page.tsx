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
import { OracleSource } from "@/types";
import { usePositionsForMarket } from "@/hooks/usePosition";
import { usePythPrice } from "@/hooks/usePythPrice";
import { usePythCandles } from "@/hooks/usePythCandles";

export default function TradingView() {
  const params = useParams();
  const marketKey = params.market as string;
  const { market, loading } = useMarket(marketKey);
  const symbol = market?.symbol ?? "";
  const marketAddress = market?.address ?? null;
  const { positions, triggerOrders } = usePositionsForMarket(marketAddress);
  const { price: livePrice, connected, stale } = usePythPrice(
    symbol,
    market?.markPrice
  );
  const [interval, setInterval] = React.useState("60");
  const { candles, isReal } = usePythCandles(symbol, interval, 200, market?.tokenMint);

  // Show loading state while markets are being fetched (e.g., after market creation redirect).
  // Grace period: keep showing "Loading" for up to 15s to let MarketsProvider poll new markets.
  const [gracePeriod, setGracePeriod] = React.useState(true);
  React.useEffect(() => {
    const timer = setTimeout(() => setGracePeriod(false), 15000);
    return () => clearTimeout(timer);
  }, []);

  if (!market) {
    const isStillLoading = loading || gracePeriod;
    return (
      <div className="flex flex-col h-screen">
        <TopBar />
        <div className="flex-1 flex items-center justify-center text-text-secondary font-sans text-sm">
          {isStillLoading
            ? "Loading market..."
            : `Market not found: ${marketKey?.slice(0, 12)}...`}
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
    <div className="flex flex-col min-h-screen md:h-screen">
      <TopBar solPrice={symbol === "SOL" ? displayMarket.markPrice : undefined} />
      <div className="flex items-center gap-2 px-4 overflow-x-auto flex-nowrap" style={{ WebkitOverflowScrolling: "touch" }}>
        <MarketStats market={displayMarket} />
        {connected && (
          stale ? (
            <span className="text-xs font-mono text-yellow-400 ml-2 flex-shrink-0" title="Price data may be outdated">⚠ STALE</span>
          ) : (
            <span className="text-xs font-mono text-profit ml-2 flex-shrink-0">● LIVE</span>
          )
        )}
        <span className="text-xs font-mono text-text-tertiary flex-shrink-0">
          {displayMarket.oracleSource === OracleSource.PerkOracle ? "PERKORACLE" : displayMarket.oracleSource === OracleSource.DexPool ? "DEX" : "PYTH"}
        </span>
      </div>
      {/* Desktop: side-by-side with inner scroll. Mobile: stacked, natural page scroll */}
      <div className="flex flex-col md:flex-row flex-1 min-h-0 md:overflow-auto no-scrollbar">
        {/* Left: Chart + Positions (desktop) */}
        <div className="flex flex-col md:flex-1 md:border-r border-border min-w-0">
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-surface">
            {[
              { label: "5m", value: "5" },
              { label: "15m", value: "15" },
              { label: "1H", value: "60" },
              { label: "4H", value: "240" },
              { label: "1D", value: "D" },
            ].map((tf) => (
              <button
                key={tf.value}
                onClick={() => setInterval(tf.value)}
                className={`px-2 py-0.5 text-xs font-mono rounded-[2px] transition-colors ${
                  interval === tf.value
                    ? "bg-accent/20 text-accent"
                    : "text-text-tertiary hover:text-white"
                }`}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <div className="h-[240px] md:h-auto md:flex-1 md:min-h-[300px]">
            <Chart data={candles} symbol={symbol} />
          </div>
          {/* Positions + Orders — below chart on desktop, below everything on mobile */}
          <div className="hidden md:block border-t border-border overflow-auto max-h-[240px]">
            <Positions positions={positions} market={displayMarket} livePrice={livePrice || undefined} triggerOrders={triggerOrders} />
            <TriggerOrders orders={triggerOrders} market={displayMarket} />
          </div>
        </div>
        {/* Right: Trade Panel */}
        <div className="w-full md:w-[320px] flex flex-col md:border-l border-border bg-surface">
          <DepositWithdraw market={displayMarket} />
          <TradePanel market={displayMarket} hasOpenPosition={positions.length > 0} />
        </div>
        {/* Positions + Orders — mobile only, below trade panel */}
        <div className="md:hidden border-t border-border">
          <Positions positions={positions} market={displayMarket} livePrice={livePrice || undefined} triggerOrders={triggerOrders} />
          <TriggerOrders orders={triggerOrders} market={displayMarket} />
        </div>
      </div>
    </div>
  );
}
