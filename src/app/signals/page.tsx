"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtPrice, fmtTime } from "@/components/format";
import { resolveSignals } from "@/lib/signals/resolve";
import { computeSignalStats, loadSignals, saveSignals } from "@/lib/signals/store";
import type { SignalBucket, TrackedSignal } from "@/lib/signals/types";

export default function SignalsPage() {
  const [signals, setSignals] = useState<TrackedSignal[]>([]);
  const [resolving, setResolving] = useState(false);
  const [lastResolved, setLastResolved] = useState<number | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<"all" | "pending" | "target" | "stop" | "timeout">("all");

  useEffect(() => {
    setSignals(loadSignals());
  }, []);

  const stats = useMemo(() => computeSignalStats(signals), [signals]);

  const resolve = useCallback(async () => {
    setResolving(true);
    try {
      const { signals: next, resolved } = await resolveSignals(signals);
      setSignals(next);
      saveSignals(next);
      setLastResolved(resolved);
    } finally {
      setResolving(false);
    }
  }, [signals]);

  const remove = useCallback((id: string) => {
    setSignals((prev) => {
      const next = prev.filter((s) => s.id !== id);
      saveSignals(next);
      return next;
    });
  }, []);

  const clearResolved = useCallback(() => {
    setSignals((prev) => {
      const next = prev.filter((s) => s.outcome === "pending");
      saveSignals(next);
      return next;
    });
  }, []);

  const shown = signals.filter((s) => outcomeFilter === "all" || s.outcome === outcomeFilter);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Signal Tracking</h1>
        <p className="text-sm text-muted">
          Setups captured from the scanner are resolved against later price action — evidence for which strategies,
          factors and timeframes actually deliver. Historical hit rates never guarantee future results.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={resolve}
          disabled={resolving || stats.pending === 0}
          className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          {resolving ? "Resolving…" : `Resolve outcomes (${stats.pending} pending)`}
        </button>
        {signals.length > 0 && (
          <button onClick={clearResolved} className="rounded-md border border-edge px-4 py-2 text-sm font-semibold hover:bg-edge">
            Clear resolved
          </button>
        )}
        {lastResolved !== null && (
          <span className="text-xs text-muted">{lastResolved} signal{lastResolved === 1 ? "" : "s"} resolved this pass.</span>
        )}
      </div>

      {signals.length === 0 ? (
        <section className="rounded-lg border border-edge bg-surface p-4 text-sm text-muted">
          No tracked signals yet. Run the Scanner with “Track signals” enabled — every setup it flags is logged here
          automatically, then resolved against subsequent candles (target hit, stop hit, or timeout after 100 bars).
        </section>
      ) : (
        <>
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Overview</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4 lg:grid-cols-7">
              <Metric label="Tracked" value={String(stats.total)} />
              <Metric label="Pending" value={String(stats.pending)} />
              <Metric label="Targets" value={String(stats.targets)} good={stats.targets > 0} />
              <Metric label="Stops" value={String(stats.stops)} bad={stats.stops > 0} />
              <Metric label="Timeouts" value={String(stats.timeouts)} />
              <Metric label="Hit rate" value={stats.hitRate !== null ? `${stats.hitRate.toFixed(0)}%` : "—"} />
              <Metric
                label="Total R"
                value={`${stats.totalR >= 0 ? "+" : ""}${stats.totalR.toFixed(2)}R`}
                good={stats.totalR > 0}
                bad={stats.totalR < 0}
              />
            </div>
            <p className="mt-2 text-xs text-muted">
              Hit rate = targets ÷ (targets + stops). Timeouts close at market after 100 bars and count toward R only.
            </p>
          </section>

          {stats.resolved > 0 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <BucketTable title="By strategy" buckets={stats.byStrategy} />
              <BucketTable title="By direction" buckets={stats.byDirection} />
              <BucketTable title="By timeframe" buckets={stats.byTimeframe} />
              <BucketTable title="By symbol" buckets={stats.bySymbol} />
              <div className="lg:col-span-2">
                <BucketTable title="By confluence factor" buckets={stats.byFactor} />
              </div>
            </div>
          )}

          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-semibold">Signals ({shown.length})</h2>
              <select
                value={outcomeFilter}
                onChange={(e) => setOutcomeFilter(e.target.value as typeof outcomeFilter)}
                className="rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
              >
                <option value="all">All outcomes</option>
                <option value="pending">Pending</option>
                <option value="target">Target hit</option>
                <option value="stop">Stopped out</option>
                <option value="timeout">Timed out</option>
              </select>
            </div>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-muted">
                  <tr>
                    <th className="py-1 pr-3">Captured</th>
                    <th className="py-1 pr-3">Symbol</th>
                    <th className="py-1 pr-3">TF</th>
                    <th className="py-1 pr-3">Dir</th>
                    <th className="py-1 pr-3">Score</th>
                    <th className="py-1 pr-3">Entry</th>
                    <th className="py-1 pr-3">Stop</th>
                    <th className="py-1 pr-3">Target</th>
                    <th className="py-1 pr-3">Outcome</th>
                    <th className="py-1 pr-3">R</th>
                    <th className="py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s) => (
                    <tr key={s.id} className="border-t border-edge">
                      <td className="py-1 pr-3 whitespace-nowrap">{fmtTime(Math.floor(s.capturedAt / 1000))}</td>
                      <td className="py-1 pr-3 font-mono">{s.symbol}</td>
                      <td className="py-1 pr-3">{s.timeframe}</td>
                      <td className={`py-1 pr-3 font-bold uppercase ${s.direction === "long" ? "text-bull" : "text-bear"}`}>
                        {s.direction}
                      </td>
                      <td className="py-1 pr-3">{s.score}</td>
                      <td className="py-1 pr-3 font-mono">{fmtPrice(s.entry)}</td>
                      <td className="py-1 pr-3 font-mono">{fmtPrice(s.stopLoss)}</td>
                      <td className="py-1 pr-3 font-mono">{fmtPrice(s.takeProfit)}</td>
                      <td className="py-1 pr-3">
                        <OutcomeBadge outcome={s.outcome} />
                      </td>
                      <td
                        className={`py-1 pr-3 font-mono font-semibold ${
                          (s.rMultiple ?? 0) > 0 ? "text-bull" : (s.rMultiple ?? 0) < 0 ? "text-bear" : ""
                        }`}
                      >
                        {s.rMultiple !== null ? `${s.rMultiple >= 0 ? "+" : ""}${s.rMultiple.toFixed(2)}` : "—"}
                      </td>
                      <td className="py-1">
                        <button onClick={() => remove(s.id)} className="text-muted hover:text-bear">
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
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

function OutcomeBadge({ outcome }: { outcome: TrackedSignal["outcome"] }) {
  const cls =
    outcome === "target"
      ? "bg-bull/15 text-bull"
      : outcome === "stop"
        ? "bg-bear/15 text-bear"
        : outcome === "timeout"
          ? "bg-edge text-muted"
          : "bg-accent/15 text-accent";
  const label = outcome === "target" ? "target hit" : outcome === "stop" ? "stopped" : outcome;
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${cls}`}>{label}</span>;
}

function BucketTable({ title, buckets }: { title: string; buckets: SignalBucket[] }) {
  if (buckets.length === 0) return null;
  return (
    <section className="rounded-lg border border-edge bg-surface p-4">
      <h2 className="font-semibold">{title}</h2>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="py-1 pr-3">Name</th>
              <th className="py-1 pr-3">Signals</th>
              <th className="py-1 pr-3">T / S / TO</th>
              <th className="py-1 pr-3">Hit rate</th>
              <th className="py-1 pr-3">Avg R</th>
              <th className="py-1">Total R</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.name} className="border-t border-edge">
                <td className="py-1 pr-3">{b.name}</td>
                <td className="py-1 pr-3">{b.signals}</td>
                <td className="py-1 pr-3 font-mono">
                  {b.targets}/{b.stops}/{b.timeouts}
                </td>
                <td className="py-1 pr-3">{b.hitRate !== null ? `${b.hitRate.toFixed(0)}%` : "—"}</td>
                <td className={`py-1 pr-3 font-mono ${(b.avgR ?? 0) > 0 ? "text-bull" : (b.avgR ?? 0) < 0 ? "text-bear" : ""}`}>
                  {b.avgR !== null ? b.avgR.toFixed(2) : "—"}
                </td>
                <td className={`py-1 font-mono ${b.totalR > 0 ? "text-bull" : b.totalR < 0 ? "text-bear" : ""}`}>
                  {b.totalR >= 0 ? "+" : ""}
                  {b.totalR.toFixed(2)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
