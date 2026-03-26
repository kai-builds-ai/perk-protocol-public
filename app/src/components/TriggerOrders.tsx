"use client";

import React, { memo, useState, useCallback } from "react";
import { TriggerOrder, Market, Side } from "@/types";
import { formatUsd } from "@/lib/format";
import { usePerk } from "@/providers/PerkProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import toast from "react-hot-toast";

interface TriggerOrdersProps {
  orders: TriggerOrder[];
  market?: Market;
}

export const TriggerOrders = memo(function TriggerOrders({
  orders,
  market,
}: TriggerOrdersProps) {
  const { client } = usePerk();
  const { publicKey } = useWallet();
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const handleCancel = useCallback(
    async (order: TriggerOrder) => {
      if (!client || !publicKey || !market) {
        toast.error("Please connect your wallet.");
        return;
      }

      const confirmed = window.confirm(
        `Cancel ${order.orderType} order #${order.orderId}?`
      );
      if (!confirmed) return;

      setCancellingId(order.orderId);
      try {
        const tokenMint = new PublicKey(market.tokenMint);
        const sig = await client.cancelTriggerOrder(tokenMint, new BN(order.orderId));
        toast.success("Order cancelled!\nTX: " + sig.slice(0, 16) + "...");
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("Cancel order failed:", err);
        toast.error("Failed to cancel order: " + message);
      } finally {
        setCancellingId(null);
      }
    },
    [client, publicKey, market]
  );

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
      <div className="overflow-x-auto" style={{ WebkitOverflowScrolling: "touch" }}>
      <table className="w-full text-xs min-w-[480px]">
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
            const isCancelling = cancellingId === o.orderId;
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
                  <button
                    onClick={() => handleCancel(o)}
                    disabled={isCancelling || !market}
                    className={`px-2 py-0.5 text-[10px] font-sans rounded-[4px] border transition-colors duration-100 ${
                      isCancelling
                        ? "text-zinc-600 border-zinc-800 cursor-not-allowed"
                        : "text-loss/80 border-loss/30 hover:text-loss hover:border-loss/50"
                    }`}
                  >
                    {isCancelling ? "..." : "Cancel"}
                  </button>
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
