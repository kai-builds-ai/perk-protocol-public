"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import {
  calculateMarkPrice,
  priceToNumber,
  estimateLiquidationPrice,
  numberToPrice,
  accountEquity,
  amountToNumber,
  PRICE_SCALE,
  POS_SCALE,
  LEVERAGE_SCALE,
  MarketAccount as SDKMarketAccount,
  UserPositionAccount as SDKPositionAccount,
  TriggerOrderAccount as SDKTriggerOrderAccount,
  TriggerOrderType as SDKTriggerOrderType,
  Side as SDKSide,
} from "@perk/sdk";
import { UserPosition, TriggerOrder, TriggerOrderType, Side } from "@/types";
import { usePerk } from "@/providers/PerkProvider";
import { getTokenSymbol, getTokenDecimals } from "@/lib/token-meta";

function mapTriggerOrderType(t: SDKTriggerOrderType): TriggerOrderType {
  switch (t) {
    case SDKTriggerOrderType.Limit:
      return TriggerOrderType.Limit;
    case SDKTriggerOrderType.StopLoss:
      return TriggerOrderType.StopLoss;
    case SDKTriggerOrderType.TakeProfit:
      return TriggerOrderType.TakeProfit;
    default:
      return TriggerOrderType.Limit;
  }
}

function mapSide(s: SDKSide): Side {
  return s === SDKSide.Long ? Side.Long : Side.Short;
}

/** Derive frontend position from on-chain data */
function toFrontendPosition(
  pos: SDKPositionAccount,
  market: SDKMarketAccount,
): UserPosition {
  const markPrice = calculateMarkPrice(market);
  const baseSize = pos.baseSize.toNumber() / POS_SCALE;

  // Use collateral mint decimals for proper scaling (F-02 fix)
  const collateralMint = market.collateralMint.toBase58();
  const decimals = getTokenDecimals(collateralMint);
  const collateralHuman = amountToNumber(pos.depositedCollateral, decimals);

  const quoteEntry = pos.quoteEntryAmount.toNumber();

  // Entry price: quoteEntryAmount / |baseSize| (both POS_SCALE-scaled, ratio cancels)
  const absBasis = Math.abs(pos.baseSize.toNumber());
  const entryPrice = absBasis > 0 ? quoteEntry / absBasis : 0;

  // PnL: use SDK's accountEquity which handles ADL, funding, fee credits (F-04 fix)
  const equity = accountEquity(pos);
  const equityHuman = amountToNumber(equity, decimals);
  const pnl = equityHuman - collateralHuman; // equity - deposited = realized + unrealized PnL
  const pnlPercent = collateralHuman > 0 ? (pnl / collateralHuman) * 100 : 0;

  // Leverage: notional / equity
  const notional = Math.abs(baseSize) * markPrice;
  const leverage = equityHuman > 0 ? notional / equityHuman : 0;

  // Available margin: equity - IM requirement
  const imBps = Math.floor(10000 / (market.maxLeverage / LEVERAGE_SCALE));
  const imRequired = notional * imBps / 10000;
  const availableMargin = Math.max(0, equityHuman - imRequired);

  // Liquidation price
  const oraclePrice = market.lastOraclePrice && !market.lastOraclePrice.isZero()
    ? market.lastOraclePrice
    : numberToPrice(markPrice);
  const liqPrice = estimateLiquidationPrice(pos, market, oraclePrice) ?? 0;

  // Resolve market symbol from mint
  const mintStr = market.tokenMint.toBase58();
  const symbol = getTokenSymbol(mintStr);

  return {
    authority: pos.authority.toBase58(),
    market: pos.market.toBase58(),
    marketSymbol: symbol,
    tokenMint: mintStr,
    creator: market.creator.toBase58(),
    oracleAddress: market.oracleAddress.toBase58(),
    depositedCollateral: collateralHuman,
    availableMargin,
    baseSize,
    quoteEntryAmount: quoteEntry / POS_SCALE,
    entryPrice,
    leverage: Math.round(leverage * 100) / 100,
    pnl: Math.round(pnl * 100) / 100,
    pnlPercent: Math.round(pnlPercent * 100) / 100,
    liquidationPrice: Math.round(liqPrice * 100) / 100,
    openTriggerOrders: pos.openTriggerOrders,
  };
}

