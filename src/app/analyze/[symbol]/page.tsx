"use client";

import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import OpportunityCard from "@/components/OpportunityCard";
import { apiUrl } from "@/components/api";
import PriceChart, { type LevelLine } from "@/components/PriceChart";
import TradePlanBuilder from "@/components/TradePlanBuilder";
import { fmtPrice } from "@/components/format";
import type { AiAnalysis } from "@/lib/ai/analyze";
import { TIMEFRAMES, type Candle, type Timeframe } from "@/lib/market/types";
import type { Opportunity, StrategyAnalysis } from "@/lib/strategies/types";

type AnalysisPayload = Omit<StrategyAnalysis, "candles">;

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
    const out: LevelLine[] = [
      { price: analysis.volumeProfile.poc, color: "#eab308", title: "POC" },
      { price: analysis.volumeProfile.vah, color: "#eab30880", title: "VAH", dashed: true },
      { price: analysis.volumeProfile.val, color: "#eab30880", title: "VAL", dashed: true },
    ];
    for (const g of analysis.fvgs.filter((g) => !g.filled).slice(-3)) {
      const color = g.direction === "bullish" ? "#22c55e" : "#ef4444";
      out.push({ price: g.top, color, title: `FVG ${g.direction} top`, dashed: true });
      out.push({ price: g.bottom, color, title: `FVG ${g.direction} btm`, dashed: true });
    }
    for (const b of analysis.orderBlocks.filter((b) => !b.mitigated).slice(-2)) {
      const color = b.direction === "bullish" ? "#14b8a6" : "#f97316";
      out.push({ price: b.direction === "bullish" ? b.top : b.bottom, color, title: `OB ${b.direction}`, dashed: true });
    }
    if (analysis.anchoredVwap) {
      out.push({ price: analysis.anchoredVwap.value, color: "#a855f7", title: "AVWAP", dashed: true });
    }
    for (const s of analysis.sessionLevels.sessions) {
      out.push({ price: s.high, color: "#64748b", title: `${s.name} H`, dashed: true });
      out.push({ price: s.low, color: "#64748b", title: `${s.name} L`, dashed: true });
    }
    if (selectedOpp) {
      out.push({ price: selectedOpp.entry, color: "#4f8cff", title: "Entry" });
      out.push({ price: selectedOpp.stopLoss, color: "#ef4444", title: "SL" });
      out.push({ price: selectedOpp.takeProfit, color: "#22c55e", title: "TP" });
    }
    return out;
  }, [analysis, selectedOpp]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-xl font-bold">{symbol}</h1>
          {analysis && <span className="font-mono text-lg">{fmtPrice(analysis.lastPrice)}</span>}
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
          <PriceChart candles={candles} levels={levels} />

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
