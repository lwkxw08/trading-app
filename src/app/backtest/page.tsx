"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SymbolInput from "@/components/SymbolInput";
import { getJson, postJson } from "@/components/api";
import { fmtPrice, fmtTime } from "@/components/format";
import type { BacktestReview } from "@/lib/ai/analyze";
import {
  runBacktestSegment,
  runBacktestSweep,
  runWalkForward,
  summarizeTrades,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
  type SweepPoint,
  type WalkForwardResult,
} from "@/lib/backtest/engine";
import { REGIME_LABELS, type RegimeLabel } from "@/lib/strategies/regime";
import { runMonteCarlo } from "@/lib/backtest/montecarlo";
import { TIMEFRAMES, type Candle, type Timeframe } from "@/lib/market/types";
import { CONDITION_LIBRARY, type ConditionId, type CustomStrategy, type WeightedUserCondition } from "@/lib/strategies/custom";
import type { RiskSettings } from "@/lib/strategies/risk";
import { describeStopRule, describeTargetRule } from "@/lib/strategies/risk";
import { loadSavedStrategies, type SavedStrategy } from "@/lib/strategies/savedStore";
import { backtestSessionOpen, sessionSpecFor, SESSION_OPEN_STRATEGY_NAME, type SessionOpenBacktest } from "@/lib/strategies/sessionOpen";
import { backtestStochReversal, DEFAULT_STOCH_REVERSAL_FILTERS, STOCH_REVERSAL_STRATEGY_NAME, type StochReversalBacktest, type StochReversalEntryMode, type StochReversalFilters } from "@/lib/strategies/stochReversal";
import { backtestTrendlineFib, DEFAULT_FIB_TARGET, DEFAULT_TRENDLINE_FIB_FILTERS, ENTRY_FIB, FIB_TARGET_LEVELS, TRENDLINE_FIB_STRATEGY_NAME, type TrendlineFibBacktest, type TrendlineFibFilters } from "@/lib/strategies/trendlineFib";

// Backtests run in the browser: the server only supplies candle history
// (pure I/O), so long simulations never hit the host's per-request CPU limit.
// The simulation is sliced so the UI can breathe and show progress.
const CHUNK_ENTRY_BARS = 300;
const WF_THRESHOLDS = [45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];

interface History {
  symbol: string;
  tf: Timeframe;
  htf: Timeframe;
  candles: Candle[];
  htfCandles: Candle[];
}

function fetchHistory(symbol: string, tf: Timeframe, bars: number): Promise<History> {
  return getJson<History>(`/api/history?symbol=${encodeURIComponent(symbol)}&tf=${tf}&bars=${bars}`, 2);
}

const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function runClientBacktest(
  symbol: string,
  tf: Timeframe,
  bars: number,
  config: BacktestConfig,
  onProgress?: (done: number, total: number) => void,
): Promise<BacktestResult> {
  const h = await fetchHistory(symbol, tf, bars);
  const trades: BacktestTrade[] = [];
  const total = Math.max(1, Math.ceil(h.candles.length / CHUNK_ENTRY_BARS));
  let fromTime: number | null = null;
  let meta = { barsTested: 0, firstBarTime: 0, lastBarTime: 0 };
  for (let i = 0; i < 100; i++) {
    const seg = runBacktestSegment(symbol, tf, h.candles, h.htfCandles, h.htf, config, fromTime, CHUNK_ENTRY_BARS);
    trades.push(...seg.trades);
    meta = { barsTested: seg.barsTested, firstBarTime: seg.firstBarTime, lastBarTime: seg.lastBarTime };
    onProgress?.(Math.min(i + 1, total), total);
    if (seg.done || seg.nextTime === null) break;
    if (fromTime !== null && seg.nextTime <= fromTime) break; // guard against malformed (non-monotonic) history
    fromTime = seg.nextTime;
    await nextTick();
  }
  return summarizeTrades(symbol, tf, meta, trades);
}

interface ConditionState {
  enabled: boolean;
  weight: number;
}

interface SavedRun {
  id: string;
  savedAt: number;
  label: string;
  symbol: string;
  tf: Timeframe;
  strategyType: "builtin" | "custom";
  minScore: number;
  direction: string;
  bars: number;
  feePct: number;
  slippagePct: number;
  totalTrades: number;
  winRate: number | null;
  expectancyR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  /** Full result payload so the run can be reopened later (absent on legacy saves). */
  maxHoldBars?: number;
  result?: BacktestResult;
  aiReview?: BacktestReview | null;
}

interface CompareRow {
  strategy: string;
  symbol: string;
  totalTrades: number;
  winRate: number | null;
  expectancyR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
}

const RUNS_KEY = "tradeintel.backtest.runs.v1";

function loadRuns(): SavedRun[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY);
    return raw ? (JSON.parse(raw) as SavedRun[]) : [];
  } catch {
    return [];
  }
}

