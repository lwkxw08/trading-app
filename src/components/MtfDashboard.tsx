"use client";

import { useCallback, useEffect, useState } from "react";
import { apiUrl } from "./api";
import type { Timeframe } from "@/lib/market/types";

interface MtfRow {
  timeframe: Timeframe;
  trend: "up" | "down" | "sideways";
  rsi14: number | null;
  macdHistogram: number | null;
  priceVsPoc: "above" | "below";
  priceVsVwap: "above" | "below" | null;
  openFvgs: number;
  activeOrderBlocks: number;
  lastStructureBreak: { type: "bos" | "choch"; direction: "bullish" | "bearish" } | null;
  bestSetup: { direction: "long" | "short"; score: number } | null;
}

function TrendCell({ trend }: { trend: MtfRow["trend"] }) {
  const cls = trend === "up" ? "text-bull" : trend === "down" ? "text-bear" : "text-muted";
  const arrow = trend === "up" ? "▲" : trend === "down" ? "▼" : "◆";
  return (
    <span className={`font-semibold ${cls}`}>
      {arrow} {trend}
    </span>
  );
}

function BiasCell({ side }: { side: "above" | "below" | null }) {
  if (!side) return <span className="text-muted">—</span>;
  return <span className={side === "above" ? "text-bull" : "text-bear"}>{side}</span>;
}

export default function MtfDashboard({ symbol }: { symbol: string }) {
  const [rows, setRows] = useState<MtfRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(apiUrl(`/api/mtf?symbol=${symbol}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "failed to load");
        setRows(d.rows);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol]);

  useEffect(() => {
    setRows([]);
    load();
  }, [load]);

  const ups = rows.filter((r) => r.trend === "up").length;
  const downs = rows.filter((r) => r.trend === "down").length;
  const alignment =
    rows.length === 0
      ? null
      : ups >= rows.length - 1
        ? { label: "Strong bullish alignment", cls: "bg-bull/20 text-bull" }
        : downs >= rows.length - 1
          ? { label: "Strong bearish alignment", cls: "bg-bear/20 text-bear" }
          : ups > downs
            ? { label: `Bullish lean (${ups}/${rows.length} up)`, cls: "bg-bull/10 text-bull" }
            : downs > ups
              ? { label: `Bearish lean (${downs}/${rows.length} down)`, cls: "bg-bear/10 text-bear" }
              : { label: "Mixed / no alignment", cls: "bg-edge text-muted" };

  return (
    <section className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Multi-Timeframe Confluence</h2>
        <div className="flex items-center gap-2">
          {alignment && (
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${alignment.cls}`}>{alignment.label}</span>
          )}
          <button
            onClick={load}
            disabled={loading}
            className="rounded-md border border-edge px-2 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          >
            {loading ? "Scanning…" : "Refresh"}
          </button>
        </div>
      </div>
      {error && <p className="mt-3 text-sm text-bear">{error}</p>}
      {loading && rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">Analyzing {symbol} across all timeframes…</p>
      ) : rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="text-xs uppercase text-muted">
                <th className="pb-2 pr-3">TF</th>
                <th className="pb-2 pr-3">Trend</th>
                <th className="pb-2 pr-3">RSI</th>
                <th className="pb-2 pr-3">MACD</th>
                <th className="pb-2 pr-3">vs POC</th>
                <th className="pb-2 pr-3">vs AVWAP</th>
                <th className="pb-2 pr-3">FVGs</th>
                <th className="pb-2 pr-3">OBs</th>
                <th className="pb-2 pr-3">Structure</th>
                <th className="pb-2">Best setup</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.timeframe} className="border-t border-edge">
                  <td className="py-2 pr-3 font-mono font-semibold">{r.timeframe}</td>
                  <td className="py-2 pr-3">
                    <TrendCell trend={r.trend} />
                  </td>
                  <td className={`py-2 pr-3 font-mono ${r.rsi14 != null && r.rsi14 >= 70 ? "text-bear" : r.rsi14 != null && r.rsi14 <= 30 ? "text-bull" : ""}`}>
                    {r.rsi14 != null ? r.rsi14.toFixed(0) : "—"}
                  </td>
                  <td className="py-2 pr-3">
                    {r.macdHistogram == null ? (
                      <span className="text-muted">—</span>
                    ) : (
                      <span className={r.macdHistogram >= 0 ? "text-bull" : "text-bear"}>
                        {r.macdHistogram >= 0 ? "+" : "−"}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <BiasCell side={r.priceVsPoc} />
                  </td>
                  <td className="py-2 pr-3">
                    <BiasCell side={r.priceVsVwap} />
                  </td>
                  <td className="py-2 pr-3 font-mono">{r.openFvgs}</td>
                  <td className="py-2 pr-3 font-mono">{r.activeOrderBlocks}</td>
                  <td className="py-2 pr-3">
                    {r.lastStructureBreak ? (
                      <span className={r.lastStructureBreak.direction === "bullish" ? "text-bull" : "text-bear"}>
                        {r.lastStructureBreak.type.toUpperCase()} {r.lastStructureBreak.direction}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    {r.bestSetup ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-xs font-bold uppercase ${
                          r.bestSetup.direction === "long" ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
                        }`}
                      >
                        {r.bestSetup.direction} {r.bestSetup.score}
                      </span>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
