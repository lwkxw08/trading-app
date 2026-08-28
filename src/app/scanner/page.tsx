"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import OpportunityCard from "@/components/OpportunityCard";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { MARKETS, MARKET_LABELS, type Market } from "@/lib/market/universe";
import { loadRules, saveRules } from "@/lib/alerts/store";
import type { SetupRule } from "@/lib/alerts/types";
import { captureSignals, loadSignals, saveSignals } from "@/lib/signals/store";
import { loadSavedStrategies, type SavedStrategy } from "@/lib/strategies/savedStore";
import { TREND_BREAK_STRATEGY_NAME, type TrendBreakWatch } from "@/lib/strategies/trendBreak";
import { SESSION_OPEN_STRATEGY_NAME, type SessionOpenWatch } from "@/lib/strategies/sessionOpen";
import { PULLBACK_VALUE_STRATEGY_NAME, type PullbackValueWatch } from "@/lib/strategies/pullbackValue";
import { STOCH_REVERSAL_STRATEGY_NAME, type StochReversalWatch } from "@/lib/strategies/stochReversal";
import type { Opportunity } from "@/lib/strategies/types";

const TREND_BREAK_ID = "__trendbreak";
const SESSION_OPEN_ID = "__sessionopen";
const PULLBACK_VALUE_ID = "__pullbackvalue";
const STOCH_REVERSAL_ID = "__stochreversal";

