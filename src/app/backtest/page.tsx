"use client";

import { useCallback, useMemo, useState } from "react";
import { apiUrl } from "@/components/api";
import { fmtPrice, fmtTime } from "@/components/format";
import type { BacktestResult } from "@/lib/backtest/engine";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { CONDITION_LIBRARY, type ConditionId, type CustomStrategy } from "@/lib/strategies/custom";

interface ConditionState {
  enabled: boolean;
  weight: number;
}

export default function BacktestPage() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [strategyType, setStrategyType] = useState<"builtin" | "custom">("builtin");
  const [minScore, setMinScore] = useState(55);
  const [direction, setDirection] = useState<"both" | "long" | "short">("both");
  const [maxHoldBars, setMaxHoldBars] = useState(100);
  const [conditions, setConditions] = useState<Record<ConditionId, ConditionState>>(
    () => Object.fromEntries(CONDITION_LIBRARY.map((c) => [c.id, { enabled: false, weight: c.defaultWeight }])) as Record<ConditionId, ConditionState>,
  );
  const [customMinScore, setCustomMinScore] = useState(60);

  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const custom = useMemo<CustomStrategy>(
    () => ({
      name: "Backtested strategy",
      minScore: customMinScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
    }),
    [conditions, customMinScore],
  );

  const canRun = strategyType === "builtin" || custom.conditions.length > 0;

  const run = useCallback(() => {
    setLoading(true);
    setError(null);
    setResult(null);
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
        bars: 1000,
      }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "backtest failed");
        setResult(d.result);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [symbol, tf, strategyType, custom, minScore, direction, maxHoldBars]);

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
              <input value={symbol} onChange={(e) => setSymbol(e.target.value)} className={`${inputCls} w-32 font-mono uppercase`} />
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

            <div className="flex items-center gap-2 text-sm">
              <label className="text-xs text-muted">Max hold (bars)</label>
              <input
                type="number"
                min={5}
                max={500}
                value={maxHoldBars}
                onChange={(e) => setMaxHoldBars(Number(e.target.value))}
                className={`${inputCls} w-20 font-mono`}
              />
            </div>

            <button
              onClick={run}
              disabled={loading || !canRun}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
            >
              {loading ? "Backtesting…" : "Run backtest"}
            </button>
            {!canRun && <p className="text-xs text-muted">Enable at least one condition.</p>}
            {error && <p className="text-xs text-bear">{error}</p>}
          </div>
        </section>

        {/* Results */}
        <div className="space-y-4 xl:col-span-2">
          {result && (
            <>
              <section className="rounded-lg border border-edge bg-surface p-4">
                <h2 className="font-semibold">
                  Results — {result.symbol} · {result.timeframe} · {result.barsTested} bars ({fmtTime(result.firstBarTime)} → {fmtTime(result.lastBarTime)})
                </h2>
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
                {result.totalTrades < 10 && (
                  <p className="mt-2 text-xs text-muted">Small sample — treat these numbers as indicative only.</p>
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
          {!result && !loading && (
            <section className="rounded-lg border border-edge bg-surface p-4 text-sm text-muted">
              Configure a strategy and run a backtest — up to 1000 bars of history are replayed with the exact live
              signal logic. Note: the live macro-event penalty is excluded (no historical calendar), and fees/slippage
              are not modeled.
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
