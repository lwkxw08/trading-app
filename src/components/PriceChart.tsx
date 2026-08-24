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
import { useCallback, useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/market/types";

export interface LevelLine {
  price: number;
  color: string;
  title: string;
  dashed?: boolean;
}

export interface ZoneBox {
  top: number;
  bottom: number;
  /** unix seconds of the bar the zone starts at */
  from: number;
  color: string;
  label: string;
}

export interface ProfileOverlay {
  bins: { price: number; volume: number }[];
  poc: number;
  vah: number;
  val: number;
}

export default function PriceChart({
  candles,
  levels,
  zones = [],
  profile = null,
  drawMode = false,
  onPriceClick,
}: {
  candles: Candle[];
  levels: LevelLine[];
  zones?: ZoneBox[];
  profile?: ProfileOverlay | null;
  drawMode?: boolean;
  onPriceClick?: (price: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const datasetRef = useRef<number | null>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const zonesRef = useRef<ZoneBox[]>(zones);
  const profileRef = useRef<ProfileOverlay | null>(profile);
  const clickRef = useRef<{ drawMode: boolean; onPriceClick?: (price: number) => void }>({ drawMode, onPriceClick });
  const [fullscreen, setFullscreen] = useState(false);

  zonesRef.current = zones;
  profileRef.current = profile;
  clickRef.current = { drawMode, onPriceClick };

  const drawZones = useCallback(() => {
    const canvas = overlayRef.current;
    const chart = chartRef.current;
    const series = seriesRef.current;
    const container = containerRef.current;
    if (!canvas || !chart || !series || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const paneWidth = chart.timeScale().width();
    for (const z of zonesRef.current) {
      const yTop = series.priceToCoordinate(z.top);
      const yBottom = series.priceToCoordinate(z.bottom);
      if (yTop == null || yBottom == null) continue;
      const xFrom = chart.timeScale().timeToCoordinate(z.from as never) ?? 0;
      ctx.fillStyle = z.color;
      ctx.fillRect(xFrom, yTop, Math.max(0, paneWidth - xFrom), yBottom - yTop);
      ctx.fillStyle = "#c8cfdb";
      ctx.font = "10px sans-serif";
      ctx.fillText(z.label, Math.max(xFrom + 4, 4), Math.min(yTop + 12, h - 4));
    }

    // volume profile histogram along the left edge of the pane
    const p = profileRef.current;
    if (p && p.bins.length > 1) {
      const maxVol = Math.max(...p.bins.map((b) => b.volume));
      if (maxVol > 0) {
        const maxBarWidth = paneWidth * 0.22;
        const y0 = series.priceToCoordinate(p.bins[0].price);
        const y1 = series.priceToCoordinate(p.bins[1].price);
        const binH = y0 != null && y1 != null ? Math.max(1, Math.abs(y1 - y0) - 1) : 3;
        const pocPrice = p.bins.reduce((best, b) => (b.volume > best.volume ? b : best), p.bins[0]).price;
        for (const b of p.bins) {
          const y = series.priceToCoordinate(b.price);
          if (y == null) continue;
          const barW = (b.volume / maxVol) * maxBarWidth;
          const inValueArea = b.price >= p.val && b.price <= p.vah;
          ctx.fillStyle =
            b.price === pocPrice
              ? "rgba(234,179,8,0.9)"
              : inValueArea
                ? "rgba(96,150,255,0.65)"
                : "rgba(96,150,255,0.35)";
          ctx.fillRect(0, y - binH / 2, barW, binH);
        }
      }
    }
  }, []);

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
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
        drawZones();
      }
    });
    observer.observe(containerRef.current);

    const onRangeChange = () => drawZones();
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange);
    chart.subscribeClick((param) => {
      const { drawMode: dm, onPriceClick: cb } = clickRef.current;
      if (!dm || !cb || !param.point || !seriesRef.current) return;
      const price = seriesRef.current.coordinateToPrice(param.point.y);
      if (price != null) cb(price);
    });

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange);
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      volumeRef.current = null;
      priceLinesRef.current = [];
    };
  }, [drawZones]);

  useEffect(() => {
    const series = seriesRef.current;
    const volume = volumeRef.current;
    if (!series || !volume || candles.length === 0) return;
    const first = candles[0].time;
    const isNewDataset = datasetRef.current !== first;
    if (isNewDataset) {
      datasetRef.current = first;
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
    } else {
      // Live tick: update only the latest bar, preserving the user's zoom/scroll.
      const c = candles[candles.length - 1];
      series.update({ time: c.time as never, open: c.open, high: c.high, low: c.low, close: c.close });
      volume.update({
        time: c.time as never,
        value: c.volume,
        color: c.close >= c.open ? "rgba(34,197,94,0.35)" : "rgba(239,68,68,0.35)",
      });
    }
    drawZones();
  }, [candles, drawZones]);

  useEffect(() => {
    drawZones();
  }, [zones, profile, drawZones]);

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
      <div className={`relative w-full ${fullscreen ? "flex-1" : "h-[480px]"}`}>
        <div
          ref={containerRef}
          className={`h-full w-full overflow-hidden rounded-lg border border-edge ${drawMode ? "cursor-crosshair" : ""}`}
        />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 z-[3]" />
      </div>
    </div>
  );
}