/** Persist runs, shedding the heaviest payloads (oldest first) if the storage quota is hit. */
function persistRuns(runs: SavedRun[]): void {
  const attempt = [...runs];
  for (let i = 0; i < runs.length + 1; i++) {
    try {
      localStorage.setItem(RUNS_KEY, JSON.stringify(attempt));
      return;
    } catch {
      // strip the oldest full-result payload and retry with summaries only
      for (let j = attempt.length - 1; j >= 0; j--) {
        if (attempt[j].result) {
          attempt[j] = { ...attempt[j], result: undefined, aiReview: attempt[j].aiReview };
          break;
        }
        if (j === 0) return;
      }
    }
  }
}

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [strategyType, setStrategyType] = useState<"builtin" | "custom">("builtin");
  const [minScore, setMinScore] = useState(55);
  const [direction, setDirection] = useState<"both" | "long" | "short">("both");
  const [maxHoldBars, setMaxHoldBars] = useState(100);
  const [bars, setBars] = useState(1000);
  const [regimeFilter, setRegimeFilter] = useState<Record<RegimeLabel, boolean>>({
    trending_up: true,
    trending_down: true,
    ranging: true,
    volatile: true,
  });
  const [feePct, setFeePct] = useState(0);
  const [slippagePct, setSlippagePct] = useState(0);
  const [conditions, setConditions] = useState<Record<ConditionId, ConditionState>>(
    () => Object.fromEntries(CONDITION_LIBRARY.map((c) => [c.id, { enabled: false, weight: c.defaultWeight }])) as Record<ConditionId, ConditionState>,
  );
  const [customMinScore, setCustomMinScore] = useState(60);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [sweep, setSweep] = useState<SweepPoint[] | null>(null);
  const [walkforward, setWalkforward] = useState<WalkForwardResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>([]);
  const [aiReview, setAiReview] = useState<BacktestReview | null>(null);
  const [aiReviewLoading, setAiReviewLoading] = useState(false);
  const [aiReviewError, setAiReviewError] = useState<string | null>(null);
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>([]);
  const [riskPct, setRiskPct] = useState(1);
  const currentRunSavedId = useRef<string | null>(null);

  // Strategy comparison matrix
  const [compareSymbols, setCompareSymbols] = useState("BTCUSDT, ETHUSDT, SOLUSDT");
  const [compareBuiltin, setCompareBuiltin] = useState(true);
  const [compareSaved, setCompareSaved] = useState<Record<string, boolean>>({});
  const [compareRows, setCompareRows] = useState<CompareRow[] | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  const [loadedExtras, setLoadedExtras] = useState<{ name: string; userConditions?: WeightedUserCondition[]; risk?: RiskSettings } | null>(null);

  // Session Open Range backtest (dedicated, deliberately simple)
  const [soSymbol, setSoSymbol] = useState("BTCUSDT");
  const [soDays, setSoDays] = useState(10);
  const [soResult, setSoResult] = useState<SessionOpenBacktest | null>(null);
  const [soLoading, setSoLoading] = useState(false);
  const [soError, setSoError] = useState<string | null>(null);

  const runSessionOpen = useCallback(() => {
    setSoLoading(true);
    setSoError(null);
    setSoResult(null);
    const sym = soSymbol.toUpperCase();
    const bars = Math.min(3000, Math.max(300, soDays * 288)); // 288 5m bars/day
    fetchHistory(sym, "5m", bars)
      .then((h) => {
        if (h.candles.length < 300) throw new Error("not enough 5m history for this symbol");
        setSoResult(backtestSessionOpen(sym, h.candles));
      })
      .catch((e) => setSoError(e instanceof Error ? e.message : "backtest failed"))
      .finally(() => setSoLoading(false));
  }, [soSymbol, soDays]);

  // Stochastic Double Top/Bottom backtest (dedicated, deliberately simple)
  const [srSymbol, setSrSymbol] = useState("BTCUSDT");
  const [srTf, setSrTf] = useState<Timeframe>("1h");
  const [srBars, setSrBars] = useState(1500);
  const [srEntryMode, setSrEntryMode] = useState<StochReversalEntryMode>("both");
  const [srFilters, setSrFilters] = useState<StochReversalFilters>(DEFAULT_STOCH_REVERSAL_FILTERS);
  const [srResult, setSrResult] = useState<StochReversalBacktest | null>(null);
  const [srLoading, setSrLoading] = useState(false);
  const [srError, setSrError] = useState<string | null>(null);

  const runStochReversal = useCallback(() => {
    setSrLoading(true);
    setSrError(null);
    setSrResult(null);
    const sym = srSymbol.toUpperCase();
    fetchHistory(sym, srTf, srBars)
      .then((h) => {
        if (h.candles.length < 200) throw new Error("not enough history for this symbol/timeframe");
        setSrResult(backtestStochReversal(sym, srTf, h.candles, srEntryMode, srFilters));
      })
      .catch((e) => setSrError(e instanceof Error ? e.message : "backtest failed"))
      .finally(() => setSrLoading(false));
  }, [srSymbol, srTf, srBars, srEntryMode, srFilters]);

  // Trendline Break + Fib Retracement backtest (dedicated, deliberately simple)
  const [tlSymbol, setTlSymbol] = useState("BTCUSDT");
  const [tlTf, setTlTf] = useState<Timeframe>("1h");
  const [tlBars, setTlBars] = useState(1500);
  const [tlTarget, setTlTarget] = useState(DEFAULT_FIB_TARGET);
  const [tlFilters, setTlFilters] = useState<TrendlineFibFilters>(DEFAULT_TRENDLINE_FIB_FILTERS);
  const [tlResult, setTlResult] = useState<TrendlineFibBacktest | null>(null);
  const [tlLoading, setTlLoading] = useState(false);
  const [tlError, setTlError] = useState<string | null>(null);

  const runTrendlineFib = useCallback(() => {
    setTlLoading(true);
    setTlError(null);
    setTlResult(null);
    const sym = tlSymbol.toUpperCase();
    fetchHistory(sym, tlTf, tlBars)
      .then((h) => {
        if (h.candles.length < 200) throw new Error("not enough history for this symbol/timeframe");
        setTlResult(backtestTrendlineFib(sym, tlTf, h.candles, tlTarget, tlFilters));
      })
      .catch((e) => setTlError(e instanceof Error ? e.message : "backtest failed"))
      .finally(() => setTlLoading(false));
  }, [tlSymbol, tlTf, tlBars, tlTarget, tlFilters]);

  useEffect(() => {
    setSavedRuns(loadRuns());
    setSavedStrategies(loadSavedStrategies());
  }, []);

  const custom = useMemo<CustomStrategy>(
    () => ({
      name: loadedExtras?.name ?? "Backtested strategy",
      minScore: customMinScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
      ...(loadedExtras?.userConditions && loadedExtras.userConditions.length > 0 ? { userConditions: loadedExtras.userConditions } : {}),
      ...(loadedExtras?.risk ? { risk: loadedExtras.risk } : {}),
    }),
    [conditions, customMinScore, loadedExtras],
  );

  const canRun = strategyType === "builtin" || custom.conditions.length > 0 || (custom.userConditions?.length ?? 0) > 0;

  // Entry-regime filter: undefined when all regimes are allowed (no filtering).
  const activeRegimes = useMemo<RegimeLabel[] | undefined>(() => {
    const picked = (Object.keys(REGIME_LABELS) as RegimeLabel[]).filter((r) => regimeFilter[r]);
    return picked.length === 4 || picked.length === 0 ? undefined : picked;
  }, [regimeFilter]);

  const run = useCallback(
    (mode: "run" | "sweep" | "walkforward") => {
      setLoading(true);
      setError(null);
      setResult(null);
      setSweep(null);
      setWalkforward(null);
      setAiReview(null);
      setAiReviewError(null);
      setProgress(null);
      currentRunSavedId.current = null;
      const sym = symbol.toUpperCase();
      const config: BacktestConfig = {
        strategyType,
        custom: strategyType === "custom" ? custom : null,
        minScore,
        direction,
        regimes: activeRegimes ?? null,
        maxHoldBars,
        feePct,
        slippagePct,
      };
      const request =
        mode === "run"
          ? runClientBacktest(sym, tf, bars, config, (done, total) => setProgress(`${done}/${total}`)).then((r) =>
              setResult(r),
            )
          : fetchHistory(sym, tf, bars).then(async (h) => {
              await nextTick(); // let the loading state paint before the heavy compute
              if (mode === "sweep") setSweep(runBacktestSweep(sym, tf, h.candles, h.htfCandles, h.htf, config, WF_THRESHOLDS));
              else setWalkforward(runWalkForward(sym, tf, h.candles, h.htfCandles, h.htf, config, 4, WF_THRESHOLDS));
            });
      request
        .catch((e) => setError(e.message))
        .finally(() => {
          setLoading(false);
          setProgress(null);
        });
    },
    [symbol, tf, strategyType, custom, minScore, direction, activeRegimes, maxHoldBars, bars, feePct, slippagePct],
  );

  const runAiReview = useCallback(() => {
    if (!result) return;
    setAiReviewLoading(true);
    setAiReviewError(null);
    setAiReview(null);
    postJson<{ review: BacktestReview }>("/api/backtest/review", {
        symbol: result.symbol,
        timeframe: result.timeframe,
        config: {
          strategyType,
          minScore: strategyType === "custom" ? customMinScore : minScore,
          direction,
          regimes: activeRegimes ?? null,
          maxHoldBars,
          feePct,
          slippagePct,
          conditions:
            strategyType === "custom"
              ? [
                  ...custom.conditions.map((c) => ({ label: CONDITION_LIBRARY.find((x) => x.id === c.id)?.label ?? c.id, weight: c.weight })),
                  ...(custom.userConditions ?? []).map((u) => ({ label: `${u.condition.label} (user-defined)`, weight: u.weight })),
                ]
              : null,
        },
        metrics: {
          barsTested: result.barsTested,
          totalTrades: result.totalTrades,
          wins: result.wins,
          losses: result.losses,
          winRate: result.winRate,
          avgR: result.avgR,
          expectancyR: result.expectancyR,
          totalR: result.totalR,
          profitFactor: result.profitFactor,
          maxDrawdownR: result.maxDrawdownR,
          avgHoldBars: result.avgHoldBars,
        },
        byRegime: result.byRegime,
        trades: result.trades.slice(-120).map((t) => ({
          direction: t.direction,
          rMultiple: t.rMultiple,
          exitReason: t.exitReason,
          holdBars: t.holdBars,
          score: t.score,
          regime: t.regime,
        })),
      })
      .then((d) => {
        setAiReview(d.review);
        // if this result was already saved, attach the review to the saved run
        const savedId = currentRunSavedId.current;
        if (savedId) {
          setSavedRuns((prev) => {
            if (!prev.some((r) => r.id === savedId)) return prev;
            const next = prev.map((r) => (r.id === savedId ? { ...r, aiReview: d.review } : r));
            persistRuns(next);
            return next;
          });
        }
      })
      .catch((e) => setAiReviewError(e.message))
      .finally(() => setAiReviewLoading(false));
  }, [result, strategyType, custom, customMinScore, minScore, direction, activeRegimes, maxHoldBars, feePct, slippagePct]);

  const monteCarlo = useMemo(
    () => (result && result.totalTrades >= 5 ? runMonteCarlo(result.trades.map((t) => t.rMultiple), riskPct) : null),
    [result, riskPct],
  );

  const runCompare = useCallback(() => {
    const symbols = compareSymbols
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
      .slice(0, 6);
    const strategies: { label: string; strategyType: "builtin" | "custom"; custom: CustomStrategy | null }[] = [];
    if (compareBuiltin) strategies.push({ label: `Built-in (score≥${minScore})`, strategyType: "builtin", custom: null });
    for (const s of savedStrategies) {
      if (compareSaved[s.id]) strategies.push({ label: s.strategy.name, strategyType: "custom", custom: s.strategy });
    }
    if (symbols.length === 0 || strategies.length === 0) return;

    setCompareLoading(true);
    setCompareError(null);
    setCompareRows(null);
    Promise.all(
      strategies.flatMap((st) =>
        symbols.map((sym) =>
          runClientBacktest(sym, tf, Math.min(bars, 1000), {
            strategyType: st.strategyType,
            custom: st.custom,
            minScore,
            direction,
            regimes: activeRegimes ?? null,
            maxHoldBars,
            feePct,
            slippagePct,
          })
            .catch((e) => {
              throw new Error(`${st.label} / ${sym}: ${e instanceof Error ? e.message : "failed"}`);
            })
            .then((res) => {
              return {
                strategy: st.label,
                symbol: sym,
                totalTrades: res.totalTrades,
                winRate: res.winRate,
                expectancyR: res.expectancyR,
                totalR: res.totalR,
                profitFactor: res.profitFactor,
                maxDrawdownR: res.maxDrawdownR,
              } satisfies CompareRow;
            }),
        ),
      ),
    )
      .then(setCompareRows)
      .catch((e) => setCompareError(e.message))
      .finally(() => setCompareLoading(false));
  }, [compareSymbols, compareBuiltin, compareSaved, savedStrategies, tf, minScore, direction, activeRegimes, maxHoldBars, bars, feePct, slippagePct]);

  const saveRun = useCallback(() => {
    if (!result) return;
    const id = `run-${Date.now()}`;
    const entry: SavedRun = {
      id,
      savedAt: Date.now(),
      label: `${result.symbol} ${result.timeframe} ${strategyType === "builtin" ? `score≥${minScore}` : "custom"} ${direction}`,
      symbol: result.symbol,
      tf: result.timeframe,
      strategyType,
      minScore: strategyType === "builtin" ? minScore : customMinScore,
      direction,
      bars,
      feePct,
      slippagePct,
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      expectancyR: result.expectancyR,
      totalR: result.totalR,
      profitFactor: result.profitFactor,
      maxDrawdownR: result.maxDrawdownR,
      maxHoldBars,
      result,
      aiReview: aiReview ?? null,
    };
    currentRunSavedId.current = id;
    setSavedRuns((prev) => {
      const next = [entry, ...prev].slice(0, 30);
      persistRuns(next);
      return next;
    });
  }, [result, strategyType, minScore, customMinScore, direction, bars, feePct, slippagePct, maxHoldBars, aiReview]);

  const restoreRun = useCallback((r: SavedRun) => {
    if (!r.result) return;
    setSymbol(r.symbol);
    setTf(r.tf);
    setStrategyType(r.strategyType);
    if (r.strategyType === "builtin") setMinScore(r.minScore);
    else setCustomMinScore(r.minScore);
    setDirection(r.direction as "both" | "long" | "short");
    setBars(r.bars);
    setFeePct(r.feePct);
    setSlippagePct(r.slippagePct);
    if (r.maxHoldBars !== undefined) setMaxHoldBars(r.maxHoldBars);
    setSweep(null);
    setWalkforward(null);
    setError(null);
    setAiReviewError(null);
    setResult(r.result);
    setAiReview(r.aiReview ?? null);
    currentRunSavedId.current = r.id;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const deleteRun = useCallback((id: string) => {
    setSavedRuns((prev) => {
      const next = prev.filter((r) => r.id !== id);
      persistRuns(next);
      return next;
    });
  }, []);

  const inputCls = "rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none focus:border-accent";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Backtest</h1>
        <p className="text-sm text-muted">
          Replay history bar-by-bar (no lookahead) against the built-in confluence engine or a custom strategy, with
          the same entry/SL/TP logic as live signals. Past performance never guarantees future results.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        {/* Config */}
        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Setup</h2>
          <div className="mt-3 space-y-3">
            <div className="flex gap-2">
              <SymbolInput value={symbol} onChange={setSymbol} className={`${inputCls} w-36 font-mono uppercase`} />
              <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={inputCls}>
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select value={direction} onChange={(e) => setDirection(e.target.value as typeof direction)} className={inputCls}>
                <option value="both">Long + short</option>
                <option value="long">Long only</option>
                <option value="short">Short only</option>
              </select>
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => setStrategyType("builtin")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${strategyType === "builtin" ? "bg-accent text-white" : "border border-edge hover:bg-edge"}`}
              >
                Built-in confluence
              </button>
              <button
                onClick={() => setStrategyType("custom")}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${strategyType === "custom" ? "bg-accent text-white" : "border border-edge hover:bg-edge"}`}
              >
                Custom strategy
              </button>
            </div>

            {strategyType === "builtin" ? (
              <div className="flex items-center gap-2 text-sm">
                <label className="text-xs text-muted">Min confluence score</label>
                <input type="range" min={40} max={100} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-32 accent-[var(--accent)]" />
                <span className="text-xs">{minScore}</span>
              </div>
            ) : (
              <div className="space-y-2">
                {savedStrategies.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const s = savedStrategies.find((x) => x.id === e.target.value);
                      if (!s) return;
                      setConditions(
                        Object.fromEntries(
                          CONDITION_LIBRARY.map((c) => {
                            const cond = s.strategy.conditions.find((x) => x.id === c.id);
                            return [c.id, { enabled: !!cond, weight: cond?.weight ?? c.defaultWeight }];
                          }),
                        ) as Record<ConditionId, ConditionState>,
                      );
                      setCustomMinScore(s.strategy.minScore);
                      setLoadedExtras(
                        (s.strategy.userConditions?.length ?? 0) > 0 || s.strategy.risk
                          ? { name: s.strategy.name, userConditions: s.strategy.userConditions, risk: s.strategy.risk }
                          : null,
                      );
                    }}
                    className={`${inputCls} w-full min-w-0 max-w-full truncate`}
                  >
                    <option value="">Load saved strategy…</option>
                    {savedStrategies.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.strategy.name}
                      </option>
                    ))}
                  </select>
                )}
                {loadedExtras && (
                  <div className="flex items-start justify-between gap-2 rounded-md border border-accent/40 bg-accent/5 px-2 py-1.5 text-[11px] text-muted">
                    <span className="min-w-0">
                      Carried from “{loadedExtras.name}”:
                      {(loadedExtras.userConditions?.length ?? 0) > 0 &&
                        ` ${loadedExtras.userConditions?.length} user condition${(loadedExtras.userConditions?.length ?? 0) === 1 ? "" : "s"}`}
                      {loadedExtras.risk &&
                        ` · SL: ${describeStopRule(loadedExtras.risk.stop)} · TP: ${describeTargetRule(loadedExtras.risk.target)}`}
                    </span>
                    <button onClick={() => setLoadedExtras(null)} className="shrink-0 text-muted hover:text-bear">
                      ✕
                    </button>
                  </div>
                )}
                <div className="max-h-64 space-y-1 overflow-auto pr-1">
                  {CONDITION_LIBRARY.map((c) => {
                    const st = conditions[c.id];
                    return (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs">
                        <input
                          type="checkbox"
                          checked={st.enabled}
                          onChange={(e) => setConditions((prev) => ({ ...prev, [c.id]: { ...prev[c.id], enabled: e.target.checked } }))}
                          className="accent-[var(--accent)]"
                        />
                        <span className="flex-1">{c.label}</span>
                        {st.enabled && (
                          <input
                            type="number"
                            min={1}
                            max={30}
                            value={st.weight}
                            onChange={(e) => setConditions((prev) => ({ ...prev, [c.id]: { ...prev[c.id], weight: Number(e.target.value) } }))}
                            className={`${inputCls} w-14 font-mono`}
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <label className="text-xs text-muted">Min score</label>
                  <input type="range" min={0} max={100} value={customMinScore} onChange={(e) => setCustomMinScore(Number(e.target.value))} className="w-32 accent-[var(--accent)]" />
                  <span className="text-xs">{customMinScore}%</span>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="flex items-center gap-2">
                <label className="text-xs text-muted">Max hold (bars)</label>
                <input
                  type="number"
                  min={5}
                  max={500}
                  value={maxHoldBars}
                  onChange={(e) => setMaxHoldBars(Number(e.target.value))}
                  className={`${inputCls} w-20 font-mono`}
                />
              </span>
              <span className="flex items-center gap-2">
                <label className="text-xs text-muted">History (bars)</label>
                <select value={bars} onChange={(e) => setBars(Number(e.target.value))} className={inputCls}>
                  {[500, 1000, 2000, 3000].map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </span>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted" title="Only enter trades when the market regime at the entry bar (classified from ADX/ATR) is one of the ticked regimes — e.g. untick Volatile to implement 'skip volatile regime entries'">
                Entry regime filter
              </label>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {(Object.keys(REGIME_LABELS) as RegimeLabel[]).map((r) => (
                  <label key={r} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <input
                      type="checkbox"
                      checked={regimeFilter[r]}
                      onChange={(e) => setRegimeFilter((prev) => ({ ...prev, [r]: e.target.checked }))}
                      className="accent-[var(--accent)]"
                    />
                    {REGIME_LABELS[r]}
                  </label>
                ))}
              </div>
              {activeRegimes && (
                <p className="text-[10px] text-muted">Entries restricted to: {activeRegimes.map((r) => REGIME_LABELS[r]).join(", ")}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              <span className="flex items-center gap-2">
                <label className="text-xs text-muted">Fee %/side</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={feePct}
                  onChange={(e) => setFeePct(Number(e.target.value))}
                  className={`${inputCls} w-20 font-mono`}
                />
              </span>
              <span className="flex items-center gap-2">
                <label className="text-xs text-muted">Slippage %</label>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.01}
                  value={slippagePct}
                  onChange={(e) => setSlippagePct(Number(e.target.value))}
                  className={`${inputCls} w-20 font-mono`}
                />
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => run("run")}
                disabled={loading || !canRun}
                className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {loading ? (progress ? `Backtesting… ${progress}` : "Backtesting…") : "Run backtest"}
              </button>
              {strategyType === "builtin" && (
                <>
                  <button
                    onClick={() => run("sweep")}
                    disabled={loading}
                    className="rounded-md border border-edge px-4 py-2 text-sm font-semibold hover:bg-edge disabled:opacity-50"
                    title="Test min-score thresholds 45–80 in one run"
                  >
                    Min-score sweep
                  </button>
                  <button
                    onClick={() => run("walkforward")}
                    disabled={loading}
                    className="rounded-md border border-edge px-4 py-2 text-sm font-semibold hover:bg-edge disabled:opacity-50"
                    title="Optimize the threshold on one window, validate on the next — repeated across folds"
                  >
                    Walk-forward
                  </button>
                </>
              )}
            </div>
            {!canRun && <p className="text-xs text-muted">Enable at least one condition.</p>}
            {error && <p className="text-xs text-bear">{error}</p>}
          </div>
        </section>

        {/* Results */}
        <div className="space-y-4 xl:col-span-2">
          {sweep && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <h2 className="font-semibold">Min-score sweep — {symbol.toUpperCase()} · {tf}</h2>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3">Min score</th>
                      <th className="py-1 pr-3">Trades</th>
                      <th className="py-1 pr-3">Win rate</th>
                      <th className="py-1 pr-3">Expectancy</th>
                      <th className="py-1 pr-3">Total R</th>
                      <th className="py-1 pr-3">Profit factor</th>
                      <th className="py-1">Max DD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sweep.map((p) => (
                      <tr key={p.minScore} className="border-t border-edge">
                        <td className="py-1 pr-3 font-mono">{p.minScore}</td>
                        <td className="py-1 pr-3">{p.totalTrades}</td>
                        <td className="py-1 pr-3">{p.winRate !== null ? `${p.winRate.toFixed(0)}%` : "—"}</td>
                        <td className={`py-1 pr-3 font-mono ${(p.expectancyR ?? 0) > 0 ? "text-bull" : (p.expectancyR ?? 0) < 0 ? "text-bear" : ""}`}>
                          {p.expectancyR !== null ? `${p.expectancyR.toFixed(2)}R` : "—"}
                        </td>
                        <td className={`py-1 pr-3 font-mono ${p.totalR > 0 ? "text-bull" : p.totalR < 0 ? "text-bear" : ""}`}>
                          {p.totalR >= 0 ? "+" : ""}
                          {p.totalR.toFixed(2)}
                        </td>
                        <td className="py-1 pr-3">{p.profitFactor !== null ? p.profitFactor.toFixed(2) : "—"}</td>
                        <td className="py-1">{p.maxDrawdownR.toFixed(2)}R</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">
                Higher thresholds trade less often — weigh expectancy against sample size before picking one.
              </p>
            </section>
          )}
          {walkforward && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  Walk-forward — {walkforward.symbol} · {walkforward.timeframe} · {walkforward.folds.length} folds
                </h2>
                <span
                  className={`rounded-md px-2 py-0.5 text-xs font-bold uppercase ${walkforward.robust ? "bg-bull/15 text-bull" : "bg-bear/15 text-bear"}`}
                >
                  {walkforward.robust ? "Robust out-of-sample" : "Not robust"}
                </span>
              </div>
              <p className="mt-1 text-xs text-muted">
                Each fold optimizes the min-score threshold on its in-sample window, then trades the next window with
                that frozen threshold. A strategy that only wins in-sample is over-fitted.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3">Fold</th>
                      <th className="py-1 pr-3">Best score</th>
                      <th className="py-1 pr-3">IS trades</th>
                      <th className="py-1 pr-3">IS expect.</th>
                      <th className="py-1 pr-3">IS total R</th>
                      <th className="py-1 pr-3">OOS trades</th>
                      <th className="py-1 pr-3">OOS expect.</th>
                      <th className="py-1 pr-3">OOS total R</th>
                      <th className="py-1">OOS max DD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walkforward.folds.map((f) => (
                      <tr key={f.fold} className="border-t border-edge">
                        <td className="py-1 pr-3">{f.fold}</td>
                        <td className="py-1 pr-3 font-mono">{f.optimizedMinScore}</td>
                        <td className="py-1 pr-3">{f.inSample.totalTrades}</td>
                        <td className="py-1 pr-3 font-mono">{f.inSample.expectancyR !== null ? `${f.inSample.expectancyR.toFixed(2)}R` : "—"}</td>
                        <td className={`py-1 pr-3 font-mono ${f.inSample.totalR > 0 ? "text-bull" : f.inSample.totalR < 0 ? "text-bear" : ""}`}>
                          {f.inSample.totalR >= 0 ? "+" : ""}
                          {f.inSample.totalR.toFixed(2)}
                        </td>
                        <td className="py-1 pr-3">{f.outSample.totalTrades}</td>
                        <td className="py-1 pr-3 font-mono">{f.outSample.expectancyR !== null ? `${f.outSample.expectancyR.toFixed(2)}R` : "—"}</td>
                        <td className={`py-1 pr-3 font-mono ${f.outSample.totalR > 0 ? "text-bull" : f.outSample.totalR < 0 ? "text-bear" : ""}`}>
                          {f.outSample.totalR >= 0 ? "+" : ""}
                          {f.outSample.totalR.toFixed(2)}
                        </td>
                        <td className="py-1">{f.outSample.maxDrawdownR.toFixed(2)}R</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <Metric label="OOS folds positive" value={`${walkforward.oosPositiveFolds} / ${walkforward.folds.length}`} good={walkforward.robust} bad={!walkforward.robust} />
                <Metric label="OOS trades" value={String(walkforward.oos.totalTrades)} />
                <Metric
                  label="OOS total R"
                  value={`${walkforward.oos.totalR >= 0 ? "+" : ""}${walkforward.oos.totalR.toFixed(2)}R`}
                  good={walkforward.oos.totalR > 0}
                  bad={walkforward.oos.totalR < 0}
                />
                <Metric
                  label="OOS expectancy"
                  value={walkforward.oos.expectancyR !== null ? `${walkforward.oos.expectancyR.toFixed(2)}R` : "—"}
                  good={(walkforward.oos.expectancyR ?? 0) > 0}
                  bad={(walkforward.oos.expectancyR ?? 0) < 0}
                />
              </div>
            </section>
          )}
          {result && (
            <>
              <section className="rounded-lg border border-edge bg-surface p-4">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="font-semibold">
                    Results — {result.symbol} · {result.timeframe} · {result.barsTested} bars ({fmtTime(result.firstBarTime)} → {fmtTime(result.lastBarTime)})
                  </h2>
                  <span className="flex gap-2">
                    <button
                      onClick={runAiReview}
                      disabled={aiReviewLoading}
                      className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                      title="AI reviews this run's metrics, regimes and trades and suggests ways to tighten the strategy"
                    >
                      {aiReviewLoading ? "Reviewing…" : "AI review"}
                    </button>
                    <button onClick={saveRun} className="rounded-md border border-edge px-3 py-1 text-xs font-semibold hover:bg-edge">
                      Save run
                    </button>
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <Metric label="Trades" value={String(result.totalTrades)} />
                  <Metric label="Win rate" value={result.winRate !== null ? `${result.winRate.toFixed(0)}%` : "—"} />
                  <Metric label="Total R" value={`${result.totalR >= 0 ? "+" : ""}${result.totalR.toFixed(2)}R`} good={result.totalR > 0} bad={result.totalR < 0} />
                  <Metric label="Expectancy" value={result.expectancyR !== null ? `${result.expectancyR.toFixed(2)}R` : "—"} good={(result.expectancyR ?? 0) > 0} bad={(result.expectancyR ?? 0) < 0} />
                  <Metric label="Profit factor" value={result.profitFactor !== null ? result.profitFactor.toFixed(2) : "—"} />
                  <Metric label="Max drawdown" value={`${result.maxDrawdownR.toFixed(2)}R`} />
                  <Metric label="Wins / losses" value={`${result.wins} / ${result.losses}`} />
                  <Metric label="Avg hold" value={result.avgHoldBars !== null ? `${result.avgHoldBars.toFixed(0)} bars` : "—"} />
                </div>
                {result.equityCurve.length > 1 && <EquityCurve curve={result.equityCurve} />}
                {result.byRegime && result.byRegime.length > 0 && (
                  <div className="mt-3">
                    <h3 className="text-xs font-semibold uppercase text-muted">Performance by market regime at entry</h3>
                    <table className="mt-1 w-full text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Regime</th>
                          <th className="py-1 pr-3 font-medium">Trades</th>
                          <th className="py-1 pr-3 font-medium">Win rate</th>
                          <th className="py-1 pr-3 font-medium">Avg R</th>
                          <th className="py-1 pr-3 font-medium">Total R</th>
                          <th className="py-1 font-medium">PF</th>
                        </tr>
                      </thead>
                      <tbody className="font-mono">
                        {result.byRegime.map((b) => (
                          <tr key={b.regime} className="border-t border-edge">
                            <td className="py-1 pr-3 font-sans">{REGIME_LABELS[b.regime]}</td>
                            <td className="py-1 pr-3">{b.trades}</td>
                            <td className="py-1 pr-3">{b.winRate !== null ? `${b.winRate.toFixed(0)}%` : "—"}</td>
                            <td className={`py-1 pr-3 ${(b.avgR ?? 0) > 0 ? "text-bull" : (b.avgR ?? 0) < 0 ? "text-bear" : ""}`}>
                              {b.avgR !== null ? b.avgR.toFixed(2) : "—"}
                            </td>
                            <td className="py-1 pr-3">{b.totalR >= 0 ? "+" : ""}{b.totalR.toFixed(2)}R</td>
                            <td className="py-1">{b.profitFactor !== null ? b.profitFactor.toFixed(2) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-1 text-[10px] text-muted">Regime is classified from ADX/ATR at each entry bar — a probabilistic read, not a prediction.</p>
                  </div>
                )}
                {result.totalTrades < 10 && (
                  <p className="mt-2 text-xs text-muted">Small sample — treat these numbers as indicative only.</p>
                )}
              </section>

              {(aiReview || aiReviewError) && (
                <section className="rounded-lg border border-edge bg-surface p-4">
                  <h2 className="font-semibold">AI strategy review</h2>
                  {aiReviewError ? (
                    <p className="mt-2 text-xs text-bear">{aiReviewError}</p>
                  ) : aiReview ? (
                    <div className="mt-2 space-y-3 text-sm">
                      <ReviewBlock label="Overview" text={aiReview.overview} />
                      <ReviewBlock label="Edge assessment" text={aiReview.edgeAssessment} />
                      <ReviewBlock label="Regime advice" text={aiReview.regimeAdvice} />
                      <ReviewBlock label="Exit analysis" text={aiReview.exitAnalysis} />
                      {aiReview.refinements.length > 0 && (
                        <div>
                          <h3 className="text-xs font-semibold uppercase text-muted">Suggested refinements</h3>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                            {aiReview.refinements.map((r, i) => (
                              <li key={i}>{r}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <ReviewBlock label="Caveats" text={aiReview.caveats} />
                      <p className="text-[10px] text-muted">
                        Apply suggestions with the Setup controls — min score, direction, max hold, the entry regime filter, condition weights — or edit SL/TP rules in the Strategy Lab, then re-run and validate with walk-forward. AI suggestions are hypotheses; educational analysis only, not financial advice.
                      </p>
                    </div>
                  ) : null}
                </section>
              )}

              <section className="rounded-lg border border-edge bg-surface p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="font-semibold">Monte Carlo — 1000 reshuffles</h2>
                  <span className="flex items-center gap-2 text-sm">
                    <label className="text-xs text-muted">Risk per trade</label>
                    <input
                      type="range"
                      min={0.25}
                      max={5}
                      step={0.25}
                      value={riskPct}
                      onChange={(e) => setRiskPct(Number(e.target.value))}
                      className="w-32 accent-[var(--accent)]"
                    />
                    <span className="w-10 text-xs">{riskPct}%</span>
                  </span>
                </div>
                {monteCarlo ? (
                  <>
                    <p className="mt-1 text-xs text-muted">
                      The backtest&apos;s {monteCarlo.tradesPerRun} trade R-multiples resampled {monteCarlo.runs} times at {monteCarlo.riskPct}% risk per
                      trade — the order of wins and losses is luck, so this shows the range of outcomes the same edge can produce.
                    </p>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                      <Metric
                        label="Median return"
                        value={`${monteCarlo.finalReturnPct.p50 >= 0 ? "+" : ""}${monteCarlo.finalReturnPct.p50.toFixed(1)}%`}
                        good={monteCarlo.finalReturnPct.p50 > 0}
                        bad={monteCarlo.finalReturnPct.p50 < 0}
                      />
                      <Metric
                        label="Return range (p5–p95)"
                        value={`${monteCarlo.finalReturnPct.p5.toFixed(0)}% … ${monteCarlo.finalReturnPct.p95 >= 0 ? "+" : ""}${monteCarlo.finalReturnPct.p95.toFixed(0)}%`}
                      />
                      <Metric label="Median max drawdown" value={`${monteCarlo.maxDrawdownPct.p50.toFixed(1)}%`} />
                      <Metric label="Worst-case DD (p95)" value={`${monteCarlo.maxDrawdownPct.p95.toFixed(1)}%`} bad={monteCarlo.maxDrawdownPct.p95 > 30} />
                      <Metric label="P(drawdown > 20%)" value={`${monteCarlo.probDrawdownOver20.toFixed(1)}%`} bad={monteCarlo.probDrawdownOver20 > 25} />
                      <Metric label="P(drawdown > 30%)" value={`${monteCarlo.probDrawdownOver30.toFixed(1)}%`} bad={monteCarlo.probDrawdownOver30 > 10} />
                      <Metric
                        label={`Risk of ruin (≥${monteCarlo.ruinDrawdownPct}% DD)`}
                        value={`${monteCarlo.riskOfRuinPct.toFixed(1)}%`}
                        good={monteCarlo.riskOfRuinPct === 0}
                        bad={monteCarlo.riskOfRuinPct > 1}
                      />
                      <Metric label="Trades per run" value={String(monteCarlo.tradesPerRun)} />
                    </div>
                    <p className="mt-2 text-xs text-muted">
                      Use the slider to find the risk-% where the worst-case drawdown stays tolerable — that grounds position sizing in evidence.
                    </p>
                  </>
                ) : (
                  <p className="mt-2 text-xs text-muted">Needs at least 5 closed trades in the backtest.</p>
                )}
              </section>

              <section className="rounded-lg border border-edge bg-surface p-4">
                <h2 className="font-semibold">Trades ({result.trades.length})</h2>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted">
                      <tr>
                        <th className="py-1 pr-3">Entry</th>
                        <th className="py-1 pr-3">Dir</th>
                        <th className="py-1 pr-3">Score</th>
                        <th className="py-1 pr-3">Entry px</th>
                        <th className="py-1 pr-3">Exit px</th>
                        <th className="py-1 pr-3">Exit</th>
                        <th className="py-1 pr-3">Hold</th>
                        <th className="py-1">R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.trades.map((t, i) => (
                        <tr key={i} className="border-t border-edge">
                          <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(t.entryTime)}</td>
                          <td className={`py-1 pr-3 font-bold uppercase ${t.direction === "long" ? "text-bull" : "text-bear"}`}>{t.direction}</td>
                          <td className="py-1 pr-3">{t.score}</td>
                          <td className="py-1 pr-3 font-mono">{fmtPrice(t.entryPrice)}</td>
                          <td className="py-1 pr-3 font-mono">{fmtPrice(t.exitPrice)}</td>
                          <td className="py-1 pr-3">{t.exitReason.replace(/_/g, " ")}</td>
                          <td className="py-1 pr-3">{t.holdBars}</td>
                          <td className={`py-1 font-mono font-semibold ${t.rMultiple > 0 ? "text-bull" : "text-bear"}`}>
                            {t.rMultiple >= 0 ? "+" : ""}
                            {t.rMultiple.toFixed(2)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {!result && !sweep && !walkforward && !loading && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm text-muted">
              Configure a strategy and run a backtest — up to 3000 bars of history are replayed with the exact live
              signal logic. Fees and slippage are modeled only when set above zero, and the live macro-event penalty
              is excluded (no historical calendar).
            </section>
          )}

          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">{SESSION_OPEN_STRATEGY_NAME} backtest</h2>
            <p className="mt-1 text-xs text-muted">
              Replays each session on 5m candles exactly like live detection: opening-hour range → direction at hour end
              (first-hour development + EMA trend) → boundary-touch entry → SL outside the opposite boundary → TP one
              range-span away (session-end close if neither hits). Session opens follow the instrument
              ({sessionSpecFor(soSymbol || "BTCUSDT").label}).
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-muted">Symbol</span>
                <div className="mt-1">
                  <SymbolInput value={soSymbol} onChange={setSoSymbol} className={`${inputCls} w-40 font-mono uppercase`} />
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted">History: {soDays} days</span>
                <input
                  type="range"
                  min={3}
                  max={10}
                  value={soDays}
                  onChange={(e) => setSoDays(Number(e.target.value))}
                  className="mt-2 block w-36"
                />
              </label>
              <button
                onClick={runSessionOpen}
                disabled={soLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {soLoading ? "Running…" : "Run session backtest"}
              </button>
            </div>
            {soError && <p className="mt-2 text-xs text-bear">{soError}</p>}
            {soResult && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Sessions</p>
                    <p className="font-semibold">{soResult.sessions}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Trades</p>
                    <p className="font-semibold">{soResult.trades.length}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">No direction</p>
                    <p className="font-semibold">{soResult.noDirection}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">No touch</p>
                    <p className="font-semibold">{soResult.noTouch}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Win rate</p>
                    <p className="font-semibold">{soResult.trades.length > 0 ? `${soResult.winRatePct}%` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Total R</p>
                    <p className={`font-semibold ${soResult.totalR > 0 ? "text-bull" : soResult.totalR < 0 ? "text-bear" : ""}`}>
                      {soResult.totalR >= 0 ? "+" : ""}
                      {soResult.totalR}R
                    </p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Avg R</p>
                    <p className="font-semibold">{soResult.trades.length > 0 ? `${soResult.avgR}R` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Max DD</p>
                    <p className="font-semibold">{soResult.maxDrawdownR}R</p>
                  </div>
                </div>
                {soResult.trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3">Session</th>
                          <th className="py-1 pr-3">Direction</th>
                          <th className="py-1 pr-3">Entry</th>
                          <th className="py-1 pr-3">Exit</th>
                          <th className="py-1 pr-3">Reason</th>
                          <th className="py-1">R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {soResult.trades.map((t, i) => (
                          <tr key={i} className="border-t border-edge">
                            <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(t.sessionOpen)}</td>
                            <td className={`py-1 pr-3 font-semibold ${t.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                              {t.direction === "bullish" ? "LONG" : "SHORT"}
                            </td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.entry)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.exitPrice)}</td>
                            <td className="py-1 pr-3 uppercase">{t.exitReason.replace(/_/g, " ")}</td>
                            <td className={`py-1 font-mono ${t.rMultiple > 0 ? "text-bull" : t.rMultiple < 0 ? "text-bear" : ""}`}>
                              {t.rMultiple >= 0 ? "+" : ""}
                              {t.rMultiple.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    No trades — sessions were skipped when the first-hour signals conflicted (no clear direction) or price
                    never touched the trend-side boundary.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">{STOCH_REVERSAL_STRATEGY_NAME} backtest</h2>
            <p className="mt-1 text-xs text-muted">
              Replays the dedicated detector exactly like live detection: double top/bottom (two near-equal extremes)
              with the slow stochastic 80+/20- at the second one → reversal confirmation (neckline close-through or
              CHoCH) → entry per the chosen mode: the neckline retest only while the stochastic is at the extreme
              (80+ for sells, 20- for buys), and/or the confirmation-bar close (breakout — catches vertical moves
              that never retest; skipped when price already reached the measured target) → SL beyond the pattern
              extreme with ATR room → measured-move TP (min 1.5R). Quality filters (toggle to compare): a prior trend
              leg into the pattern, stochastic divergence at the second extreme, and a decisive neckline break.
              No look-ahead: patterns only count once their second swing was confirmable; a bar spanning
              both SL and TP counts as a stop.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-muted">Symbol</span>
                <div className="mt-1">
                  <SymbolInput value={srSymbol} onChange={setSrSymbol} className={`${inputCls} w-40 font-mono uppercase`} />
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted">Timeframe</span>
                <select value={srTf} onChange={(e) => setSrTf(e.target.value as Timeframe)} className={`${inputCls} mt-1 block`}>
                  {TIMEFRAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-muted">Entry mode</span>
                <select
                  value={srEntryMode}
                  onChange={(e) => setSrEntryMode(e.target.value as StochReversalEntryMode)}
                  className={`${inputCls} mt-1 block`}
                >
                  <option value="both">Engulfing/breakout, else retest</option>
                  <option value="retest">Neckline retest only</option>
                  <option value="breakout">Engulfing/breakout only</option>
                </select>
              </label>
              <div className="block text-xs">
                <span className="text-muted">Quality filters</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={srFilters.trendFilter}
                      onChange={(e) => setSrFilters({ ...srFilters, trendFilter: e.target.checked })}
                    />
                    Prior trend leg
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={srFilters.divergenceFilter}
                      onChange={(e) => setSrFilters({ ...srFilters, divergenceFilter: e.target.checked })}
                    />
                    Stoch divergence
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={srFilters.decisiveBreak}
                      onChange={(e) => setSrFilters({ ...srFilters, decisiveBreak: e.target.checked })}
                    />
                    Decisive break
                  </label>
                </div>
              </div>
              <label className="block">
                <span className="text-xs text-muted">History: {srBars} bars</span>
                <input
                  type="range"
                  min={300}
                  max={3000}
                  step={100}
                  value={srBars}
                  onChange={(e) => setSrBars(Number(e.target.value))}
                  className="mt-2 block w-36"
                />
              </label>
              <button
                onClick={runStochReversal}
                disabled={srLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {srLoading ? "Running…" : "Run stochastic backtest"}
              </button>
            </div>
            {srError && <p className="mt-2 text-xs text-bear">{srError}</p>}
            {srResult && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Patterns</p>
                    <p className="font-semibold">{srResult.patterns}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Trades</p>
                    <p className="font-semibold">{srResult.trades.length}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Unconfirmed</p>
                    <p className="font-semibold">{srResult.unconfirmed}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">No entry</p>
                    <p className="font-semibold">{srResult.missed}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Win rate</p>
                    <p className="font-semibold">{srResult.trades.length > 0 ? `${srResult.winRatePct}%` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Total R</p>
                    <p className={`font-semibold ${srResult.totalR > 0 ? "text-bull" : srResult.totalR < 0 ? "text-bear" : ""}`}>
                      {srResult.totalR >= 0 ? "+" : ""}
                      {srResult.totalR}R
                    </p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Avg R</p>
                    <p className="font-semibold">{srResult.trades.length > 0 ? `${srResult.avgR}R` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Max DD</p>
                    <p className="font-semibold">{srResult.maxDrawdownR}R</p>
                  </div>
                </div>
                {srResult.openAtEnd > 0 && (
                  <p className="text-xs text-muted">{srResult.openAtEnd} trade(s) still open at the end of the window (excluded from stats).</p>
                )}
                {srResult.trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3">Entry time</th>
                          <th className="py-1 pr-3">Pattern</th>
                          <th className="py-1 pr-3">Confirmed by</th>
                          <th className="py-1 pr-3">Entry</th>
                          <th className="py-1 pr-3">Exit</th>
                          <th className="py-1 pr-3">Reason</th>
                          <th className="py-1">R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {srResult.trades.map((t, i) => (
                          <tr key={i} className="border-t border-edge">
                            <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(t.entryTime)}</td>
                            <td className={`py-1 pr-3 font-semibold ${t.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                              {t.pattern === "double_bottom" ? "DBL BOTTOM · LONG" : "DBL TOP · SHORT"}
                            </td>
                            <td className="py-1 pr-3 uppercase">{t.confirmation.replace(/_/g, " ")} · {t.entryKind}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.entry)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.exitPrice)}</td>
                            <td className="py-1 pr-3 uppercase">{t.exitReason}</td>
                            <td className={`py-1 font-mono ${t.rMultiple > 0 ? "text-bull" : t.rMultiple < 0 ? "text-bear" : ""}`}>
                              {t.rMultiple >= 0 ? "+" : ""}
                              {t.rMultiple.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    No trades — patterns either never confirmed the reversal (no neckline break/CHoCH) or price never
                    retested the neckline entry after confirming.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">{TRENDLINE_FIB_STRATEGY_NAME} backtest</h2>
            <p className="mt-1 text-xs text-muted">
              Replays the dedicated detector exactly like live detection: a falling resistance or rising support
              trendline with at least 3 pivot touches, respected between them (no candle close through the line) → a
              candle CLOSING through the line (a wick through that closes back on the trend side never counts) → fib
              anchored from the trend&apos;s swing extreme (0) to the break candle (1) → entry at the {ENTRY_FIB} pullback on
              the break side → SL just beyond the swing → TP at the fib level you pick. A close back through the line, a
              close beyond the swing, or 80 bars without a fill cancels the entry. Confirmation filters (toggle to
              compare): a decisive break margin, a strong directional break candle, and RSI momentum agreement. No
              look-ahead: touch pivots only count once confirmable; a bar spanning both SL and TP counts as a stop.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-muted">Symbol</span>
                <div className="mt-1">
                  <SymbolInput value={tlSymbol} onChange={setTlSymbol} className={`${inputCls} w-40 font-mono uppercase`} />
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted">Timeframe</span>
                <select value={tlTf} onChange={(e) => setTlTf(e.target.value as Timeframe)} className={`${inputCls} mt-1 block`}>
                  {TIMEFRAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-muted">TP fib level</span>
                <select
                  value={tlTarget}
                  onChange={(e) => setTlTarget(Number(e.target.value))}
                  className={`${inputCls} mt-1 block`}
                >
                  {FIB_TARGET_LEVELS.map((f) => (
                    <option key={f} value={f}>
                      {f}{f === DEFAULT_FIB_TARGET ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="block text-xs">
                <span className="text-muted">Confirmation filters</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={tlFilters.decisiveBreak}
                      onChange={(e) => setTlFilters({ ...tlFilters, decisiveBreak: e.target.checked })}
                    />
                    Decisive break
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={tlFilters.strongBreakCandle}
                      onChange={(e) => setTlFilters({ ...tlFilters, strongBreakCandle: e.target.checked })}
                    />
                    Strong break candle
                  </label>
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={tlFilters.momentumFilter}
                      onChange={(e) => setTlFilters({ ...tlFilters, momentumFilter: e.target.checked })}
                    />
                    RSI momentum
                  </label>
                </div>
              </div>
              <label className="block">
                <span className="text-xs text-muted">History: {tlBars} bars</span>
                <input
                  type="range"
                  min={300}
                  max={3000}
                  step={100}
                  value={tlBars}
                  onChange={(e) => setTlBars(Number(e.target.value))}
                  className="mt-2 block w-36"
                />
              </label>
              <button
                onClick={runTrendlineFib}
                disabled={tlLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {tlLoading ? "Running…" : "Run trendline backtest"}
              </button>
            </div>
            {tlError && <p className="mt-2 text-xs text-bear">{tlError}</p>}
            {tlResult && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Breaks</p>
                    <p className="font-semibold">{tlResult.breaks}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Trades</p>
                    <p className="font-semibold">{tlResult.trades.length}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Filtered</p>
                    <p className="font-semibold">{tlResult.filtered}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">No fill</p>
                    <p className="font-semibold">{tlResult.noFill}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Win rate</p>
                    <p className="font-semibold">{tlResult.trades.length > 0 ? `${tlResult.winRatePct}%` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Total R</p>
                    <p className={`font-semibold ${tlResult.totalR > 0 ? "text-bull" : tlResult.totalR < 0 ? "text-bear" : ""}`}>
                      {tlResult.totalR >= 0 ? "+" : ""}
                      {tlResult.totalR}R
                    </p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Avg R</p>
                    <p className="font-semibold">{tlResult.trades.length > 0 ? `${tlResult.avgR}R` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Max DD</p>
                    <p className="font-semibold">{tlResult.maxDrawdownR}R</p>
                  </div>
                </div>
                {tlResult.openAtEnd > 0 && (
                  <p className="text-xs text-muted">{tlResult.openAtEnd} trade(s) still open at the end of the window (excluded from stats).</p>
                )}
                {tlResult.trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3">Entry time</th>
                          <th className="py-1 pr-3">Direction</th>
                          <th className="py-1 pr-3">Touches</th>
                          <th className="py-1 pr-3">Entry ({ENTRY_FIB})</th>
                          <th className="py-1 pr-3">SL</th>
                          <th className="py-1 pr-3">TP ({tlResult.trades[0]?.targetFib ?? tlTarget})</th>
                          <th className="py-1 pr-3">Exit</th>
                          <th className="py-1 pr-3">Reason</th>
                          <th className="py-1">R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tlResult.trades.map((t, i) => (
                          <tr key={i} className="border-t border-edge">
                            <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(t.entryTime)}</td>
                            <td className={`py-1 pr-3 font-semibold ${t.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                              {t.direction === "bullish" ? "RESISTANCE BREAK · LONG" : "SUPPORT BREAK · SHORT"}
                            </td>
                            <td className="py-1 pr-3">{t.touches}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.entry)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.stopLoss)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.takeProfit)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.exitPrice)}</td>
                            <td className="py-1 pr-3 uppercase">{t.exitReason}</td>
                            <td className={`py-1 font-mono ${t.rMultiple > 0 ? "text-bull" : t.rMultiple < 0 ? "text-bear" : ""}`}>
                              {t.rMultiple >= 0 ? "+" : ""}
                              {t.rMultiple.toFixed(2)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted">
                    No trades — either no 3-touch trendline broke with a candle close in this window, the confirmation
                    filters rejected the breaks, or price never pulled back to the {ENTRY_FIB} entry before running off or
                    closing back through the line.
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Strategy comparison matrix</h2>
            <p className="mt-1 text-xs text-muted">
              Run several strategies over the same instruments ({tf}, up to 1000 bars each) and compare expectancy,
              profit factor and drawdown side by side. Save strategies in the Strategy Lab to add them here.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-3 text-sm">
              <input
                value={compareSymbols}
                onChange={(e) => setCompareSymbols(e.target.value)}
                placeholder="BTCUSDT, ETHUSDT, SOLUSDT"
                className={`${inputCls} w-72 font-mono uppercase`}
              />
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={compareBuiltin} onChange={(e) => setCompareBuiltin(e.target.checked)} className="accent-[var(--accent)]" />
                Built-in (score≥{minScore})
              </label>
              {savedStrategies.map((s) => (
                <label key={s.id} className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={Boolean(compareSaved[s.id])}
                    onChange={(e) => setCompareSaved((prev) => ({ ...prev, [s.id]: e.target.checked }))}
                    className="accent-[var(--accent)]"
                  />
                  {s.strategy.name}
                  {s.source === "calibrated" && <span className="text-[10px] uppercase text-muted">calibrated</span>}
                </label>
              ))}
              <button
                onClick={runCompare}
                disabled={compareLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {compareLoading ? "Comparing…" : "Compare"}
              </button>
            </div>
            {compareError && <p className="mt-2 text-xs text-bear">{compareError}</p>}
            {compareRows && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3">Strategy</th>
                      <th className="py-1 pr-3">Symbol</th>
                      <th className="py-1 pr-3">Trades</th>
                      <th className="py-1 pr-3">Win rate</th>
                      <th className="py-1 pr-3">Expectancy</th>
                      <th className="py-1 pr-3">Total R</th>
                      <th className="py-1 pr-3">PF</th>
                      <th className="py-1">Max DD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRows.map((r, i) => (
                      <tr key={i} className="border-t border-edge">
                        <td className="py-1 pr-3 whitespace-nowrap">{r.strategy}</td>
                        <td className="py-1 pr-3 font-mono">{r.symbol}</td>
                        <td className="py-1 pr-3">{r.totalTrades}</td>
                        <td className="py-1 pr-3">{r.winRate !== null ? `${r.winRate.toFixed(0)}%` : "—"}</td>
                        <td className={`py-1 pr-3 font-mono ${(r.expectancyR ?? 0) > 0 ? "text-bull" : (r.expectancyR ?? 0) < 0 ? "text-bear" : ""}`}>
                          {r.expectancyR !== null ? `${r.expectancyR.toFixed(2)}R` : "—"}
                        </td>
                        <td className={`py-1 pr-3 font-mono ${r.totalR > 0 ? "text-bull" : r.totalR < 0 ? "text-bear" : ""}`}>
                          {r.totalR >= 0 ? "+" : ""}
                          {r.totalR.toFixed(2)}
                        </td>
                        <td className="py-1 pr-3">{r.profitFactor !== null ? r.profitFactor.toFixed(2) : "—"}</td>
                        <td className="py-1">{r.maxDrawdownR.toFixed(2)}R</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {savedRuns.length > 0 && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <h2 className="font-semibold">Saved runs ({savedRuns.length})</h2>
              <p className="mt-1 text-xs text-muted">
                Click a run to reopen its full results (trades, equity curve, regime stats) and its AI review if one was
                run — tweak the setup from the suggestions and re-run without losing the analysis.
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted">
                    <tr>
                      <th className="py-1 pr-3">Run</th>
                      <th className="py-1 pr-3">Bars</th>
                      <th className="py-1 pr-3">Fee/slip</th>
                      <th className="py-1 pr-3">Trades</th>
                      <th className="py-1 pr-3">Win rate</th>
                      <th className="py-1 pr-3">Expectancy</th>
                      <th className="py-1 pr-3">Total R</th>
                      <th className="py-1 pr-3">PF</th>
                      <th className="py-1 pr-3">Max DD</th>
                      <th className="py-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {savedRuns.map((r) => (
                      <tr key={r.id} className="border-t border-edge">
                        <td className="py-1 pr-3 whitespace-nowrap">
                          {r.result ? (
                            <button
                              onClick={() => restoreRun(r)}
                              className="text-accent hover:underline"
                              title="Reopen this run's full results and AI review"
                            >
                              {r.label}
                              {r.aiReview ? " · AI" : ""}
                            </button>
                          ) : (
                            <span title="Saved before full-result storage — only the summary is available">{r.label}</span>
                          )}
                        </td>
                        <td className="py-1 pr-3">{r.bars}</td>
                        <td className="py-1 pr-3 font-mono">
                          {r.feePct}/{r.slippagePct}
                        </td>
                        <td className="py-1 pr-3">{r.totalTrades}</td>
                        <td className="py-1 pr-3">{r.winRate !== null ? `${r.winRate.toFixed(0)}%` : "—"}</td>
                        <td className={`py-1 pr-3 font-mono ${(r.expectancyR ?? 0) > 0 ? "text-bull" : (r.expectancyR ?? 0) < 0 ? "text-bear" : ""}`}>
                          {r.expectancyR !== null ? `${r.expectancyR.toFixed(2)}R` : "—"}
                        </td>
                        <td className={`py-1 pr-3 font-mono ${r.totalR > 0 ? "text-bull" : r.totalR < 0 ? "text-bear" : ""}`}>
                          {r.totalR >= 0 ? "+" : ""}
                          {r.totalR.toFixed(2)}
                        </td>
                        <td className="py-1 pr-3">{r.profitFactor !== null ? r.profitFactor.toFixed(2) : "—"}</td>
                        <td className="py-1 pr-3">{r.maxDrawdownR.toFixed(2)}R</td>
                        <td className="py-1">
                          <button onClick={() => deleteRun(r.id)} className="text-muted hover:text-bear">
                            ✕
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewBlock({ label, text }: { label: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-muted">{label}</h3>
      <p className="mt-1 whitespace-pre-wrap text-sm">{text}</p>
    </div>
  );
}

function Metric({ label, value, good, bad }: { label: string; value: string; good?: boolean; bad?: boolean }) {
  return (
    <div className="rounded-md border border-edge bg-background p-2">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className={`text-sm font-semibold ${good ? "text-bull" : bad ? "text-bear" : ""}`}>{value}</div>
    </div>
  );
}

function EquityCurve({ curve }: { curve: { time: number; r: number }[] }) {
  const w = 600;
  const h = 140;
  const pad = 8;
  const rs = curve.map((p) => p.r);
  const min = Math.min(0, ...rs);
  const max = Math.max(0, ...rs);
  const range = max - min || 1;
  const x = (i: number) => pad + (i / Math.max(1, curve.length - 1)) * (w - 2 * pad);
  const y = (r: number) => h - pad - ((r - min) / range) * (h - 2 * pad);
  const points = curve.map((p, i) => `${x(i).toFixed(1)},${y(p.r).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const positive = curve[curve.length - 1].r >= 0;
  return (
    <div className="mt-3">
      <h3 className="text-xs font-semibold uppercase text-muted">Equity curve (cumulative R)</h3>
      <svg viewBox={`0 0 ${w} ${h}`} className="mt-1 w-full rounded-md border border-edge bg-background">
        <line x1={pad} y1={zeroY} x2={w - pad} y2={zeroY} stroke="currentColor" strokeOpacity={0.2} strokeDasharray="4 4" />
        <polyline points={points} fill="none" stroke={positive ? "var(--bull, #22c55e)" : "var(--bear, #ef4444)"} strokeWidth={1.5} />
      </svg>
    </div>
  );
}
