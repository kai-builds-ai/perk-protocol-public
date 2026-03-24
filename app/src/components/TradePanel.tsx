"use client";

import React, { useState, useMemo, useCallback, useEffect } from "react";
import { Market, OrderTab, Side } from "@/types";
import { LeverageSlider } from "./LeverageSlider";
import { formatUsd } from "@/lib/format";

interface TradePanelProps {
  market: Market;
}

export function TradePanel({ market }: TradePanelProps) {
  const [tab, setTab] = useState<OrderTab>("market");
  const [side, setSide] = useState<Side>(Side.Long);
  const [size, setSize] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [triggerPrice, setTriggerPrice] = useState("");

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
      if (e.key === "Enter") {
        // Submit order (mock)
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const sizeNum = parseFloat(size) || 0;

  const estimates = useMemo(() => {
    if (!sizeNum) return null;
    const entryPrice =
      tab === "limit" || tab === "stop"
        ? parseFloat(triggerPrice) || market.markPrice
        : market.markPrice;
    const fee = sizeNum * entryPrice * (market.tradingFeeBps / 10000);
    const margin = (sizeNum * entryPrice) / leverage;
    const liqDistance = margin * 0.95;
    const liqPrice =
      side === Side.Long
        ? entryPrice - liqDistance / sizeNum
        : entryPrice + liqDistance / sizeNum;
    const slippage = sizeNum * 0.0008;
    return { entryPrice, fee, liqPrice: Math.max(0, liqPrice), slippage };
  }, [sizeNum, market, leverage, side, tab, triggerPrice]);

  const isLong = side === Side.Long;

  const handleSubmit = useCallback(() => {
    // Mock submit
    setSize("");
    setTriggerPrice("");
  }, []);

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
            Size
          </label>
          <div className="flex items-center border border-zinc-700 rounded-[4px] focus-within:border-zinc-400 transition-colors duration-100">
            <input
              type="number"
              value={size}
              onChange={(e) => setSize(e.target.value)}
              placeholder="0.00"
              className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary"
            />
            <span className="pr-3 text-sm font-sans text-text-secondary">
              {market.symbol}
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
                className="flex-1 bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary"
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
          disabled={!sizeNum}
          className={`w-full py-3 text-sm font-sans font-medium rounded-[4px] border transition-colors duration-100 ${
            !sizeNum
              ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
              : isLong
              ? "bg-profit/10 border-profit/50 text-profit hover:bg-profit/20"
              : "bg-loss/10 border-loss/50 text-loss hover:bg-loss/20"
          }`}
        >
          {isLong ? "Open Long" : "Open Short"}
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
