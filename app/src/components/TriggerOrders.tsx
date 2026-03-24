"use client";

import React, { memo } from "react";
import { TriggerOrder, Side } from "@/types";
import { formatUsd } from "@/lib/format";

interface TriggerOrdersProps {
  orders: TriggerOrder[];
}

export const TriggerOrders = memo(function TriggerOrders({
  orders,
}: TriggerOrdersProps) {
  if (orders.length === 0) {
    return (
      <div className="p-3 text-xs text-text-tertiary font-sans">
        No open orders
      </div>
    );
  }

  return (
    <div>
      <div className="px-3 py-2 text-xs font-sans font-medium text-text-secondary uppercase tracking-wider border-b border-border">
        Orders ({orders.length})
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border">
            <th className="px-3 py-1.5 text-left text-[10px] font-sans uppercase text-text-secondary tracking-wider">Type</th>
            <th className="px-3 py-1.5 text-left text-[10px] font-sans uppercase text-text-secondary tracking-wider">Side</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Trigger</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Size</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider">Leverage</th>
            <th className="px-3 py-1.5 text-right text-[10px] font-sans uppercase text-text-secondary tracking-wider" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const isLong = o.side === Side.Long;
            return (
              <tr key={o.orderId} className="border-b border-border hover:bg-white/[0.02]">
                <td className="px-3 py-2 font-sans text-white">
                  {o.orderType === "Limit" ? "LIMIT" : o.orderType === "StopLoss" ? "STOP LOSS" : "TAKE PROFIT"}
                  {o.reduceOnly && (
                    <span className="ml-1 text-text-tertiary text-[10px]">reduce</span>
                  )}
                </td>
                <td className={`px-3 py-2 font-sans font-medium ${isLong ? "text-profit" : "text-loss"}`}>
                  {isLong ? "LONG" : "SHORT"}
                </td>
                <td className="px-3 py-2 text-right font-mono text-white">
                  {formatUsd(o.triggerPrice)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-white">
                  {o.size.toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right font-mono text-text-secondary">
                  {o.leverage}x
                </td>
                <td className="px-3 py-2 text-right">
                  <button className="px-2 py-0.5 text-[10px] font-sans text-loss/80 border border-loss/30 rounded-[4px] hover:text-loss hover:border-loss/50 transition-colors duration-100">
                    Cancel
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
});
