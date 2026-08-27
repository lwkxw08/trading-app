"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import AiChat from "@/components/AiChat";
import OpportunityCard, { FavoriteStar } from "@/components/OpportunityCard";
import { apiUrl } from "@/components/api";
import PriceChart, { type LevelLine, type ProfileOverlay, type SetupOverlay, type ZoneBox } from "@/components/PriceChart";
import TradePlanBuilder from "@/components/TradePlanBuilder";
import MtfDashboard from "@/components/MtfDashboard";
import { useLiveKline } from "@/components/useLiveMarket";
import { fmtPrice, timeAgo } from "@/components/format";
import type { AiAnalysis } from "@/lib/ai/analyze";
import { buildPatternMemory } from "@/lib/ai/memory";
import { loadSignals } from "@/lib/signals/store";
import { addDrawing, clearDrawings, loadDrawings } from "@/lib/drawings/store";
import { loadTrades, saveTrades } from "@/lib/journal/store";
import type { JournalTrade } from "@/lib/journal/types";
import { TIMEFRAMES, type Candle, type Timeframe } from "@/lib/market/types";
import type { NewsHeadline } from "@/lib/news/provider";
import type { CustomEvaluation } from "@/lib/strategies/custom";
import { REGIME_LABELS } from "@/lib/strategies/regime";
import { loadSavedStrategies, type SavedStrategy } from "@/lib/strategies/savedStore";
import { TREND_BREAK_STRATEGY_NAME, type TrendBreakSetup } from "@/lib/strategies/trendBreak";
import { SESSION_OPEN_STRATEGY_NAME, type SessionOpenSetup } from "@/lib/strategies/sessionOpen";
import type { HvnFvgPullback, Opportunity, StrategyAnalysis } from "@/lib/strategies/types";

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

