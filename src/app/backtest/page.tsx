"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import RiskRulesEditor from "@/components/RiskRulesEditor";
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
import { CONDITION_LIBRARY, type ConditionId, type CustomStrategy } from "@/lib/strategies/custom";
import { describeStopRule, describeTargetRule, type RiskSettings, type StopRule, type TargetRule } from "@/lib/strategies/risk";
import { addSavedStrategy, loadSavedStrategies, updateSavedStrategy, type SavedStrategy } from "@/lib/strategies/savedStore";
import { describeUserCondition, loadUserConditions, saveUserConditions, type UserCondition } from "@/lib/strategies/userConditions";
import { backtestSessionOpen, sessionSpecFor, SESSION_OPEN_STRATEGY_NAME, type SessionOpenBacktest } from "@/lib/strategies/sessionOpen";
import { backtestStochReversal, DEFAULT_STOCH_REVERSAL_FILTERS, STOCH_REVERSAL_STRATEGY_NAME, type StochReversalBacktest, type StochReversalEntryMode, type StochReversalFilters } from "@/lib/strategies/stochReversal";
import { backtestTrendlineFib, DEFAULT_FIB_TARGET, DEFAULT_MAX_PULLBACK_BARS, DEFAULT_MIN_IMPULSE_ATR, DEFAULT_TRENDLINE_FIB_FILTERS, DEFAULT_VOL_SURGE_RATIO, ENTRY_FIB, FIB_TARGET_LEVELS, TRENDLINE_FIB_STRATEGY_NAME, type TrendlineFibBacktest, type TrendlineFibFilters } from "@/lib/strategies/trendlineFib";
import { backtestPocAmd, DEFAULT_MIN_DIST_LEG_ATR, DEFAULT_POC_AMD_FILTERS, DEFAULT_POC_MAX_PULLBACK_BARS, DEFAULT_POC_RR_TARGET, DEFAULT_POC_VOL_SURGE_RATIO, POC_AMD_STRATEGY_NAME, type PocAmdBacktest, type PocAmdFilters } from "@/lib/strategies/pocAmd";

