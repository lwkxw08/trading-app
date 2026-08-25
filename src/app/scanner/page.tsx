"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import OpportunityCard from "@/components/OpportunityCard";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { MARKETS, MARKET_LABELS, type Market } from "@/lib/market/universe";
import { captureSignals, loadSignals, saveSignals } from "@/lib/signals/store";
import type { Opportunity } from "@/lib/strategies/types";

export default function Scanner() {
  const [tf, setTf] = useState<Timeframe>("4h");
  const [market, setMarket] = useState<Market>("crypto");
  const [symbols, setSymbols] = useState("");
  const [direction, setDirection] = useState<"all" | "long" | "short">("all");
  const [minScore, setMinScore] = useState(40);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [meta, setMeta] = useState<{ scanned: number; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [track, setTrack] = useState(true);
  const [tracked, setTracked] = useState<number | null>(null);

  const scan = useCallback(() => {
    setLoading(true);
    setTracked(null);
    const params = new URLSearchParams({ tf, market });
    if (symbols.trim()) params.set("symbols", symbols.trim());
    fetch(apiUrl(`/api/scan?${params}`))
      .then((r) => r.json())
      .then((d) => {
        const opps: Opportunity[] = d.opportunities ?? [];
        setOpportunities(opps);
        setMeta({ scanned: d.scanned ?? 0, errors: d.errors ?? 0 });
        if (track) {
          const qualifying = opps.filter((o) => o.score >= minScore && (direction === "all" || o.direction === direction));
          const { signals, added } = captureSignals(loadSignals(), qualifying, "Built-in confluence");
          if (added > 0) saveSignals(signals);
          setTracked(added);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tf, market, symbols, track, minScore, direction]);

  useEffect(() => {
    scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = opportunities.filter(
    (o) => o.score >= minScore && (direction === "all" || o.direction === direction),
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
            min={40}
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
          <OpportunityCard key={`${opp.symbol}-${opp.direction}-${i}`} opp={opp} />
        ))}
      </div>
      {!loading && filtered.length === 0 && (
        <p className="text-sm text-muted">No setups match the current filters.</p>
      )}
    </div>
  );
}