const VP_BAR_OPTIONS = [50, 100, 200, 500] as const;

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
  const [vpBars, setVpBars] = useState<number>(200);
  const [selectedSetup, setSelectedSetup] = useState<HvnFvgPullback | null>(null);
  const [loggedSetups, setLoggedSetups] = useState<Set<string>>(new Set());
  const [tbSetup, setTbSetup] = useState<TrendBreakSetup | null>(null);
  const [tbSelected, setTbSelected] = useState(false);
  const [tbLogged, setTbLogged] = useState(false);
  const [soSetup, setSoSetup] = useState<SessionOpenSetup | null>(null);
  const [soLogged, setSoLogged] = useState(false);
  const [drawMode, setDrawMode] = useState(false);
  const [drawings, setDrawings] = useState<number[]>([]);
  const [news, setNews] = useState<NewsHeadline[]>([]);
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>([]);
  const [stratId, setStratId] = useState("");
  const [stratEvals, setStratEvals] = useState<CustomEvaluation[] | null>(null);
  const [stratLoading, setStratLoading] = useState(false);
  const [stratError, setStratError] = useState<string | null>(null);

  useEffect(() => {
    setSavedStrategies(loadSavedStrategies());
  }, []);

  useEffect(() => {
    setStratEvals(null);
    setStratError(null);
  }, [symbol, tf]);

  const runStrategyEval = useCallback(() => {
    const saved = savedStrategies.find((s) => s.id === stratId);
    if (!saved) return;
    setStratLoading(true);
    setStratError(null);
    setStratEvals(null);
    fetch(apiUrl("/api/strategy/eval"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, tf, strategy: saved.strategy }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "evaluation failed");
        setStratEvals(d.evaluations);
      })
      .catch((e) => setStratError(e.message))
      .finally(() => setStratLoading(false));
  }, [symbol, tf, savedStrategies, stratId]);

  useEffect(() => {
    setNews([]);
    fetch(apiUrl(`/api/news?symbol=${symbol}`))
      .then((r) => r.json())
      .then((d) => setNews(Array.isArray(d.headlines) ? d.headlines : []))
      .catch(() => {});
  }, [symbol]);

  useEffect(() => {
    setDrawings(loadDrawings(symbol));
    setDrawMode(false);
  }, [symbol]);

  useEffect(() => {
    setTbSetup(null);
    setTbSelected(false);
    setTbLogged(false);
    const load = () =>
      fetch(apiUrl(`/api/setups/trendbreak?symbol=${symbol}`))
        .then((r) => r.json())
        .then((d) => setTbSetup(d.setup ?? null))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [symbol]);

  useEffect(() => {
    setSoSetup(null);
    setSoLogged(false);
    const load = () =>
      fetch(apiUrl(`/api/setups/sessionopen?symbol=${symbol}`))
        .then((r) => r.json())
        .then((d) => setSoSetup(d.setup ?? null))
        .catch(() => {});
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [symbol]);

  const onPriceClick = useCallback(
    (price: number) => setDrawings(addDrawing(symbol, price)),
    [symbol],
  );

  const logTbToJournal = useCallback(
    (s: TrendBreakSetup) => {
      if (s.entry === null || s.stopLoss === null || s.takeProfit === null) return;
      const trade: JournalTrade = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        timeframe: "1m",
        direction: s.direction === "bullish" ? "long" : "short",
        status: "open",
        entryPrice: s.entry,
        entryTime: Date.now(),
        size: null,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        strategyName: TREND_BREAK_STRATEGY_NAME,
        notes: `Logged from analysis card · ${s.bosCount} BoS ${s.priorTrend} 15m run · trendline break + CHoCH · 1m FVG midpoint entry ${fmtPrice(s.entry)}`,
        snapshot: analysis
          ? {
              trendDirection: analysis.trend.direction,
              htfDirection: analysis.higherTimeframeTrend?.direction,
              rsi14: analysis.trend.rsi14,
              confluenceScore: null,
              factors: [],
            }
          : null,
        exitPrice: null,
        exitTime: null,
        exitNotes: "",
      };
      saveTrades([trade, ...loadTrades()]);
      setTbLogged(true);
    },
    [symbol, analysis],
  );

  const logSoToJournal = useCallback(
    (s: SessionOpenSetup) => {
      if (s.entry === null || s.stopLoss === null || s.takeProfit === null || s.direction === null) return;
      const trade: JournalTrade = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        timeframe: "5m",
        direction: s.direction === "bullish" ? "long" : "short",
        status: "open",
        entryPrice: s.entry,
        entryTime: Date.now(),
        size: null,
        stopLoss: s.stopLoss,
        takeProfit: s.takeProfit,
        strategyName: SESSION_OPEN_STRATEGY_NAME,
        notes: `Logged from analysis card · ${s.session} · opening range ${fmtPrice(s.rangeLow ?? 0)}–${fmtPrice(s.rangeHigh ?? 0)} · boundary entry ${fmtPrice(s.entry)}`,
        snapshot: analysis
          ? {
              trendDirection: analysis.trend.direction,
              htfDirection: analysis.higherTimeframeTrend?.direction,
              rsi14: analysis.trend.rsi14,
              confluenceScore: null,
              factors: [],
            }
          : null,
        exitPrice: null,
        exitTime: null,
        exitNotes: "",
      };
      saveTrades([trade, ...loadTrades()]);
      setSoLogged(true);
    },
    [symbol, analysis],
  );

  const logSetupToJournal = useCallback(
    (s: HvnFvgPullback, key: string) => {
      const bull = s.direction === "bullish";
      const trade: JournalTrade = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        symbol,
        timeframe: tf,
        direction: bull ? "long" : "short",
        status: "open",
        entryPrice: bull ? s.zoneTop : s.zoneBottom,
        entryTime: Date.now(),
        size: null,
        stopLoss: s.stopLoss,
        takeProfit: s.target,
        strategyName: "Impulse HVN + FVG pullback",
        notes: `Logged from analysis card · impulse ${fmtPrice(s.impulseStart)} → ${fmtPrice(s.impulseEnd)} · zone ${fmtPrice(s.zoneBottom)}–${fmtPrice(s.zoneTop)}`,
        snapshot: analysis
          ? {
              trendDirection: analysis.trend.direction,
              htfDirection: analysis.higherTimeframeTrend?.direction,
              rsi14: analysis.trend.rsi14,
              confluenceScore: null,
              factors: [],
            }
          : null,
        exitPrice: null,
        exitTime: null,
        exitNotes: "",
      };
      saveTrades([trade, ...loadTrades()]);
      setLoggedSetups((cur) => new Set(cur).add(key));
    },
    [symbol, tf, analysis],
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
    setSelectedSetup(null);
    setLoggedSetups(new Set());
    fetch(apiUrl(`/api/klines?symbol=${symbol}&tf=${tf}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "failed to load candles");
        setCandles(d.candles);
      })
      .catch((e) => setError(e.message));
    fetch(apiUrl(`/api/analysis?symbol=${symbol}&tf=${tf}&vpBars=${vpBars}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "analysis failed");
        setAnalysis(d.analysis);
        setOpportunities(d.opportunities);
        setSelectedOpp(d.opportunities[0] ?? null);
      })
      .catch((e) => setError(e.message));
  }, [symbol, tf, vpBars]);

  const runAi = useCallback(() => {
    setAiLoading(true);
    setAiError(null);
    const memory = buildPatternMemory(loadSignals(), loadTrades(), symbol, tf);
    fetch(apiUrl("/api/ai/analyze"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, tf, memory }),
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
      for (const nd of analysis.volumeProfile.hvns) {
        if (Math.abs(nd.price - analysis.volumeProfile.poc) < 1e-9) continue;
        out.push({ price: nd.price, color: "#f59e0b99", title: "HVN" });
      }
      for (const nd of analysis.volumeProfile.lvns) {
        out.push({ price: nd.price, color: "#64748b99", title: "LVN", dashed: true });
      }
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

  const profile = useMemo<ProfileOverlay | null>(() => {
    if (!analysis || !layers.volumeProfile) return null;
    const vp = analysis.volumeProfile;
    return { bins: vp.bins, poc: vp.poc, vah: vp.vah, val: vp.val };
  }, [analysis, layers.volumeProfile]);

  const setupOverlay = useMemo<SetupOverlay | null>(() => {
    if (tbSelected && tbSetup && tbSetup.fvg && tbSetup.entry !== null && tbSetup.stopLoss !== null && tbSetup.takeProfit !== null) {
      return {
        direction: tbSetup.direction,
        impulseFromTime: tbSetup.trendline.fromTime,
        impulseFromPrice: tbSetup.trendline.fromPrice,
        impulseToTime: tbSetup.breakTime,
        impulseToPrice: tbSetup.breakPrice,
        zoneTop: tbSetup.fvg.top,
        zoneBottom: tbSetup.fvg.bottom,
        zoneFrom: tbSetup.fvg.time,
        target: tbSetup.takeProfit,
        stopLoss: tbSetup.stopLoss,
        entry: tbSetup.entry,
        lineLabel: "15m trendline",
        zoneLabel: "1m FVG · entry at midpoint",
      };
    }
    if (!selectedSetup) return null;
    return {
      direction: selectedSetup.direction,
      impulseFromTime: selectedSetup.impulseStartTime,
      impulseFromPrice: selectedSetup.impulseStart,
      impulseToTime: selectedSetup.impulseEndTime,
      impulseToPrice: selectedSetup.impulseEnd,
      zoneTop: selectedSetup.zoneTop,
      zoneBottom: selectedSetup.zoneBottom,
      zoneFrom: selectedSetup.impulseEndTime,
      target: selectedSetup.target,
      stopLoss: selectedSetup.stopLoss,
    };
  }, [selectedSetup, tbSelected, tbSetup]);

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
          {analysis && (
            <span
              title={analysis.regime.detail}
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                analysis.regime.regime === "trending_up"
                  ? "bg-bull/15 text-bull"
                  : analysis.regime.regime === "trending_down"
                    ? "bg-bear/15 text-bear"
                    : analysis.regime.regime === "volatile"
                      ? "bg-amber-500/15 text-amber-400"
                      : "bg-edge text-muted"
              }`}
            >
              {REGIME_LABELS[analysis.regime.regime]}
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
            <span className="ml-2 flex items-center gap-1 text-xs text-muted">
              VP lookback:
              {VP_BAR_OPTIONS.map((n) => (
                <button
                  key={n}
                  onClick={() => setVpBars(n)}
                  className={`rounded px-1.5 py-0.5 font-semibold ${
                    vpBars === n ? "bg-accent text-white" : "bg-background text-muted hover:text-foreground"
                  }`}
                >
                  {n}
                </button>
              ))}
              <span>bars</span>
            </span>
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
            profile={profile}
            setup={setupOverlay}
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

          {news.length > 0 && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <h2 className="font-semibold">Recent headlines</h2>
              <p className="mt-1 text-xs text-muted">News context for {symbol} — also fed to the AI analysis. Headlines are context, not signals.</p>
              <ul className="mt-3 space-y-2 text-sm">
                {news.slice(0, 6).map((h, i) => (
                  <li key={i} className="flex items-baseline gap-2">
                    <span className="shrink-0 text-[10px] text-muted">{timeAgo(h.publishedAt)}</span>
                    {h.url ? (
                      <a href={h.url} target="_blank" rel="noreferrer" className="hover:text-accent hover:underline">
                        {h.title}
                      </a>
                    ) : (
                      <span>{h.title}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
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

          {/* Impulse HVN+FVG pullback setups */}
          {analysis && analysis.hvnFvgPullbacks.filter((s) => s.state !== "invalidated").length > 0 && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm">
              <h2 className="mb-2 font-semibold">Impulse HVN + FVG Pullback</h2>
              <div className="space-y-2">
                {analysis.hvnFvgPullbacks
                  .filter((s) => s.state !== "invalidated")
                  .map((s) => (
                    <div
                      key={`${s.direction}-${s.impulseEndTime}`}
                      onClick={() => {
                        setTbSelected(false);
                        setSelectedSetup((cur) => (cur === s ? null : s));
                      }}
                      className={`cursor-pointer rounded-md border p-2 ${
                        selectedSetup === s ? "border-accent ring-1 ring-accent" : "border-edge hover:border-accent/50"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`font-semibold ${s.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                          {s.direction === "bullish" ? "BUY setup" : "SELL setup"}
                        </span>
                        <span className="text-xs text-muted">
                          {s.state === "bounced" ? "Bounced from zone" : s.state === "in_pullback" ? "Pulling back into zone" : "Awaiting pullback"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-muted">
                        Impulse {fmtPrice(s.impulseStart)} → {fmtPrice(s.impulseEnd)} · heavy node meets FVG at{" "}
                        {fmtPrice(s.zoneBottom)}–{fmtPrice(s.zoneTop)} · TP at next volume cluster {fmtPrice(s.target)} · SL{" "}
                        {fmtPrice(s.stopLoss)}
                      </p>
                      <p className="mt-1 text-[10px] text-accent">
                        {selectedSetup === s ? "Shown on chart — click to hide" : "Click to show on chart"}
                      </p>
                      <div className="mt-2 flex items-center gap-3">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            logSetupToJournal(s, `${s.direction}-${s.impulseEndTime}`);
                          }}
                          disabled={loggedSetups.has(`${s.direction}-${s.impulseEndTime}`)}
                          className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                        >
                          {loggedSetups.has(`${s.direction}-${s.impulseEndTime}`) ? "Logged to Journal" : "Log to Journal"}
                        </button>
                        {loggedSetups.has(`${s.direction}-${s.impulseEndTime}`) && (
                          <Link
                            href="/journal"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[11px] text-accent hover:underline"
                          >
                            View in Journal
                          </Link>
                        )}
                      </div>
                    </div>
                  ))}
              </div>
            </section>
          )}

          {/* 15m trend break → 1m FVG setup */}
          {tbSetup && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm">
              <h2 className="mb-2 font-semibold">{TREND_BREAK_STRATEGY_NAME}</h2>
              <div
                onClick={() => {
                  if (tbSetup.state === "invalidated" || !tbSetup.fvg) return;
                  setSelectedSetup(null);
                  setTbSelected((v) => !v);
                  if (tf !== "15m" && tf !== "1m") setTf("15m");
                }}
                className={`rounded-md border p-2 ${
                  tbSetup.state === "invalidated" || !tbSetup.fvg
                    ? "border-edge opacity-80"
                    : `cursor-pointer ${tbSelected ? "border-accent ring-1 ring-accent" : "border-edge hover:border-accent/50"}`
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className={`font-semibold ${tbSetup.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                    {tbSetup.direction === "bullish" ? "BUY setup" : "SELL setup"}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      tbSetup.state === "triggered"
                        ? "bg-bull/15 text-bull"
                        : tbSetup.state === "invalidated"
                          ? "bg-bear/15 text-bear"
                          : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    {tbSetup.state === "awaiting_pullback" ? "forming · entry known" : tbSetup.state.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  15m: {tbSetup.bosCount} BoS {tbSetup.priorTrend} run · trendline broken at {fmtPrice(tbSetup.breakPrice)} · CHoCH
                  confirmed · {tbSetup.stateDetail}
                </p>
                {tbSetup.entry !== null && tbSetup.stopLoss !== null && tbSetup.takeProfit !== null && (
                  <p className="mt-1 text-xs text-muted">
                    Entry (FVG midpoint) {fmtPrice(tbSetup.entry)} · SL {fmtPrice(tbSetup.stopLoss)} · TP (3R){" "}
                    {fmtPrice(tbSetup.takeProfit)}
                  </p>
                )}
                {tbSetup.state === "awaiting_pullback" && (
                  <p className="mt-1 text-[10px] font-semibold text-amber-400">
                    Actionable now — price has not pulled back yet; a limit order at the FVG midpoint captures the entry.
                  </p>
                )}
                {(tbSetup.state === "awaiting_choch" || tbSetup.state === "awaiting_fvg") && (
                  <p className="mt-1 text-[10px] text-amber-400">
                    Forming — updates automatically every minute as the 1m leg develops.
                  </p>
                )}
                {tbSetup.state !== "invalidated" && tbSetup.fvg && (
                  <p className="mt-1 text-[10px] text-accent">
                    {tbSelected ? "Shown on chart — click to hide" : "Click to show on chart (switches to 15m)"}
                  </p>
                )}
                {tbSetup.state !== "invalidated" && tbSetup.entry !== null && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        logTbToJournal(tbSetup);
                      }}
                      disabled={tbLogged}
                      className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {tbLogged ? "Logged to Journal" : "Log to Journal"}
                    </button>
                    {tbLogged && (
                      <Link href="/journal" onClick={(e) => e.stopPropagation()} className="text-[11px] text-accent hover:underline">
                        View in Journal
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Session open range setup */}
          {soSetup && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm">
              <h2 className="mb-2 font-semibold">{SESSION_OPEN_STRATEGY_NAME}</h2>
              <div className={`rounded-md border p-2 ${soSetup.state === "invalidated" ? "border-edge opacity-80" : "border-edge"}`}>
                <div className="flex items-center justify-between">
                  <span
                    className={`font-semibold ${
                      soSetup.direction === "bullish" ? "text-bull" : soSetup.direction === "bearish" ? "text-bear" : ""
                    }`}
                  >
                    {soSetup.direction === "bullish" ? "BUY setup" : soSetup.direction === "bearish" ? "SELL setup" : soSetup.session}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                      soSetup.state === "triggered"
                        ? "bg-bull/15 text-bull"
                        : soSetup.state === "invalidated"
                          ? "bg-bear/15 text-bear"
                          : "bg-amber-500/15 text-amber-400"
                    }`}
                  >
                    {soSetup.state === "awaiting_touch" ? "forming · entry known" : soSetup.state.replace(/_/g, " ")}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted">
                  {soSetup.session}
                  {soSetup.rangeHigh !== null && soSetup.rangeLow !== null
                    ? ` · opening hour range ${fmtPrice(soSetup.rangeLow)} – ${fmtPrice(soSetup.rangeHigh)}`
                    : ""}{" "}
                  · {soSetup.stateDetail}
                </p>
                {soSetup.signals.length > 0 && (
                  <p className="mt-1 text-xs text-muted">
                    {soSetup.signals.map((s) => `${s.name}: ${s.direction === "bullish" ? "↑" : "↓"} ${s.detail}`).join(" · ")}
                  </p>
                )}
                {soSetup.entry !== null && soSetup.stopLoss !== null && soSetup.takeProfit !== null && (
                  <p className="mt-1 text-xs text-muted">
                    Entry (range boundary) {fmtPrice(soSetup.entry)} · SL {fmtPrice(soSetup.stopLoss)} · TP (1× range span){" "}
                    {fmtPrice(soSetup.takeProfit)}
                  </p>
                )}
                {soSetup.state === "building_range" && (
                  <p className="mt-1 text-[10px] text-amber-400">
                    Forming — the first 60 minutes are still building the range; updates automatically every minute.
                  </p>
                )}
                {soSetup.state === "awaiting_touch" && (
                  <p className="mt-1 text-[10px] font-semibold text-amber-400">
                    Direction set — waiting for price to touch the {soSetup.direction === "bullish" ? "upper" : "lower"} range
                    boundary; a limit order at the boundary captures the entry.
                  </p>
                )}
                {soSetup.state !== "invalidated" && soSetup.entry !== null && (
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      onClick={() => logSoToJournal(soSetup)}
                      disabled={soLogged}
                      className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {soLogged ? "Logged to Journal" : "Log to Journal"}
                    </button>
                    {soLogged && (
                      <Link href="/journal" className="text-[11px] text-accent hover:underline">
                        View in Journal
                      </Link>
                    )}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* Saved strategy evaluation */}
          {savedStrategies.length > 0 && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm">
              <h2 className="mb-2 font-semibold">Your Strategies</h2>
              <p className="mb-2 text-xs text-muted">Evaluate a saved Strategy Lab strategy against {symbol} · {tf} alongside the built-in score.</p>
              <div className="flex gap-2">
                <select
                  value={stratId}
                  onChange={(e) => setStratId(e.target.value)}
                  className="min-w-0 flex-1 truncate rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none"
                >
                  <option value="">Select a saved strategy…</option>
                  {savedStrategies.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.strategy.name}
                    </option>
                  ))}
                </select>
                <button
                  onClick={runStrategyEval}
                  disabled={!stratId || stratLoading}
                  className="shrink-0 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  {stratLoading ? "Evaluating…" : "Evaluate"}
                </button>
              </div>
              {stratError && <p className="mt-2 text-xs text-bear">{stratError}</p>}
              {stratEvals && (
                <div className="mt-3 space-y-3">
                  {stratEvals.map((ev) => (
                    <div key={ev.direction} className="rounded-md border border-edge p-2">
                      <div className="flex items-center justify-between">
                        <span className={`font-semibold uppercase ${ev.direction === "long" ? "text-bull" : "text-bear"}`}>{ev.direction}</span>
                        <span className={`rounded px-2 py-0.5 text-xs font-bold ${ev.qualifies ? "bg-bull/15 text-bull" : "bg-background text-muted"}`}>
                          {ev.score}/100 {ev.qualifies ? "· qualifies" : "· below min score"}
                        </span>
                      </div>
                      <ul className="mt-1 space-y-0.5 text-xs">
                        {ev.factors.map((f, i) => (
                          <li key={i} className={f.met ? "" : "text-muted"}>
                            {f.met ? "✓" : "·"} {f.name} — {f.detail}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

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
                  Volume profile ({analysis.volumeProfile.lookback} bars): POC {fmtPrice(analysis.volumeProfile.poc)} · VA{" "}
                  {fmtPrice(analysis.volumeProfile.val)}–{fmtPrice(analysis.volumeProfile.vah)}
                </li>
                {analysis.volumeProfile.hvns.length > 0 && (
                  <li>HVNs: {analysis.volumeProfile.hvns.map((nd) => fmtPrice(nd.price)).join(", ")}</li>
                )}
                {analysis.volumeProfile.lvns.length > 0 && (
                  <li>LVNs: {analysis.volumeProfile.lvns.map((nd) => fmtPrice(nd.price)).join(", ")}</li>
                )}
                <li>RSI(14): {analysis.trend.rsi14?.toFixed(1) ?? "—"}</li>
                <li>
                  Regime: {REGIME_LABELS[analysis.regime.regime]}
                  {analysis.regime.adx14 !== null && ` · ADX ${analysis.regime.adx14.toFixed(0)}`}
                </li>
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
