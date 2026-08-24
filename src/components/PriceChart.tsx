"use client";

import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/market/types";

export interface LevelLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export default function PriceChart({ candles, levels }: { candles: Candle[]; levels: LevelLine[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [fullscreen]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#12161f" },
        textColor: "#8b93a3",
      },
      grid: {
        vertLines: { color: "#1f2530" },
        horzLines: { color: "#1f2530" },
      },
      height: containerRef.current.clientHeight,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#22c55e",
      downColor: "#ef4444",
      borderVisible: false,
      wickUpColor: "#22c55e",
      wickDownColor: "#ef4444",
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    chartRef.current = chart;
    seriesRef.current = series;
    volumeRef.current = volume;

    const observer = new ResizeObserver(() => {
      if (containerRef.current)
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!series || !volume || candles.length === 0) return;
    series.setData(
      candles.map((c) => ({
        time: c.time as never,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    volume.setData(
      candles.map((c) => ({
        time: c.time as never,
        value: c.volume,
        color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = levels.map((lvl) =>
      series.createPriceLine({
        price: lvl.price,
        color: lvl.color,
        lineWidth: 1,
        lineStyle: lvl.dashed ? LineStyle.Dashed : LineStyle.Solid,
        axisLabelVisible: true,
        title: lvl.title,
      }),
    );
  }, [levels, candles]);

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex flex-col bg-background p-3"
          : "relative"
      }
    >
      <button
        onClick={() => setFullscreen((f) => !f)}
        title={fullscreen ? "Exit full screen (Esc)" : "Full screen"}
        className={`absolute z-10 rounded-md border border-edge bg-surface/90 px-2 py-1 text-xs text-muted hover:text-foreground ${
          fullscreen ? "top-5 right-5" : "top-2 right-3"
        }`}
      >
        {fullscreen ? "✕ Exit full screen" : "⛶ Full screen"}
      </button>
      <div
        ref={containerRef}
        className={`w-full overflow-hidden rounded-lg border border-edge ${fullscreen ? "flex-1" : "h-[480px]"}`}
      />
    </div>
  );
}
