"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import AiChat from "@/components/AiChat";
import OpportunityCard, { FavoriteStar } from "@/components/OpportunityCard";
import { apiUrl } from "@/components/api";
import PriceChart, { type LevelLine, type ZoneBox } from "@/components/PriceChart";
import TradePlanBuilder from "@/components/TradePlanBuilder";
import MtfDashboard from "@/components/MtfDashboard";
import { useLiveKline } from "@/components/useLiveMarket";
import { fmtPrice } from "@/components/format";
import type { AiAnalysis } from "@/lib/ai/analyze";
import { addDrawing, clearDrawings, loadDrawings } from "@/lib/drawings/store";
import { TIMEFRAMES, type Candle, type Timeframe } from "@/lib/market/types";
import type { Opportunity, StrategyAnalysis } from "@/lib/strategies/types";

type AnalysisPayload = Omit<StrategyAnalysis, "candles">;

const LAYER_DEFS = [
  { id: "volumeProfile", label: "Volume profile" },
  { id: "fvg", label: "FVGs" },
  { id: "orderBlocks", label: "Order blocks" },
  { id: "avwap", label: "AVWAP" },
  { id: "sessions", label: "Session levels" },
  { id: "tradeLevels", label: "Entry/SL/TP" },
] as const;
type LayerId = (typeof LAYER_DEFS)[number]["id"];

