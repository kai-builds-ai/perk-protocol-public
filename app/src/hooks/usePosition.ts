"use client";

import { useState } from "react";
import { UserPosition, TriggerOrder } from "@/types";
import { MOCK_POSITIONS, MOCK_TRIGGER_ORDERS } from "@/lib/mock-data";

export function usePositions() {
  const [positions] = useState<UserPosition[]>(MOCK_POSITIONS);
  const [triggerOrders] = useState<TriggerOrder[]>(MOCK_TRIGGER_ORDERS);

  return { positions, triggerOrders };
}

export function usePositionsForMarket(symbol: string) {
  const { positions, triggerOrders } = usePositions();
  return {
    positions: positions.filter((p) => p.marketSymbol === symbol),
    triggerOrders: triggerOrders.filter((o) => o.marketSymbol === symbol),
  };
}
