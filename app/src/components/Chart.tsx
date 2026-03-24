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
        },
        timeScale: {
          borderColor: COLORS.border,
          timeVisible: true,
        },
      });

      const series = chart.addCandlestickSeries({
        upColor: COLORS.profit,
        downColor: COLORS.loss,
        borderUpColor: COLORS.profit,
        borderDownColor: COLORS.loss,
        wickUpColor: COLORS.profit,
        wickDownColor: COLORS.loss,
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