/** Convert on-chain trigger order to frontend type */
function toFrontendTriggerOrder(
  order: SDKTriggerOrderAccount,
  market: SDKMarketAccount,
): TriggerOrder {
  const mintStr = market.tokenMint.toBase58();
  const symbol = getTokenSymbol(mintStr);
  return {
    authority: order.authority.toBase58(),
    market: order.market.toBase58(),
    marketSymbol: symbol,
    tokenMint: mintStr,
    creator: market.creator.toBase58(),
    orderId: order.orderId.toNumber(),
    orderType: mapTriggerOrderType(order.orderType),
    side: mapSide(order.side),
    size: order.size.toNumber() / POS_SCALE,
    triggerPrice: priceToNumber(order.triggerPrice),
    leverage: order.leverage / LEVERAGE_SCALE,
    reduceOnly: order.reduceOnly,
    createdAt: order.createdAt.toNumber() * 1000,
  };
}

const POLL_INTERVAL = 5_000; // 5 seconds

export function usePositions() {
  const { client, readonlyClient } = usePerk();
  const { publicKey, connected } = useWallet();
  const [positions, setPositions] = useState<UserPosition[]>([]);
  const [triggerOrders, setTriggerOrders] = useState<TriggerOrder[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pashov M-01 fix: generation counter prevents stale fetches
  const generationRef = useRef(0);

  const fetchPositions = useCallback(async () => {
    if (!publicKey || !connected) {
      setPositions([]);
      setTriggerOrders([]);
      return;
    }

    const gen = ++generationRef.current;
    const perkClient = client ?? readonlyClient;
    setLoading(true);

    try {
      const rawPositions = await perkClient.fetchAllPositions(publicKey);

      const positionResults: UserPosition[] = [];
      const allOrders: TriggerOrder[] = [];

      for (const { account: pos } of rawPositions) {
        if (pos.baseSize.isZero() && pos.depositedCollateral.isZero()) continue;

        try {
          const market = await perkClient.fetchMarketByAddress(pos.market);
          positionResults.push(toFrontendPosition(pos, market));

          if (pos.openTriggerOrders > 0) {
            const orders = await perkClient.fetchTriggerOrders(pos.market, publicKey);
            for (const { account: order } of orders) {
              allOrders.push(toFrontendTriggerOrder(order, market));
            }
          }
        } catch (err) {
          console.warn("[usePositions] Error fetching market for position:", err);
        }
      }

      if (gen !== generationRef.current) return;
      setPositions(positionResults);
      setTriggerOrders(allOrders);
      setError(null);
    } catch (err: any) {
      if (gen !== generationRef.current) return;
      console.error("[usePositions] fetch error:", err);
      setError(err?.message ?? "Failed to fetch positions");
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [client, readonlyClient, publicKey, connected]);

  useEffect(() => {
    if (connected && publicKey) {
      fetchPositions();
      const interval = setInterval(fetchPositions, POLL_INTERVAL);
      return () => { clearInterval(interval); };
    } else {
      setPositions([]);
      setTriggerOrders([]);
    }
  }, [fetchPositions, connected, publicKey]);

  return { positions, triggerOrders, loading, error };
}

/**
 * Filter positions and trigger orders for a specific market address.
 * Pass `null` when market hasn't loaded yet — returns empty arrays.
 */
export function usePositionsForMarket(marketAddress: string | null) {
  const { positions, triggerOrders, loading, error } = usePositions();
  return {
    positions: marketAddress
      ? positions.filter((p) => p.market === marketAddress)
      : [],
    triggerOrders: marketAddress
      ? triggerOrders.filter((o) => o.market === marketAddress)
      : [],
    loading,
    error,
  };
}
