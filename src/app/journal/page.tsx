"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { fmtPrice, fmtTime } from "@/components/format";
import type { JournalReview } from "@/lib/ai/analyze";
import { computeStats, loadTrades, saveTrades, tradeMetrics } from "@/lib/journal/store";
import type { JournalTrade, MarketSnapshot } from "@/lib/journal/types";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import type { Opportunity, StrategyAnalysis } from "@/lib/strategies/types";

type AnalysisPayload = { analysis: Omit<StrategyAnalysis, "candles">; opportunities: Opportunity[] };

export default function JournalPage() {
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [direction, setDirection] = useState<"long" | "short">("long");
  const [entryPrice, setEntryPrice] = useState("");
  const [size, setSize] = useState("");
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [strategyName, setStrategyName] = useState("");
  const [notes, setNotes] = useState("");
  const [addLoading, setAddLoading] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [closing, setClosing] = useState<Record<string, { exitPrice: string; exitNotes: string }>>({});

  const [review, setReview] = useState<JournalReview | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    setTrades(loadTrades());
    setLoaded(true);
  }, []);

  const persist = useCallback((next: JournalTrade[]) => {
    setTrades(next);
    saveTrades(next);
  }, []);

  const stats = useMemo(() => computeStats(trades), [trades]);

  const addTrade = useCallback(async () => {
    const entry = Number(entryPrice);
    if (!symbol.trim() || !Number.isFinite(entry) || entry <= 0) {
      setAddError("Symbol and a valid entry price are required");
      return;
    }
    setAddLoading(true);
    setAddError(null);

    // Capture the engine's read of the market at entry time so the AI review
    // can correlate outcomes with detected confluence.
    let snapshot: MarketSnapshot | null = null;
    try {
      const r = await fetch(apiUrl(`/api/analysis?symbol=${symbol.toUpperCase()}&tf=${tf}`));
      if (r.ok) {
        const d: AnalysisPayload = await r.json();
        const opp = d.opportunities.find((o) => o.direction === direction);
        snapshot = {
          trendDirection: d.analysis.trend.direction,
          htfDirection: d.analysis.higherTimeframeTrend?.direction,
          rsi14: d.analysis.trend.rsi14,
          confluenceScore: opp?.score ?? null,
          factors: opp?.factors ?? [],
        };
      }
    } catch {
      // snapshot is best-effort; the trade is still logged without it
    }

    const trade: JournalTrade = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: symbol.toUpperCase(),
      timeframe: tf,
      direction,
      status: "open",
      entryPrice: entry,
      entryTime: Date.now(),
      size: size ? Number(size) : null,
      stopLoss: stopLoss ? Number(stopLoss) : null,
      takeProfit: takeProfit ? Number(takeProfit) : null,
      strategyName: strategyName.trim(),
      notes: notes.trim(),
      snapshot,
      exitPrice: null,
      exitTime: null,
      exitNotes: "",
    };
    persist([trade, ...trades]);
    setEntryPrice("");
    setSize("");
    setStopLoss("");
    setTakeProfit("");
    setNotes("");
    setAddLoading(false);
  }, [symbol, tf, direction, entryPrice, size, stopLoss, takeProfit, strategyName, notes, trades, persist]);

  const closeTrade = useCallback(
    (id: string) => {
      const c = closing[id];
      const exit = Number(c?.exitPrice);
      if (!Number.isFinite(exit) || exit <= 0) return;
      persist(
        trades.map((t) =>
          t.id === id ? { ...t, status: "closed" as const, exitPrice: exit, exitTime: Date.now(), exitNotes: c.exitNotes.trim() } : t,
        ),
      );
      setClosing((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
    },
    [closing, trades, persist],
  );

  const deleteTrade = useCallback(
    (id: string) => persist(trades.filter((t) => t.id !== id)),
    [trades, persist],
  );

  const runReview = useCallback(() => {
    setReviewLoading(true);
    setReviewError(null);
    setReview(null);
    const payload = {
      trades: trades.map((t) => ({
        symbol: t.symbol,
        timeframe: t.timeframe,
        direction: t.direction,
        status: t.status,
        entryPrice: t.entryPrice,
        entryTime: t.entryTime,
        size: t.size,
        stopLoss: t.stopLoss,
        takeProfit: t.takeProfit,
        strategyName: t.strategyName,
        notes: t.notes,
        snapshot: t.snapshot,
        exitPrice: t.exitPrice,
        exitTime: t.exitTime,
        exitNotes: t.exitNotes,
        rMultiple: tradeMetrics(t)?.rMultiple ?? null,
      })),
      stats,
    };
    fetch(apiUrl("/api/journal/review"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "review failed");
        setReview(d.review);
      })
      .catch((e) => setReviewError(e.message))
      .finally(() => setReviewLoading(false));
  }, [trades, stats]);

  const inputCls = "rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none focus:border-accent";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Trade Journal</h1>
        <p className="text-sm text-muted">
          Log your trades with the engine&apos;s confluence read captured at entry, track your edge per factor and
          strategy, and let the AI coach suggest refinements. Stored locally in this browser.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* New trade */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Log a trade</h2>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <div className="[&>div]:w-full">
                <SymbolInput value={symbol} onChange={setSymbol} placeholder="Symbol" className={`${inputCls} w-full font-mono uppercase`} />
              </div>
              <select value={tf} onChange={(e) => setTf(e.target.value as Timeframe)} className={inputCls}>
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select value={direction} onChange={(e) => setDirection(e.target.value as "long" | "short")} className={inputCls}>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
              <input value={strategyName} onChange={(e) => setStrategyName(e.target.value)} placeholder="Strategy (optional)" className={inputCls} />
              <input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} placeholder="Entry price" inputMode="decimal" className={`${inputCls} font-mono`} />
              <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="Size (optional)" inputMode="decimal" className={`${inputCls} font-mono`} />
              <input value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="Stop loss" inputMode="decimal" className={`${inputCls} font-mono`} />
              <input value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="Take profit" inputMode="decimal" className={`${inputCls} font-mono`} />
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Why did you take this trade? (setup, reasoning, feelings…)"
              className={`${inputCls} mt-2 w-full`}
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={addTrade}
                disabled={addLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {addLoading ? "Capturing market snapshot…" : "Log trade"}
              </button>
              <span className="text-xs text-muted">The engine&apos;s confluence score &amp; factors are snapshotted automatically at entry.</span>
              {addError && <span className="text-xs text-bear">{addError}</span>}
            </div>
          </section>

          {/* Trades */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Trades</h2>
            {loaded && trades.length === 0 && <p className="mt-2 text-sm text-muted">No trades logged yet.</p>}
            <div className="mt-3 space-y-3">
              {trades.map((t) => {
                const m = tradeMetrics(t);
                const c = closing[t.id];
                return (
                  <div key={t.id} className="rounded-md border border-edge p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono font-semibold">{t.symbol}</span>
                        <span className="text-xs text-muted">{t.timeframe}</span>
                        <span className={`text-xs font-bold uppercase ${t.direction === "long" ? "text-bull" : "text-bear"}`}>{t.direction}</span>
                        {t.strategyName && <span className="rounded bg-background px-1.5 py-0.5 text-xs text-muted">{t.strategyName}</span>}
                        {t.snapshot?.confluenceScore !== null && t.snapshot?.confluenceScore !== undefined && (
                          <span className="text-xs text-muted">confluence {t.snapshot.confluenceScore}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 text-xs">
                        {t.status === "closed" && m ? (
                          <span className={`font-semibold ${m.win ? "text-bull" : "text-bear"}`}>
                            {m.rMultiple !== null ? `${m.rMultiple >= 0 ? "+" : ""}${m.rMultiple.toFixed(2)}R` : m.win ? "win" : "loss"}
                            {m.pnl !== null && ` · ${m.pnl >= 0 ? "+" : ""}${fmtPrice(Math.abs(m.pnl))}`}
                          </span>
                        ) : (
                          <span className="rounded bg-background px-1.5 py-0.5 uppercase text-muted">open</span>
                        )}
                        <button onClick={() => deleteTrade(t.id)} className="text-muted hover:text-bear">
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-4 font-mono text-xs text-muted sm:grid-cols-4">
                      <span>Entry {fmtPrice(t.entryPrice)}</span>
                      {t.stopLoss !== null && <span>SL {fmtPrice(t.stopLoss)}</span>}
                      {t.takeProfit !== null && <span>TP {fmtPrice(t.takeProfit)}</span>}
                      {t.exitPrice !== null && <span>Exit {fmtPrice(t.exitPrice)}</span>}
                    </div>
                    <p className="mt-1 text-xs text-muted">{fmtTime(Math.floor(t.entryTime / 1000))}{t.notes && ` — ${t.notes}`}</p>
                    {t.status === "open" && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-edge pt-2">
                        <input
                          value={c?.exitPrice ?? ""}
                          onChange={(e) => setClosing((prev) => ({ ...prev, [t.id]: { exitPrice: e.target.value, exitNotes: prev[t.id]?.exitNotes ?? "" } }))}
                          placeholder="Exit price"
                          inputMode="decimal"
                          className={`${inputCls} w-28 font-mono`}
                        />
                        <input
                          value={c?.exitNotes ?? ""}
                          onChange={(e) => setClosing((prev) => ({ ...prev, [t.id]: { exitPrice: prev[t.id]?.exitPrice ?? "", exitNotes: e.target.value } }))}
                          placeholder="Exit notes (optional)"
                          className={`${inputCls} flex-1`}
                        />
                        <button
                          onClick={() => closeTrade(t.id)}
                          disabled={!c?.exitPrice}
                          className="rounded-md border border-edge px-3 py-1 text-xs font-semibold hover:bg-edge disabled:opacity-50"
                        >
                          Close trade
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <div className="space-y-4">
          {/* Stats */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Performance</h2>
            <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <Stat label="Trades" value={`${stats.closed} closed / ${stats.open} open`} />
              <Stat label="Win rate" value={stats.winRate !== null ? `${stats.winRate.toFixed(0)}%` : "—"} />
              <Stat label="Avg R" value={stats.avgR !== null ? stats.avgR.toFixed(2) : "—"} />
              <Stat label="Profit factor" value={stats.profitFactor !== null ? stats.profitFactor.toFixed(2) : "—"} />
              <Stat label="Best R" value={stats.bestR !== null ? stats.bestR.toFixed(2) : "—"} />
              <Stat label="Worst R" value={stats.worstR !== null ? stats.worstR.toFixed(2) : "—"} />
            </div>
            {stats.byFactor.length > 0 && (
              <div className="mt-3">
                <h3 className="text-xs font-semibold uppercase text-muted">Edge by confluence factor</h3>
                <ul className="mt-1 space-y-1 text-xs">
                  {stats.byFactor.slice(0, 8).map((f) => (
                    <li key={f.name} className="flex justify-between">
                      <span>{f.name}</span>
                      <span className="font-mono text-muted">
                        {f.trades}t · {f.winRate.toFixed(0)}%{f.avgR !== null && ` · ${f.avgR.toFixed(2)}R`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {stats.byStrategy.length > 0 && (
              <div className="mt-3">
                <h3 className="text-xs font-semibold uppercase text-muted">By strategy</h3>
                <ul className="mt-1 space-y-1 text-xs">
                  {stats.byStrategy.map((s) => (
                    <li key={s.name} className="flex justify-between">
                      <span>{s.name}</span>
                      <span className="font-mono text-muted">
                        {s.trades}t · {s.winRate.toFixed(0)}%{s.avgR !== null && ` · ${s.avgR.toFixed(2)}R`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          {/* AI review */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">AI coach</h2>
              <button
                onClick={runReview}
                disabled={reviewLoading || trades.length === 0}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {reviewLoading ? "Analyzing…" : "Review my trading"}
              </button>
            </div>
            {reviewError && <p className="mt-2 text-xs text-bear">{reviewError}</p>}
            {!review && !reviewError && (
              <p className="mt-2 text-xs text-muted">
                The AI analyzes your entries/exits, the confluence detected at entry, and your per-factor results, then
                suggests concrete strategy refinements. Educational analysis, not financial advice.
              </p>
            )}
            {review && (
              <div className="mt-3 space-y-3 text-sm">
                <ReviewBlock title="Overview" text={review.overview} />
                <ReviewBlock title="Your edge" text={review.edgeAnalysis} />
                <ReviewBlock title="Execution" text={review.executionAnalysis} />
                <ReviewBlock title="Patterns" text={review.patterns} />
                {review.refinements.length > 0 && (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted">Suggested refinements</h3>
                    <ul className="mt-1 list-disc space-y-1 pl-4 text-xs">
                      {review.refinements.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <ReviewBlock title="Risk" text={review.riskAdvice} />
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-edge bg-background p-2">
      <div className="text-[10px] uppercase text-muted">{label}</div>
      <div className="text-sm font-semibold">{value}</div>
    </div>
  );
}

function ReviewBlock({ title, text }: { title: string; text: string }) {
  if (!text) return null;
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase text-muted">{title}</h3>
      <p className="mt-0.5 text-xs leading-relaxed">{text}</p>
    </div>
  );
}