export default function AnalyzeSymbol() {
  const params = useParams<{ symbol: string }>();
  const search = useSearchParams();
  const symbol = decodeURIComponent(params.symbol).toUpperCase();
  const [tf, setTf] = useState<Timeframe>(((search.get("tf") as Timeframe) ?? "1h"));
  const [candles, setCandles] = useState<Candle[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisPayload | null>(null);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);
  const [ai, setAi] = useState<AiAnalysis | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<Record<LayerId, boolean>>(
    () => Object.fromEntries(LAYER_DEFS.map((l) => [l.id, true])) as Record<LayerId, boolean>,
  );
  const liveCandle = useLiveKline(symbol, tf);
  const [drawMode, setDrawMode] = useState(false);
  const [drawings, setDrawings] = useState<number[]>([]);

  useEffect(() => {
    setDrawings(loadDrawings(symbol));
    setDrawMode(false);
  }, [symbol]);

  const onPriceClick = useCallback(
    (price: number) => setDrawings(addDrawing(symbol, price)),
    [symbol],
  );

  const liveCandles = useMemo<Candle[]>(() => {
    if (!liveCandle || candles.length === 0) return candles;
    const last = candles[candles.length - 1];
    if (liveCandle.time === last.time) return [...candles.slice(0, -1), liveCandle];
    if (liveCandle.time > last.time) return [...candles, liveCandle];
    return candles;
  }, [candles, liveCandle]);

  useEffect(() => {
    setError(null);
    setAi(null);
    setSelectedOpp(null);
    fetch(apiUrl(`/api/klines?symbol=${symbol}&tf=${tf}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "failed to load candles");
        setCandles(d.candles);
      })
      .catch((e) => setError(e.message));
    fetch(apiUrl(`/api/analysis?symbol=${symbol}&tf=${tf}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "analysis failed");
        setAnalysis(d.analysis);
        setOpportunities(d.opportunities);
        setSelectedOpp(d.opportunities[0] ?? null);
      })
      .catch((e) => setError(e.message));
  }, [symbol, tf]);

  const runAi = useCallback(() => {
    setAiLoading(true);
    setAiError(null);
    fetch(apiUrl("/api/ai/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, tf }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "AI analysis failed");
        setAi(d.ai);
      })
      .catch((e) => setAiError(e.message))
      .finally(() => setAiLoading(false));
  }, [symbol, tf]);

  const levels = useMemo<LevelLine[]>(() => {
    if (!analysis) return [];
    const out: LevelLine[] = [];
    if (layers.volumeProfile) {
      out.push({ price: analysis.volumeProfile.poc, color: "#eab308", title: "POC" });
      out.push({ price: analysis.volumeProfile.vah, color: "#eab30880", title: "VAH", dashed: true });
      out.push({ price: analysis.volumeProfile.val, color: "#eab30880", title: "VAL", dashed: true });
    }
    if (layers.avwap && analysis.anchoredVwap) {
      out.push({ price: analysis.anchoredVwap.value, color: "#a855f7", title: "AVWAP", dashed: true });
    }
    if (layers.sessions) {
      for (const s of analysis.sessionLevels.sessions) {
        out.push({ price: s.high, color: "#64748b", title: `${s.name} H`, dashed: true });
        out.push({ price: s.low, color: "#64748b", title: `${s.name} L`, dashed: true });
      }
    }
    if (layers.tradeLevels && selectedOpp) {
      out.push({ price: selectedOpp.entry, color: "#4f8cff", title: "Entry" });
      out.push({ price: selectedOpp.stopLoss, color: "#ef4444", title: "SL" });
      out.push({ price: selectedOpp.takeProfit, color: "#22c55e", title: "TP" });
    }
    for (const [i, price] of drawings.entries()) {
      out.push({ price, color: "#e2e8f0", title: `Level ${i + 1}` });
    }
    return out;
  }, [analysis, selectedOpp, layers, drawings]);

  const zones = useMemo<ZoneBox[]>(() => {
    if (!analysis) return [];
    const out: ZoneBox[] = [];
    if (layers.fvg) {
      for (const g of analysis.fvgs.filter((g) => !g.filled).slice(-3)) {
        out.push({
          top: g.top,
          bottom: g.bottom,
          from: g.time,
          color: g.direction === "bullish" ? "rgba(34,197,94,0.14)" : "rgba(239,68,68,0.14)",
          label: `FVG ${g.direction}`,
        });
      }
    }
    if (layers.orderBlocks) {
      for (const b of analysis.orderBlocks.filter((b) => !b.mitigated).slice(-2)) {
        out.push({
          top: b.top,
          bottom: b.bottom,
          from: b.time,
          color: b.direction === "bullish" ? "rgba(20,184,166,0.16)" : "rgba(249,115,22,0.16)",
          label: `OB ${b.direction}`,
        });
      }
    }
    return out;
  }, [analysis, layers]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="flex items-center gap-2 text-xl font-bold">
            <FavoriteStar symbol={symbol} />
            {symbol}
          </h1>
          {analysis && <span className="font-mono text-lg">{fmtPrice(liveCandle?.close ?? analysis.lastPrice)}</span>}
          {analysis && (
            <span
              className={`text-xs font-semibold uppercase ${
                analysis.trend.direction === "up" ? "text-bull" : analysis.trend.direction === "down" ? "text-bear" : "text-muted"
              }`}
            >
              {analysis.trend.direction} trend
            </span>
          )}
        </div>
        <div className="flex gap-1">
          {TIMEFRAMES.map((t) => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`rounded px-2 py-1 text-xs font-semibold ${
                t === tf ? "bg-accent text-white" : "bg-surface text-muted hover:text-foreground"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="text-sm text-bear">{error}</p>}

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface px-3 py-2">
            <span className="text-xs font-semibold text-muted">Chart layers:</span>
            {LAYER_DEFS.map((l) => (
              <label key={l.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={layers[l.id]}
                  onChange={(e) => setLayers((prev) => ({ ...prev, [l.id]: e.target.checked }))}
                  className="accent-[var(--accent)]"
                />
                {l.label}
              </label>
            ))}
            <button
              onClick={() =>
                setLayers(
                  Object.fromEntries(
                    LAYER_DEFS.map((l) => [l.id, !Object.values(layers).every(Boolean)]),
                  ) as Record<LayerId, boolean>,
                )
              }
              className="ml-auto text-xs text-accent hover:underline"
            >
              {Object.values(layers).every(Boolean) ? "Hide all" : "Show all"}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-edge bg-surface px-3 py-2">
            <span className="text-xs font-semibold text-muted">Drawing:</span>
            <button
              onClick={() => setDrawMode((d) => !d)}
              className={`rounded-md px-2 py-1 text-xs font-semibold ${
                drawMode ? "bg-accent text-white" : "border border-edge text-muted hover:text-foreground"
              }`}
            >
              {drawMode ? "✏ Drawing on — click chart to add level" : "✏ Draw level"}
            </button>
            {drawings.length > 0 && (
              <>
                <span className="text-xs text-muted">
                  {drawings.length} manual level{drawings.length > 1 ? "s" : ""}
                </span>
                <button
                  onClick={() => setDrawings(clearDrawings(symbol))}
                  className="text-xs text-bear hover:underline"
                >
                  Clear
                </button>
              </>
            )}
            <span className="ml-auto text-[10px] text-muted">Levels saved per symbol in this browser</span>
          </div>
          <PriceChart
            candles={liveCandles}
            levels={levels}
            zones={zones}
            drawMode={drawMode}
            onPriceClick={onPriceClick}
          />

          <MtfDashboard symbol={symbol} />

          {/* AI analysis */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">AI Analysis</h2>
              <button
                onClick={runAi}
                disabled={aiLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {aiLoading ? "Thinking…" : ai ? "Refresh analysis" : "Run AI analysis"}
              </button>
            </div>
            {aiError && <p className="mt-3 text-sm text-bear">{aiError}</p>}
            {ai ? (
              <div className="mt-3 grid gap-3 text-sm md:grid-cols-2">
                <Field label="Thesis" value={ai.thesis} wide />
                <Field label="Bull case" value={ai.bullCase} />
                <Field label="Bear case" value={ai.bearCase} />
                <Field label="Key levels" value={ai.keyLevels} />
                <Field label="Macro context" value={ai.macroContext} />
                <Field label="Risk notes" value={ai.riskNotes} wide />
              </div>
            ) : (
              !aiError && (
                <p className="mt-3 text-sm text-muted">
                  Claude synthesizes the detected structures, multi-timeframe trend and the macro calendar into a thesis
                  with bull/bear scenarios and invalidation levels.
                </p>
              )
            )}
          </section>

          <AiChat symbol={symbol} tf={tf} />
        </div>

        <div className="space-y-4">
          {/* Detected setups */}
          <section>
            <h2 className="mb-2 font-semibold">Scored Setups</h2>
            {opportunities.length === 0 ? (
              <p className="text-sm text-muted">No qualifying confluence setups on this timeframe.</p>
            ) : (
              <div className="space-y-3">
                {opportunities.map((opp, i) => (
                  <div
                    key={i}
                    onClick={() => setSelectedOpp(opp)}
                    className={`cursor-pointer rounded-lg ${selectedOpp === opp ? "ring-1 ring-accent" : ""}`}
                  >
                    <OpportunityCard opp={opp} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Structures summary */}
          {analysis && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm">
              <h2 className="mb-2 font-semibold">Detected Structure</h2>
              <ul className="space-y-1 text-muted">
                <li>Unfilled FVGs: {analysis.fvgs.filter((g) => !g.filled).length}</li>
                <li>Active order blocks: {analysis.orderBlocks.filter((b) => !b.mitigated).length}</li>
                <li>Liquidity sweeps: {analysis.liquiditySweeps.length}</li>
                {analysis.structureBreaks.length > 0 && (
                  <li>
                    Last structure: {analysis.structureBreaks[analysis.structureBreaks.length - 1].type.toUpperCase()}{" "}
                    {analysis.structureBreaks[analysis.structureBreaks.length - 1].direction} @{" "}
                    {fmtPrice(analysis.structureBreaks[analysis.structureBreaks.length - 1].brokenLevel)}
                  </li>
                )}
                {analysis.anchoredVwap && (
                  <li>
                    AVWAP ({analysis.anchoredVwap.anchorType.replace("_", " ")}): {fmtPrice(analysis.anchoredVwap.value)}
                  </li>
                )}
                {analysis.sessionLevels.sessions.map((s) => (
                  <li key={s.name}>
                    {s.name === "newyork" ? "New York" : s.name.charAt(0).toUpperCase() + s.name.slice(1)} session:{" "}
                    {fmtPrice(s.low)}–{fmtPrice(s.high)}
                  </li>
                ))}
                <li>
                  Volume profile: POC {fmtPrice(analysis.volumeProfile.poc)} · VA {fmtPrice(analysis.volumeProfile.val)}–
                  {fmtPrice(analysis.volumeProfile.vah)}
                </li>
                <li>RSI(14): {analysis.trend.rsi14?.toFixed(1) ?? "—"}</li>
                {analysis.higherTimeframeTrend && (
                  <li>
                    HTF ({analysis.higherTimeframeTrend.timeframe}): {analysis.higherTimeframeTrend.direction}
                  </li>
                )}
              </ul>
            </section>
          )}

          {/* Trade plan */}
          <TradePlanBuilder
            defaults={
              selectedOpp
                ? { entry: selectedOpp.entry, stopLoss: selectedOpp.stopLoss, takeProfit: selectedOpp.takeProfit }
                : analysis
                  ? { entry: analysis.lastPrice, stopLoss: analysis.lastPrice * 0.98, takeProfit: analysis.lastPrice * 1.04 }
                  : undefined
            }
            journal={{
              symbol,
              timeframe: tf,
              strategyName: selectedOpp ? "Built-in confluence" : "",
              snapshot: analysis
                ? {
                    trendDirection: analysis.trend.direction,
                    htfDirection: analysis.higherTimeframeTrend?.direction,
                    rsi14: analysis.trend.rsi14,
                    confluenceScore: selectedOpp?.score ?? null,
                    factors: selectedOpp?.factors ?? [],
                  }
                : null,
            }}
          />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "md:col-span-2" : undefined}>
      <div className="text-xs font-semibold uppercase text-muted">{label}</div>
      <p>{value}</p>
    </div>
  );
}
