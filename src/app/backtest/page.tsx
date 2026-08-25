"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { fmtPrice, fmtTime } from "@/components/format";
import type { BacktestResult, SweepPoint, WalkForwardResult } from "@/lib/backtest/engine";
import { REGIME_LABELS } from "@/lib/strategies/regime";
import { runMonteCarlo } from "@/lib/backtest/montecarlo";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { CONDITION_LIBRARY, type ConditionId, type CustomStrategy } from "@/lib/strategies/custom";
import { loadSavedStrategies, type SavedStrategy } from "@/lib/strategies/savedStore";

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

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [strategyType, setStrategyType] = useState<"builtin" | "custom">("builtin");
  const [minScore, setMinScore] = useState(55);
  const [direction, setDirection] = useState<"both" | "long" | "short">("both");
  const [maxHoldBars, setMaxHoldBars] = useState(100);
  const [bars, setBars] = useState(1000);
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
  const [error, setError] = useState<string | null>(null);
  const [savedRuns, setSavedRuns] = useState<SavedRun[]>([]);
  const [savedStrategies, setSavedStrategies] = useState<SavedStrategy[]>([]);
  const [riskPct, setRiskPct] = useState(1);

  // Strategy comparison matrix
  const [compareSymbols, setCompareSymbols] = useState("BTCUSDT, ETHUSDT, SOLUSDT");
  const [compareBuiltin, setCompareBuiltin] = useState(true);
  const [compareSaved, setCompareSaved] = useState<Record<string, boolean>>({});
  const [compareRows, setCompareRows] = useState<CompareRow[] | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    setSavedRuns(loadRuns());
    setSavedStrategies(loadSavedStrategies());
  }, []);

  const custom = useMemo<CustomStrategy>(
    () => ({
      name: "Backtested strategy",
      minScore: customMinScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
    }),
    [conditions, customMinScore],
  );

  const canRun = strategyType === "builtin" || custom.conditions.length > 0;

  const run = useCallback(
    (mode: "run" | "sweep" | "walkforward") => {
      setLoading(true);
      setError(null);
      setResult(null);
      setSweep(null);
      setWalkforward(null);
      fetch(apiUrl("/api/backtest"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.toUpperCase(),
          tf,
          strategyType,
          custom: strategyType === "custom" ? custom : null,
          minScore,
          direction,
          maxHoldBars,
          bars,
          feePct,
          slippagePct,
          sweep: mode === "sweep",
          walkforward: mode === "walkforward",
        }),
      })
        .then(async (r) => {
          const d = await r.json();
          if (!r.ok) throw new Error(d.error ?? "backtest failed");
          if (mode === "sweep") setSweep(d.sweep);
          else if (mode === "walkforward") setWalkforward(d.walkforward);
          else setResult(d.result);
        })
        .catch((e) => setError(e.message))
        .finally(() => setLoading(false));
    },
    [symbol, tf, strategyType, custom, minScore, direction, maxHoldBars, bars, feePct, slippagePct],
  );

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
          fetch(apiUrl("/api/backtest"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              symbol: sym,
              tf,
              strategyType: st.strategyType,
              custom: st.custom,
              minScore,
              direction,
              maxHoldBars,
              bars: Math.min(bars, 1000),
              feePct,
              slippagePct,
            }),
          })
            .then(async (r) => {
              const d = await r.json();
              if (!r.ok) throw new Error(`${st.label} / ${sym}: ${d.error ?? "failed"}`);
              const res: BacktestResult = d.result;
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
  }, [compareSymbols, compareBuiltin, compareSaved, savedStrategies, tf, minScore, direction, maxHoldBars, bars, feePct, slippagePct]);

  const saveRun = useCallback(() => {
    if (!result) return;
    const entry: SavedRun = {
      id: `run-${Date.now()}`,
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
    };
    setSavedRuns((prev) => {
      const next = [entry, ...prev].slice(0, 30);
      try {
        localStorage.setItem(RUNS_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, [result, strategyType, minScore, customMinScore, direction, bars, feePct, slippagePct]);

  const deleteRun = useCallback((id: string) => {
    setSavedRuns((prev) => {
      const next = prev.filter((r) => r.id !== id);
      try {
        localStorage.setItem(RUNS_KEY, JSON.stringify(next));
      } catch {}
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
                <input type="range" min={40} max={90} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} className="w-32 accent-[var(--accent)]" />
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
                    }}
                    className={inputCls}
                  >
                    <option value="">Load saved strategy…</option>
                    {savedStrategies.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.strategy.name}
                      </option>
                    ))}
                  </select>
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
                {loading ? "Backtesting…" : "Run backtest"}
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
                  <button onClick={saveRun} className="rounded-md border border-edge px-3 py-1 text-xs font-semibold hover:bg-edge">
                    Save run
                  </button>
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
                        <td className="py-1 pr-3 whitespace-nowrap">{r.label}</td>
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
