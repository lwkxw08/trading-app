"use client";

import { useCallback, useEffect, useState } from "react";
import OpportunityCard from "@/components/OpportunityCard";
import { apiUrl } from "@/components/api";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import type { Opportunity } from "@/lib/strategies/types";

export default function Scanner() {
  const [tf, setTf] = useState<Timeframe>("4h");
  const [symbols, setSymbols] = useState("");
  const [direction, setDirection] = useState<"all" | "long" | "short">("all");
  const [minScore, setMinScore] = useState(40);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [meta, setMeta] = useState<{ scanned: number; errors: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const scan = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams({ tf });
    if (symbols.trim()) params.set("symbols", symbols.trim());
    fetch(apiUrl(`/api/scan?${params}`))
      .then((r) => r.json())
      .then((d) => {
        setOpportunities(d.opportunities ?? []);
        setMeta({ scanned: d.scanned ?? 0, errors: d.errors ?? 0 });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [tf, symbols]);

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
          <input
            value={symbols}
            onChange={(e) => setSymbols(e.target.value)}
            placeholder="BTCUSDT, ETHUSDT, SOLUSDT…"
            className="mt-1 w-full rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
          />
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