function oppKey(opp: Opportunity): string {
  return `${opp.symbol}-${opp.timeframe}-${opp.direction}-${opp.generatedAt}`;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

const NEAR_MISS_MARGIN = 15;

export default function Scanner() {
  const [tf, setTf] = useState<Timeframe>("4h");
  const [market, setMarket] = useState<Market>("crypto");
  const [symbols, setSymbols] = useState("");
  const [direction, setDirection] = useState<"all" | "long" | "short">("all");
  const [minScore, setMinScore] = useState(40);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [watching, setWatching] = useState<TrendBreakWatch[]>([]);
  const [soWatching, setSoWatching] = useState<SessionOpenWatch[]>([]);
  const [pvWatching, setPvWatching] = useState<PullbackValueWatch[]>([]);
  const [srWatching, setSrWatching] = useState<StochReversalWatch[]>([]);
  const [alerted, setAlerted] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<{ scanned: number; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [track, setTrack] = useState(false);
  const [tracked, setTracked] = useState<number | null>(null);
  const [addedSignals, setAddedSignals] = useState<Set<string>>(new Set());
  const [scanStrategyName, setScanStrategyName] = useState("Built-in confluence");
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>([]);
  const [strategyId, setStrategyId] = useState("");

  useEffect(() => {
    setSavedStrategies(loadSavedStrategies());
  }, []);

  const scan = useCallback(() => {
    setLoading(true);
    setTracked(null);
    setAddedSignals(new Set());
    setAlerted(new Set());
    const saved = savedStrategies.find((s) => s.id === strategyId) ?? null;
    const trendBreak = strategyId === TREND_BREAK_ID;
    const sessionOpen = strategyId === SESSION_OPEN_ID;
    const pullbackValue = strategyId === PULLBACK_VALUE_ID;
    const stochReversal = strategyId === STOCH_REVERSAL_ID;
    const strategyName = trendBreak
      ? TREND_BREAK_STRATEGY_NAME
      : sessionOpen
        ? SESSION_OPEN_STRATEGY_NAME
        : pullbackValue
          ? PULLBACK_VALUE_STRATEGY_NAME
          : stochReversal
            ? STOCH_REVERSAL_STRATEGY_NAME
            : saved
              ? saved.strategy.name
              : "Built-in confluence";
    setScanStrategyName(strategyName);
    const request = saved
      ? fetch(apiUrl("/api/scan"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tf, market, symbols: symbols.trim() || undefined, strategy: saved.strategy }),
        })
      : fetch(
          apiUrl(
            `/api/scan?${new URLSearchParams({ tf, market, ...(symbols.trim() ? { symbols: symbols.trim() } : {}), ...(trendBreak ? { setup: "trendbreak" } : {}), ...(sessionOpen ? { setup: "sessionopen" } : {}), ...(pullbackValue ? { setup: "pullbackvalue" } : {}), ...(stochReversal ? { setup: "stochreversal" } : {}) })}`,
          ),
        );
    request
      .then((r) => r.json())
      .then((d) => {
        const opps: Opportunity[] = d.opportunities ?? [];
        setOpportunities(opps);
        setWatching(trendBreak ? (d.watching ?? []) : []);
        setSoWatching(sessionOpen ? (d.watching ?? []) : []);
        setPvWatching(pullbackValue ? (d.watching ?? []) : []);
        setSrWatching(stochReversal ? (d.watching ?? []) : []);
        setMeta({ scanned: d.scanned ?? 0, errors: d.errors ?? 0 });
        if (track) {
          const qualifying = opps.filter((o) => o.score >= minScore && (direction === "all" || o.direction === direction));
          const { signals, added } = captureSignals(loadSignals(), qualifying, strategyName);
          if (added > 0) saveSignals(signals);
          setTracked(added);
          setAddedSignals(new Set(qualifying.map(oppKey)));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tf, market, symbols, track, minScore, direction, savedStrategies, strategyId]);

  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = opportunities.filter(
    (o) => o.score >= minScore && (direction === "all" || o.direction === direction),
  );

  const trendBreak = scanStrategyName === TREND_BREAK_STRATEGY_NAME;
  const sessionOpenScan = scanStrategyName === SESSION_OPEN_STRATEGY_NAME;
  const pullbackValueScan = scanStrategyName === PULLBACK_VALUE_STRATEGY_NAME;
  const stochReversalScan = scanStrategyName === STOCH_REVERSAL_STRATEGY_NAME;
  const builtIn = scanStrategyName === "Built-in confluence";
  const nearMisses = trendBreak || sessionOpenScan || pullbackValueScan || stochReversalScan
    ? []
    : opportunities.filter(
        (o) => o.score < minScore && o.score >= minScore - NEAR_MISS_MARGIN && (direction === "all" || o.direction === direction),
      );
  const watchList = trendBreak
    ? watching.filter((w) => direction === "all" || (w.direction === "bullish" ? "long" : "short") === direction)
    : [];

  const addAlert = useCallback((rule: SetupRule, key: string) => {
    saveRules([rule, ...loadRules()]);
    setAlerted((cur) => new Set(cur).add(key));
  }, []);

  const alertForWatch = useCallback(
    (w: TrendBreakWatch) => {
      addAlert(
        {
          id: uid(),
          type: "setup",
          enabled: true,
          symbols: w.symbol,
          tf: "1m",
          direction: w.direction === "bullish" ? "long" : "short",
          minScore: 70,
          setup: "trendbreak",
          cooldownMin: 30,
          lastFired: {},
        },
        `tb-${w.symbol}-${w.direction}`,
      );
    },
    [addAlert],
  );

  const alertForSessionWatch = useCallback(
    (w: SessionOpenWatch) => {
      addAlert(
        {
          id: uid(),
          type: "setup",
          enabled: true,
          symbols: w.symbol,
          tf: "5m",
          direction: "both",
          minScore: 70,
          setup: "sessionopen",
          cooldownMin: 60,
          lastFired: {},
        },
        `so-${w.symbol}`,
      );
    },
    [addAlert],
  );

  const alertForPullbackWatch = useCallback(
    (w: PullbackValueWatch) => {
      addAlert(
        {
          id: uid(),
          type: "setup",
          enabled: true,
          symbols: w.symbol,
          tf: w.timeframe,
          direction: w.direction === null ? "both" : w.direction === "bullish" ? "long" : "short",
          minScore: 70,
          setup: "pullbackvalue",
          cooldownMin: 60,
          lastFired: {},
        },
        `pv-${w.symbol}`,
      );
    },
    [addAlert],
  );

  const alertForStochWatch = useCallback(
    (w: StochReversalWatch) => {
      addAlert(
        {
          id: uid(),
          type: "setup",
          enabled: true,
          symbols: w.symbol,
          tf: w.timeframe,
          direction: w.direction === null ? "both" : w.direction === "bullish" ? "long" : "short",
          minScore: 70,
          setup: "stochreversal",
          cooldownMin: 60,
          lastFired: {},
        },
        `sr-${w.symbol}`,
      );
    },
    [addAlert],
  );

  const alertForNearMiss = useCallback(
    (o: Opportunity) => {
      addAlert(
        {
          id: uid(),
          type: "setup",
          enabled: true,
          symbols: o.symbol,
          tf,
          direction: o.direction,
          minScore,
          cooldownMin: 240,
          lastFired: {},
        },
        oppKey(o),
      );
    },
    [addAlert, tf, minScore],
  );

  const addToSignals = useCallback(
    (opp: Opportunity) => {
      const { signals, added } = captureSignals(loadSignals(), [opp], scanStrategyName);
      if (added > 0) saveSignals(signals);
      setAddedSignals((cur) => new Set(cur).add(oppKey(opp)));
    },
    [scanStrategyName],
  );

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Opportunity Scanner</h1>
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-edge bg-surface p-4">
        <label className="block text-sm">
          <span className="text-xs text-muted">Market</span>
          <div className="mt-1 flex gap-1">
            {MARKETS.map((m) => (
              <button
                key={m}
                onClick={() => setMarket(m)}
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  m === market ? "bg-accent text-white" : "bg-background text-muted hover:text-foreground"
                }`}
              >
                {MARKET_LABELS[m]}
              </button>
            ))}
          </div>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-muted">Timeframe</span>
          <div className="mt-1 flex gap-1">
            {TIMEFRAMES.map((t) => (
              <button
                key={t}
                onClick={() => setTf(t)}
                className={`rounded px-2 py-1 text-xs font-semibold ${
                  t === tf ? "bg-accent text-white" : "bg-background text-muted hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </label>
        <label className="block flex-1 text-sm">
          <span className="text-xs text-muted">Symbols (comma-separated, blank = default universe)</span>
          <div className="mt-1 [&>div]:w-full">
            <SymbolInput
              value={symbols}
              onChange={setSymbols}
              multi
              placeholder="BTCUSDT, AAPL, EURUSD…"
              className="w-full rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </div>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-muted">Strategy</span>
          <select
            value={strategyId}
            onChange={(e) => setStrategyId(e.target.value)}
            className="mt-1 block max-w-44 truncate rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none"
          >
            <option value="">Built-in confluence</option>
            <option value={TREND_BREAK_ID}>{TREND_BREAK_STRATEGY_NAME}</option>
            <option value={SESSION_OPEN_ID}>{SESSION_OPEN_STRATEGY_NAME}</option>
            <option value={PULLBACK_VALUE_ID}>{PULLBACK_VALUE_STRATEGY_NAME}</option>
            <option value={STOCH_REVERSAL_ID}>{STOCH_REVERSAL_STRATEGY_NAME}</option>
            {savedStrategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.strategy.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-muted">Direction</span>
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as typeof direction)}
            className="mt-1 block rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none"
          >
            <option value="all">All</option>
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
        <label className="block text-sm">
          <span className="text-xs text-muted">Min score: {minScore}</span>
          <input
            type="range"
            min={strategyId ? 0 : 40}
            max={90}
            value={minScore}
            onChange={(e) => setMinScore(Number(e.target.value))}
            className="mt-2 block w-32"
          />
        </label>
        <label className="flex cursor-pointer items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} className="accent-[var(--accent)]" />
          <span className="text-xs text-muted">Track signals</span>
        </label>
        <button
          onClick={scan}
          disabled={loading}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {loading ? "Scanning…" : "Scan"}
        </button>
      </div>

      {meta && (
        <p className="text-xs text-muted">
          Scanned {meta.scanned} instruments{meta.errors > 0 ? ` (${meta.errors} failed)` : ""} · {filtered.length} setups
          shown
          {tracked !== null && (
            <>
              {" "}· {tracked} new signal{tracked === 1 ? "" : "s"} logged to <Link href="/signals" className="underline hover:text-foreground">Signal Tracking</Link>
            </>
          )}
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {filtered.map((opp, i) => (
          <div key={`${opp.symbol}-${opp.direction}-${i}`} className="flex flex-col gap-1.5">
            <OpportunityCard opp={opp} />
            <button
              onClick={() => addToSignals(opp)}
              disabled={addedSignals.has(oppKey(opp))}
              className="self-start rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
            >
              {addedSignals.has(oppKey(opp)) ? "✓ Tracked in Signals" : "+ Add to Signals"}
            </button>
          </div>
        ))}
      </div>
      {!loading && filtered.length === 0 && (
        <p className="text-sm text-muted">No setups match the current filters.</p>
      )}

      {(watchList.length > 0 || soWatching.length > 0 || pvWatching.length > 0 || srWatching.length > 0 || nearMisses.length > 0) && (
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold">Developing setups · watch</h2>
            <p className="text-xs text-muted">
              Not actionable yet — forming setups and near-misses ({NEAR_MISS_MARGIN} points below min score). “Alert when
              ready” creates a rule on the <Link href="/alerts" className="underline hover:text-foreground">Alerts</Link> page
              (start monitoring there to be notified).
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {watchList.map((w) => {
              const key = `tb-${w.symbol}-${w.direction}`;
              return (
                <div key={key} className="rounded-lg border border-amber-500/40 bg-surface p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{w.symbol}</span>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                      {w.state.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-accent">{TREND_BREAK_STRATEGY_NAME}</p>
                  <p className={`mt-1 text-xs font-semibold ${w.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                    {w.direction === "bullish" ? "Bullish" : "Bearish"} · 15m break confirmed ({w.bosCount} BoS {w.priorTrend} run)
                  </p>
                  <p className="mt-1 text-xs text-muted">{w.stateDetail}</p>
                  <button
                    onClick={() => alertForWatch(w)}
                    disabled={alerted.has(key)}
                    className="mt-2 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
                  >
                    {alerted.has(key) ? "✓ Alert created" : "Alert when ready"}
                  </button>
                </div>
              );
            })}
            {soWatching.map((w) => {
              const key = `so-${w.symbol}`;
              return (
                <div key={key} className="rounded-lg border border-amber-500/40 bg-surface p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{w.symbol}</span>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                      {w.state.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-accent">{SESSION_OPEN_STRATEGY_NAME}</p>
                  <p className="mt-1 text-xs font-semibold">
                    {w.session}
                    {w.rangeHigh !== null && w.rangeLow !== null ? ` · range so far ${w.rangeLow} – ${w.rangeHigh}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">{w.stateDetail}</p>
                  <button
                    onClick={() => alertForSessionWatch(w)}
                    disabled={alerted.has(key)}
                    className="mt-2 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
                  >
                    {alerted.has(key) ? "✓ Alert created" : "Alert when ready"}
                  </button>
                </div>
              );
            })}
            {pvWatching.map((w) => {
              const key = `pv-${w.symbol}`;
              return (
                <div key={key} className="rounded-lg border border-amber-500/40 bg-surface p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{w.symbol}</span>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                      {w.state.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-accent">{PULLBACK_VALUE_STRATEGY_NAME}</p>
                  <p className={`mt-1 text-xs font-semibold ${w.direction === "bullish" ? "text-bull" : w.direction === "bearish" ? "text-bear" : ""}`}>
                    {w.direction === "bullish" ? "Bullish" : w.direction === "bearish" ? "Bearish" : "Direction pending"}
                    {w.zoneTop !== null && w.zoneBottom !== null ? ` · value zone ${w.zoneBottom.toFixed(2)} – ${w.zoneTop.toFixed(2)}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">{w.stateDetail}</p>
                  <button
                    onClick={() => alertForPullbackWatch(w)}
                    disabled={alerted.has(key)}
                    className="mt-2 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
                  >
                    {alerted.has(key) ? "✓ Alert created" : "Alert when ready"}
                  </button>
                </div>
              );
            })}
            {srWatching.map((w) => {
              const key = `sr-${w.symbol}`;
              return (
                <div key={key} className="rounded-lg border border-amber-500/40 bg-surface p-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{w.symbol}</span>
                    <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                      {w.state.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-accent">{STOCH_REVERSAL_STRATEGY_NAME}</p>
                  <p className={`mt-1 text-xs font-semibold ${w.direction === "bullish" ? "text-bull" : w.direction === "bearish" ? "text-bear" : ""}`}>
                    {w.pattern === "double_top" ? "Double top" : "Double bottom"}
                    {w.stochAtSecond !== null ? ` · stoch ${w.stochAtSecond.toFixed(0)}` : ""}
                    {w.neckline !== null ? ` · neckline ${w.neckline.toFixed(2)}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-muted">{w.stateDetail}</p>
                  <button
                    onClick={() => alertForStochWatch(w)}
                    disabled={alerted.has(key)}
                    className="mt-2 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
                  >
                    {alerted.has(key) ? "✓ Alert created" : "Alert when ready"}
                  </button>
                </div>
              );
            })}
            {nearMisses.map((opp, i) => (
              <div key={`${opp.symbol}-${opp.direction}-${i}`} className="rounded-lg border border-amber-500/40 bg-surface p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold">{opp.symbol}</span>
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
                    watch · {opp.score}/{minScore}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-accent">{scanStrategyName}</p>
                <p className={`mt-1 text-xs font-semibold ${opp.direction === "long" ? "text-bull" : "text-bear"}`}>
                  {opp.direction.toUpperCase()} · score {opp.score} — {minScore - opp.score} below your threshold
                </p>
                <p className="mt-1 text-xs text-muted">
                  {opp.factors.slice(0, 3).map((f) => f.name).join(" · ")}
                </p>
                {builtIn && (
                  <button
                    onClick={() => alertForNearMiss(opp)}
                    disabled={alerted.has(oppKey(opp))}
                    className="mt-2 rounded-md border border-edge px-2.5 py-1 text-[11px] font-semibold text-muted hover:border-accent hover:text-foreground disabled:opacity-60"
                  >
                    {alerted.has(oppKey(opp)) ? "✓ Alert created" : "Alert when ready"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
