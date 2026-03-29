"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { CandleData } from "@/types";

const BIRDEYE_WS_URL = "wss://public-api.birdeye.so/socket/solana";
const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 25000;

interface BirdeyeCandle {
  o: number; // open
  h: number; // high
  l: number; // low
  c: number; // close
  v: number; // volume
  unixTime: number;
  type: string;
}

/**
 * Subscribe to real-time OHLCV candles from Birdeye WebSocket.
 * Falls back gracefully if the API key doesn't support WebSocket.
 */
export function useBirdeyeWs(
  mint: string | undefined,
  resolution: string = "1m",
  apiKey: string | undefined
) {
  const [liveCandles, setLiveCandles] = useState<CandleData[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  // Map our resolution strings to Birdeye chartType
  const chartType = useCallback((res: string) => {
    switch (res) {
      case "1": return "1m";
      case "5": return "5m";
      case "15": return "15m";
      case "60": return "1H";
      case "240": return "4H";
      case "D": return "1D";
      default: return "1m";
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!mint || !apiKey) return;

    let ws: WebSocket;

    const connect = () => {
      if (!mountedRef.current) return;

      try {
        ws = new WebSocket(
          `${BIRDEYE_WS_URL}?x-api-key=${apiKey}`,
          ["echo-protocol"]
        );
      } catch {
        return;
      }

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        setConnected(true);

        // Subscribe to OHLCV for this token
        ws.send(JSON.stringify({
          type: "SUBSCRIBE_PRICE",
          data: {
            chartType: chartType(resolution),
            address: mint,
            currency: "usd",
          },
        }));

        // Ping to keep alive
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "PING" }));
          }
        }, PING_INTERVAL_MS);
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "PRICE_DATA" && msg.data) {
            const d: BirdeyeCandle = msg.data;
            if (d.o > 0 && d.c > 0 && d.h > 0 && d.l > 0 && d.unixTime) {
              const candle: CandleData = {
                time: d.unixTime,
                open: d.o,
                high: d.h,
                low: d.l,
                close: d.c,
              };
              setLiveCandles((prev) => {
                // Update or append — if same timestamp, update in place
                const idx = prev.findIndex((c) => c.time === candle.time);
                if (idx >= 0) {
                  const updated = [...prev];
                  updated[idx] = candle;
                  return updated;
                }
                return [...prev, candle].slice(-500); // Keep last 500
              });
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      ws.onerror = () => {
        setConnected(false);
      };

      ws.onclose = () => {
        setConnected(false);
        if (pingRef.current) clearInterval(pingRef.current);
        // Auto-reconnect
        if (mountedRef.current) {
          reconnectRef.current = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };

      wsRef.current = ws;
    };

    connect();

    return () => {
      mountedRef.current = false;
      if (pingRef.current) clearInterval(pingRef.current);
      if (reconnectRef.current) clearTimeout(reconnectRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null; // Prevent reconnect on intentional close
        wsRef.current.close();
      }
      setLiveCandles([]);
      setConnected(false);
    };
  }, [mint, apiKey, resolution, chartType]);

  return { liveCandles, connected };
}