// Backtests run in the browser: the server only supplies candle history
// (pure I/O), so long simulations never hit the host's per-request CPU limit.
// The simulation is sliced so the UI can breathe and show progress.
const CHUNK_ENTRY_BARS = 300;
const WF_THRESHOLDS = [45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
const TLF_SWEEP_WAITS = [5, 10, 15, 20, 30];

interface TrendlineFibSweepCell {
  target: number;
  maxWait: number;
  trades: number;
  winRatePct: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

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

  // Full custom-strategy configuration (editable, savable back to the library)
  const [strategyName, setStrategyName] = useState("Backtested strategy");
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [userConds, setUserConds] = useState<UserCondition[]>([]);
  const [userStates, setUserStates] = useState<Record<string, ConditionState>>({});
  const [stopRule, setStopRule] = useState<StopRule>({ type: "default" });
  const [targetRule, setTargetRule] = useState<TargetRule>({ type: "default" });
  const [justSaved, setJustSaved] = useState(false);
  const [justUpdated, setJustUpdated] = useState(false);

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
  const [tlMaxWait, setTlMaxWait] = useState(DEFAULT_MAX_PULLBACK_BARS);
  const [tlFilters, setTlFilters] = useState<TrendlineFibFilters>(DEFAULT_TRENDLINE_FIB_FILTERS);
  const [tlResult, setTlResult] = useState<TrendlineFibBacktest | null>(null);
  const [tlLoading, setTlLoading] = useState(false);
  const [tlError, setTlError] = useState<string | null>(null);
  const [tlSweep, setTlSweep] = useState<TrendlineFibSweepCell[] | null>(null);
  const [tlSweepLoading, setTlSweepLoading] = useState(false);

  const runTrendlineFib = useCallback(() => {
    setTlLoading(true);
    setTlError(null);
    setTlResult(null);
    const sym = tlSymbol.toUpperCase();
    fetchHistory(sym, tlTf, tlBars)
      .then((h) => {
        if (h.candles.length < 200) throw new Error("not enough history for this symbol/timeframe");
        setTlResult(backtestTrendlineFib(sym, tlTf, h.candles, tlTarget, tlFilters, tlMaxWait));
      })
      .catch((e) => setTlError(e instanceof Error ? e.message : "backtest failed"))
      .finally(() => setTlLoading(false));
  }, [tlSymbol, tlTf, tlBars, tlTarget, tlFilters, tlMaxWait]);

  const runTrendlineFibSweep = useCallback(() => {
    setTlSweepLoading(true);
    setTlError(null);
    setTlSweep(null);
    const sym = tlSymbol.toUpperCase();
    fetchHistory(sym, tlTf, tlBars)
      .then((h) => {
        if (h.candles.length < 200) throw new Error("not enough history for this symbol/timeframe");
        const cells: TrendlineFibSweepCell[] = [];
        for (const target of FIB_TARGET_LEVELS) {
          for (const maxWait of TLF_SWEEP_WAITS) {
            const r = backtestTrendlineFib(sym, tlTf, h.candles, target, tlFilters, maxWait);
            cells.push({
              target,
              maxWait,
              trades: r.trades.length,
              winRatePct: r.winRatePct,
              totalR: r.totalR,
              profitFactor: r.profitFactor,
              maxDrawdownR: r.maxDrawdownR,
            });
          }
        }
        setTlSweep(cells);
      })
      .catch((e) => setTlError(e instanceof Error ? e.message : "sweep failed"))
      .finally(() => setTlSweepLoading(false));
  }, [tlSymbol, tlTf, tlBars, tlFilters]);

  // Volume Profile POC Break & Retest backtest (dedicated, deliberately simple)
  const [pocSymbol, setPocSymbol] = useState("BTCUSDT");
  const [pocTf, setPocTf] = useState<Timeframe>("1h");
  const [pocBars, setPocBars] = useState(1500);
  const [pocRr, setPocRr] = useState(DEFAULT_POC_RR_TARGET);
  const [pocMaxWait, setPocMaxWait] = useState(DEFAULT_POC_MAX_PULLBACK_BARS);
  const [pocFilters, setPocFilters] = useState<PocAmdFilters>(DEFAULT_POC_AMD_FILTERS);
  const [pocResult, setPocResult] = useState<PocAmdBacktest | null>(null);
  const [pocLoading, setPocLoading] = useState(false);
  const [pocError, setPocError] = useState<string | null>(null);

  const runPocAmd = useCallback(() => {
    setPocLoading(true);
    setPocError(null);
    setPocResult(null);
    const sym = pocSymbol.toUpperCase();
    fetchHistory(sym, pocTf, pocBars)
      .then((h) => {
        if (h.candles.length < 200) throw new Error("not enough history for this symbol/timeframe");
        setPocResult(backtestPocAmd(sym, pocTf, h.candles, pocRr, pocFilters, pocMaxWait));
      })
      .catch((e) => setPocError(e instanceof Error ? e.message : "backtest failed"))
      .finally(() => setPocLoading(false));
  }, [pocSymbol, pocTf, pocBars, pocRr, pocFilters, pocMaxWait]);

  useEffect(() => {
    setSavedRuns(loadRuns());
    setSavedStrategies(loadSavedStrategies());
    const conds = loadUserConditions();
    setUserConds(conds);
    setUserStates(Object.fromEntries(conds.map((c) => [c.id, { enabled: false, weight: 10 }])));
  }, []);

  const custom = useMemo<CustomStrategy>(() => {
    const enabledUser = userConds
      .filter((c) => userStates[c.id]?.enabled)
      .map((c) => ({ condition: c, weight: userStates[c.id].weight }));
    const riskCustom = stopRule.type !== "default" || targetRule.type !== "default";
    return {
      name: strategyName,
      minScore: customMinScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
      ...(enabledUser.length > 0 ? { userConditions: enabledUser } : {}),
      ...(riskCustom ? { risk: { stop: stopRule, target: targetRule } satisfies RiskSettings } : {}),
    };
  }, [conditions, customMinScore, strategyName, userConds, userStates, stopRule, targetRule]);

  const loadStrategyIntoEditor = useCallback(
    (s: SavedStrategy) => {
      setLoadedId(s.id);
      setStrategyName(s.strategy.name);
      setCustomMinScore(s.strategy.minScore);
      setConditions(
        Object.fromEntries(
          CONDITION_LIBRARY.map((c) => {
            const cond = s.strategy.conditions.find((x) => x.id === c.id);
            return [c.id, { enabled: !!cond, weight: cond?.weight ?? c.defaultWeight }];
          }),
        ) as Record<ConditionId, ConditionState>,
      );
      // Import any embedded user conditions missing from the local library.
      const embedded = s.strategy.userConditions ?? [];
      const missing = embedded.map((u) => u.condition).filter((c) => !userConds.some((x) => x.id === c.id));
      const nextConds = missing.length > 0 ? [...userConds, ...missing] : userConds;
      if (missing.length > 0) {
        setUserConds(nextConds);
        saveUserConditions(nextConds);
      }
      setUserStates(
        Object.fromEntries(
          nextConds.map((c) => {
            const picked = embedded.find((u) => u.condition.id === c.id);
            return [c.id, { enabled: Boolean(picked), weight: picked?.weight ?? 10 }];
          }),
        ),
      );
      setStopRule(s.strategy.risk?.stop ?? { type: "default" });
      setTargetRule(s.strategy.risk?.target ?? { type: "default" });
    },
    [userConds],
  );

  const saveAsNewStrategy = useCallback(() => {
    const next = addSavedStrategy(custom, "manual");
    setSavedStrategies(next);
    setLoadedId(next[0]?.id ?? null);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }, [custom]);

  const updateLoadedStrategy = useCallback(() => {
    if (!loadedId) return;
    setSavedStrategies(updateSavedStrategy(loadedId, custom));
    setJustUpdated(true);
    setTimeout(() => setJustUpdated(false), 2000);
  }, [loadedId, custom]);

  const [aiApplied, setAiApplied] = useState(false);

  // Applies the review's machine-readable suggestions to the editor as a NEW
  // variant: the loaded strategy id is cleared so "Save" creates a fresh entry
  // and the original (and its review) stays untouched.
  const applyAiSuggestions = useCallback(() => {
    const sc = aiReview?.suggestedChanges;
    if (!sc) return;
    const needsCustom = Boolean(sc.conditionWeights || sc.stop || sc.target);
    if (needsCustom && strategyType === "builtin") setStrategyType("custom");
    if (sc.minScore !== undefined) {
      if (strategyType === "builtin" && !needsCustom) setMinScore(sc.minScore);
      else setCustomMinScore(sc.minScore);
    }
    if (sc.direction) setDirection(sc.direction);
    if (sc.maxHoldBars !== undefined) setMaxHoldBars(sc.maxHoldBars);
    if (sc.regimes) {
      setRegimeFilter({
        trending_up: sc.regimes.includes("trending_up"),
        trending_down: sc.regimes.includes("trending_down"),
        ranging: sc.regimes.includes("ranging"),
        volatile: sc.regimes.includes("volatile"),
      });
    }
    if (sc.conditionWeights) {
      setConditions((prev) => {
        const next = { ...prev };
        for (const w of sc.conditionWeights ?? []) {
          next[w.id] = w.weight <= 0 ? { ...next[w.id], enabled: false } : { enabled: true, weight: w.weight };
        }
        return next;
      });
    }
    if (sc.stop) setStopRule(sc.stop);
    if (sc.target) setTargetRule(sc.target);
    setStrategyName((prev) => (prev.endsWith(" (AI variant)") ? prev : `${prev} (AI variant)`));
    setLoadedId(null);
    setAiApplied(true);
    setTimeout(() => setAiApplied(false), 2500);
  }, [aiReview, strategyType]);

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
                      if (s) loadStrategyIntoEditor(s);
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
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={strategyName}
                    onChange={(e) => setStrategyName(e.target.value)}
                    placeholder="Strategy name…"
                    className={`${inputCls} min-w-0 flex-1`}
                  />
                  {loadedId && savedStrategies.some((s) => s.id === loadedId) && (
                    <button
                      onClick={updateLoadedStrategy}
                      disabled={!canRun}
                      className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                      title="Overwrite the loaded saved strategy with the settings below — the Strategy Lab and scanner pick the update up immediately"
                    >
                      {justUpdated ? "Updated ✓" : "Update strategy"}
                    </button>
                  )}
                  <button
                    onClick={saveAsNewStrategy}
                    disabled={!canRun}
                    className="rounded-md border border-edge px-2.5 py-1 text-xs font-semibold hover:bg-edge disabled:opacity-50"
                    title="Save the settings below as a new strategy in your library (the original is kept)"
                  >
                    {justSaved ? "Saved ✓" : loadedId ? "Save as new" : "Save strategy"}
                  </button>
                </div>
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
                  {userConds.map((c) => {
                    const st = userStates[c.id] ?? { enabled: false, weight: 10 };
                    return (
                      <label key={c.id} className="flex cursor-pointer items-center gap-2 text-xs" title={describeUserCondition(c)}>
                        <input
                          type="checkbox"
                          checked={st.enabled}
                          onChange={(e) => setUserStates((prev) => ({ ...prev, [c.id]: { ...st, enabled: e.target.checked } }))}
                          className="accent-[var(--accent)]"
                        />
                        <span className="min-w-0 flex-1 truncate">
                          {c.label} <span className="text-[10px] uppercase text-accent">yours</span>
                        </span>
                        {st.enabled && (
                          <input
                            type="number"
                            min={1}
                            max={30}
                            value={st.weight}
                            onChange={(e) => setUserStates((prev) => ({ ...prev, [c.id]: { ...st, weight: Number(e.target.value) } }))}
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
                <div className="rounded-md border border-edge bg-background p-2">
                  <span className="text-xs font-semibold">Risk settings — SL &amp; TP placement</span>
                  <div className="mt-2">
                    <RiskRulesEditor stopRule={stopRule} targetRule={targetRule} onStopChange={setStopRule} onTargetChange={setTargetRule} />
                  </div>
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
                      {aiReview.suggestedChanges && (
                        <div className="rounded-md border border-edge p-3">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-xs font-semibold uppercase text-muted">Apply as a new variant</h3>
                            <button
                              onClick={applyAiSuggestions}
                              className="rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-white hover:opacity-90"
                              title="Loads these changes into the setup as a new strategy variant — the original strategy and this review are untouched. Re-run to compare, then Save as new to keep it."
                            >
                              {aiApplied ? "Applied ✓ — re-run to compare" : "Apply suggestions"}
                            </button>
                          </div>
                          <ul className="mt-2 space-y-0.5 text-xs text-muted">
                            {aiReview.suggestedChanges.minScore !== undefined && <li>Min score → {aiReview.suggestedChanges.minScore}</li>}
                            {aiReview.suggestedChanges.direction && <li>Direction → {aiReview.suggestedChanges.direction}</li>}
                            {aiReview.suggestedChanges.regimes && (
                              <li>Entry regimes → {aiReview.suggestedChanges.regimes.map((r) => REGIME_LABELS[r]).join(", ")} only</li>
                            )}
                            {aiReview.suggestedChanges.maxHoldBars !== undefined && <li>Max hold → {aiReview.suggestedChanges.maxHoldBars} bars</li>}
                            {aiReview.suggestedChanges.conditionWeights?.map((w) => (
                              <li key={w.id}>
                                {CONDITION_LIBRARY.find((c) => c.id === w.id)?.label ?? w.id} → {w.weight <= 0 ? "disabled" : `weight ${w.weight}`}
                              </li>
                            ))}
                            {aiReview.suggestedChanges.stop && <li>Stop rule → {describeStopRule(aiReview.suggestedChanges.stop)}</li>}
                            {aiReview.suggestedChanges.target && <li>Target rule → {describeTargetRule(aiReview.suggestedChanges.target)}</li>}
                          </ul>
                        </div>
                      )}
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
              close beyond the swing, or the pullback taking longer than the max wait (default {DEFAULT_MAX_PULLBACK_BARS}{" "}
              candles, adjustable below) cancels the entry. Confirmation filters (toggle to
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
              <label className="block">
                <span className="text-xs text-muted">Max pullback wait (candles)</span>
                <input
                  type="number"
                  min={2}
                  max={200}
                  value={tlMaxWait}
                  onChange={(e) => setTlMaxWait(Math.max(2, Math.round(Number(e.target.value) || DEFAULT_MAX_PULLBACK_BARS)))}
                  className={`${inputCls} mt-1 block`}
                />
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
                  <label className="flex items-center gap-1" title="The break leg (fib 0 → fib 1) must span at least this many ATRs — screens out weak-momentum breaks">
                    <input
                      type="checkbox"
                      checked={tlFilters.impulseFilter}
                      onChange={(e) => setTlFilters({ ...tlFilters, impulseFilter: e.target.checked })}
                    />
                    Break impulse ≥
                    <input
                      type="number"
                      min={0.5}
                      max={10}
                      step={0.5}
                      value={tlFilters.minImpulseAtr}
                      onChange={(e) => setTlFilters({ ...tlFilters, minImpulseAtr: Math.max(0.5, Number(e.target.value) || DEFAULT_MIN_IMPULSE_ATR) })}
                      className="w-14 rounded border border-edge bg-transparent px-1 py-0.5"
                    />
                    ATR
                  </label>
                  <label className="flex items-center gap-1" title="The break candle's volume must be at least this multiple of the 20-bar average (skipped when the feed has no volume)">
                    <input
                      type="checkbox"
                      checked={tlFilters.volumeSurge}
                      onChange={(e) => setTlFilters({ ...tlFilters, volumeSurge: e.target.checked })}
                    />
                    Volume surge ≥
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={0.1}
                      value={tlFilters.volSurgeRatio}
                      onChange={(e) => setTlFilters({ ...tlFilters, volSurgeRatio: Math.max(1, Number(e.target.value) || DEFAULT_VOL_SURGE_RATIO) })}
                      className="w-14 rounded border border-edge bg-transparent px-1 py-0.5"
                    />
                    × avg
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
              <button
                onClick={runTrendlineFibSweep}
                disabled={tlSweepLoading}
                className="rounded-md border border-edge px-3 py-1.5 text-xs font-semibold hover:bg-edge disabled:opacity-50"
                title="Backtest every TP fib level against several max-pullback waits on the same candles"
              >
                {tlSweepLoading ? "Sweeping…" : "Sweep TP × wait"}
              </button>
            </div>
            {tlError && <p className="mt-2 text-xs text-bear">{tlError}</p>}
            {tlSweep && (
              <div className="mt-3">
                <p className="text-xs text-muted">
                  Total R (trades) per TP fib × max pullback wait — best cell highlighted. Click a cell to load it into the inputs above.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="text-xs">
                    <thead className="text-muted">
                      <tr>
                        <th className="py-1 pr-3 text-left">TP fib \ wait</th>
                        {TLF_SWEEP_WAITS.map((w) => (
                          <th key={w} className="px-2 py-1 text-right">
                            {w}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {FIB_TARGET_LEVELS.map((f) => {
                        const best = tlSweep.reduce((m, c) => (c.trades > 0 && c.totalR > m ? c.totalR : m), -Infinity);
                        return (
                          <tr key={f} className="border-t border-edge">
                            <td className="py-1 pr-3 font-mono">{f}</td>
                            {TLF_SWEEP_WAITS.map((w) => {
                              const cell = tlSweep.find((c) => c.target === f && c.maxWait === w);
                              if (!cell) return <td key={w} />;
                              const isBest = cell.trades > 0 && cell.totalR === best;
                              return (
                                <td key={w} className="px-1 py-0.5 text-right">
                                  <button
                                    onClick={() => {
                                      setTlTarget(f);
                                      setTlMaxWait(w);
                                    }}
                                    title={`TP ${f} · wait ${w} — ${cell.trades} trades, ${cell.winRatePct}% win, PF ${Number.isFinite(cell.profitFactor) ? cell.profitFactor : "∞"}, max DD ${cell.maxDrawdownR}R`}
                                    className={`w-full rounded px-1.5 py-0.5 text-right font-mono hover:bg-edge ${
                                      isBest ? "bg-accent text-white" : cell.totalR > 0 ? "text-bull" : cell.totalR < 0 ? "text-bear" : "text-muted"
                                    }`}
                                  >
                                    {cell.trades > 0 ? `${cell.totalR >= 0 ? "+" : ""}${cell.totalR}R (${cell.trades})` : "—"}
                                  </button>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
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
            <h2 className="font-semibold">{POC_AMD_STRATEGY_NAME} backtest</h2>
            <p className="mt-1 text-xs text-muted">
              Replays the dedicated detector exactly like live detection: a consolidation box (its volume profile gives
              the POC) → a manipulation sweep beyond one boundary → the distribution CLOSING back through the POC against
              the sweep (a wick through never counts) → entry on the pullback that tags the POC → SL just beyond the
              sweep extreme → TP at the risk multiple you pick. A close back through the POC before the fill, the target
              running off without the pullback, or the pullback taking longer than the max wait (default{" "}
              {DEFAULT_POC_MAX_PULLBACK_BARS} candles) cancels the entry. Mirrored both ways: swept below → BUY the POC
              pullback; swept above → SELL it. Confirmation filters (toggle to compare): a decisive POC break margin, a
              minimum distribution leg in ATRs, and a volume surge on the break candle (skipped when the feed has no
              volume). No look-ahead; a bar spanning both SL and TP counts as a stop.
            </p>
            <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
              <label className="block">
                <span className="text-xs text-muted">Symbol</span>
                <div className="mt-1">
                  <SymbolInput value={pocSymbol} onChange={setPocSymbol} className={`${inputCls} w-40 font-mono uppercase`} />
                </div>
              </label>
              <label className="block">
                <span className="text-xs text-muted">Timeframe</span>
                <select value={pocTf} onChange={(e) => setPocTf(e.target.value as Timeframe)} className={`${inputCls} mt-1 block`}>
                  {TIMEFRAMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-muted">TP risk multiple</span>
                <select value={pocRr} onChange={(e) => setPocRr(Number(e.target.value))} className={`${inputCls} mt-1 block`}>
                  {[1, 1.5, 2, 2.5, 3, 4].map((r) => (
                    <option key={r} value={r}>
                      {r}R{r === DEFAULT_POC_RR_TARGET ? " (default)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-xs text-muted">Max pullback wait (candles)</span>
                <input
                  type="number"
                  min={2}
                  max={200}
                  value={pocMaxWait}
                  onChange={(e) => setPocMaxWait(Math.max(2, Math.round(Number(e.target.value) || DEFAULT_POC_MAX_PULLBACK_BARS)))}
                  className={`${inputCls} mt-1 block`}
                />
              </label>
              <div className="block text-xs">
                <span className="text-muted">Confirmation filters</span>
                <div className="mt-1 flex flex-wrap gap-3">
                  <label className="flex items-center gap-1" title="The distribution close must clear the POC by an ATR margin, not squeak through">
                    <input
                      type="checkbox"
                      checked={pocFilters.decisivePocBreak}
                      onChange={(e) => setPocFilters({ ...pocFilters, decisivePocBreak: e.target.checked })}
                    />
                    Decisive POC break
                  </label>
                  <label className="flex items-center gap-1" title="The leg from the sweep extreme to the break close must span at least this many ATRs — screens out weak distributions">
                    <input
                      type="checkbox"
                      checked={pocFilters.distributionLeg}
                      onChange={(e) => setPocFilters({ ...pocFilters, distributionLeg: e.target.checked })}
                    />
                    Distribution leg ≥
                    <input
                      type="number"
                      min={0.5}
                      max={10}
                      step={0.5}
                      value={pocFilters.minDistLegAtr}
                      onChange={(e) => setPocFilters({ ...pocFilters, minDistLegAtr: Math.max(0.5, Number(e.target.value) || DEFAULT_MIN_DIST_LEG_ATR) })}
                      className="w-14 rounded border border-edge bg-transparent px-1 py-0.5"
                    />
                    ATR
                  </label>
                  <label className="flex items-center gap-1" title="The break candle's volume must be at least this multiple of the 20-bar average (skipped when the feed has no volume)">
                    <input
                      type="checkbox"
                      checked={pocFilters.volumeSurge}
                      onChange={(e) => setPocFilters({ ...pocFilters, volumeSurge: e.target.checked })}
                    />
                    Volume surge ≥
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={0.1}
                      value={pocFilters.volSurgeRatio}
                      onChange={(e) => setPocFilters({ ...pocFilters, volSurgeRatio: Math.max(1, Number(e.target.value) || DEFAULT_POC_VOL_SURGE_RATIO) })}
                      className="w-14 rounded border border-edge bg-transparent px-1 py-0.5"
                    />
                    × avg
                  </label>
                </div>
              </div>
              <label className="block">
                <span className="text-xs text-muted">History: {pocBars} bars</span>
                <input
                  type="range"
                  min={300}
                  max={3000}
                  step={100}
                  value={pocBars}
                  onChange={(e) => setPocBars(Number(e.target.value))}
                  className="mt-2 block w-36"
                />
              </label>
              <button
                onClick={runPocAmd}
                disabled={pocLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {pocLoading ? "Running…" : "Run POC backtest"}
              </button>
            </div>
            {pocError && <p className="mt-2 text-xs text-bear">{pocError}</p>}
            {pocResult && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4 lg:grid-cols-8">
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Boxes</p>
                    <p className="font-semibold">{pocResult.boxes}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Breaks</p>
                    <p className="font-semibold">{pocResult.breaks}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Filtered</p>
                    <p className="font-semibold">{pocResult.filtered}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">No fill</p>
                    <p className="font-semibold">{pocResult.noFill}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Win rate</p>
                    <p className="font-semibold">{pocResult.trades.length > 0 ? `${pocResult.winRatePct}%` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Total R</p>
                    <p className={`font-semibold ${pocResult.totalR > 0 ? "text-bull" : pocResult.totalR < 0 ? "text-bear" : ""}`}>
                      {pocResult.totalR >= 0 ? "+" : ""}
                      {pocResult.totalR}R
                    </p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Avg R</p>
                    <p className="font-semibold">{pocResult.trades.length > 0 ? `${pocResult.avgR}R` : "—"}</p>
                  </div>
                  <div className="rounded-md border border-edge p-2">
                    <p className="text-muted">Max DD</p>
                    <p className="font-semibold">{pocResult.maxDrawdownR}R</p>
                  </div>
                </div>
                {pocResult.openAtEnd > 0 && (
                  <p className="text-xs text-muted">{pocResult.openAtEnd} trade(s) still open at the end of the window (excluded from stats).</p>
                )}
                {pocResult.trades.length > 0 ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-muted">
                        <tr>
                          <th className="py-1 pr-3">Entry time</th>
                          <th className="py-1 pr-3">Direction</th>
                          <th className="py-1 pr-3">POC</th>
                          <th className="py-1 pr-3">Sweep</th>
                          <th className="py-1 pr-3">Entry</th>
                          <th className="py-1 pr-3">SL</th>
                          <th className="py-1 pr-3">TP ({pocResult.trades[0]?.rrTarget ?? pocRr}R)</th>
                          <th className="py-1 pr-3">Exit</th>
                          <th className="py-1 pr-3">Reason</th>
                          <th className="py-1">R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pocResult.trades.map((t, i) => (
                          <tr key={i} className="border-t border-edge">
                            <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(t.entryTime)}</td>
                            <td className={`py-1 pr-3 font-semibold ${t.direction === "bullish" ? "text-bull" : "text-bear"}`}>
                              {t.direction === "bullish" ? "SWEPT BELOW · LONG" : "SWEPT ABOVE · SHORT"}
                            </td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.poc)}</td>
                            <td className="py-1 pr-3 font-mono">{fmtPrice(t.sweepPrice)}</td>
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
                    No trades — either no consolidation box produced a sweep + distribution close through the POC in this
                    window, the confirmation filters rejected the breaks, or price never pulled back to the POC before
                    running off or closing back through it.
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
