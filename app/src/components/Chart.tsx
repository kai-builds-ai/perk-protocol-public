"use client";

import React, { useEffect, useRef, memo } from "react";
import { CandleData } from "@/types";
import { COLORS } from "@/lib/constants";

interface ChartProps {
  data: CandleData[];
  symbol: string;
}

export const Chart = memo(function Chart({ data, symbol }: ChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof import("lightweight-charts").createChart> | null>(null);
  const seriesRef = useRef<ReturnType<ReturnType<typeof import("lightweight-charts").createChart>["addCandlestickSeries"]> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let mounted = true;

    import("lightweight-charts").then(({ createChart }) => {
      if (!mounted || !containerRef.current) return;

      const chart = createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: containerRef.current.clientHeight,
        layout: {
          background: { color: COLORS.surface },
          textColor: COLORS.textSecondary,
          fontFamily: "JetBrains Mono, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: COLORS.border },
          horzLines: { color: COLORS.border },
        },
        crosshair: {
          vertLine: { color: COLORS.textTertiary, width: 1, style: 2 },
          horzLine: { color: COLORS.textTertiary, width: 1, style: 2 },
        },
        rightPriceScale: {
          borderColor: COLORS.border,
          mode: (() => {
            // Auto-detect if log scale is needed (price range > 5x)
            if (data.length > 1) {
              const prices = data.flatMap(d => [d.open, d.high, d.low, d.close]).filter(p => p > 0);
              const min = Math.min(...prices);
              const max = Math.max(...prices);
              if (min > 0 && max / min > 5) return 1; // logarithmic
            }
            return 0; // normal
          })(),
        },
        timeScale: {
          borderColor: COLORS.border,
          timeVisible: true,
        },
      });

      // Auto-detect decimal precision from price magnitude
      const prices = data.map(d => d.close).filter(p => p > 0);
      const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 1;
      const minDecimals = avgPrice >= 100 ? 2 : avgPrice >= 1 ? 4 : avgPrice >= 0.01 ? 6 : avgPrice >= 0.0001 ? 8 : 10;

      const series = chart.addCandlestickSeries({
        upColor: COLORS.profit,
        downColor: COLORS.loss,
        borderUpColor: COLORS.profit,
        borderDownColor: COLORS.loss,
        wickUpColor: COLORS.profit,
        wickDownColor: COLORS.loss,
        priceFormat: {
          type: 'price',
          precision: minDecimals,
          minMove: 1 / Math.pow(10, minDecimals),
        },
      });

      series.setData(
        data.map((d) => ({
          time: d.time as import("lightweight-charts").UTCTimestamp,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        }))
      );

      chart.timeScale().fitContent();

      chartRef.current = chart;
      seriesRef.current = series;

      const handleResize = () => {
        if (containerRef.current) {
          chart.applyOptions({
            width: containerRef.current.clientWidth,
            height: containerRef.current.clientHeight,
          });
        }
      };

      const observer = new ResizeObserver(handleResize);
      observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
        chart.remove();
      };
    });

    return () => {
      mounted = false;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update data when it changes
  useEffect(() => {
    if (seriesRef.current && data.length > 0) {
      seriesRef.current.setData(
        data.map((d) => ({
          time: d.time as import("lightweight-charts").UTCTimestamp,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        }))
      );
    }
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full min-h-[400px]"
      aria-label={`${symbol} price chart`}
    />
  );
});
