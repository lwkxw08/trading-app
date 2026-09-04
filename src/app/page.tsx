"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import FavoritesHeatmap from "@/components/FavoritesHeatmap";
import OpportunityCard from "@/components/OpportunityCard";
import { apiUrl } from "@/components/api";
import { fmtCompact, fmtPct, fmtPrice, fmtTime } from "@/components/format";
import { useLiveTickers } from "@/components/useLiveMarket";
import type { DailyBriefing } from "@/lib/ai/analyze";
import type { EconomicEvent } from "@/lib/calendar/types";
import { MARKETS, MARKET_LABELS, type Market } from "@/lib/market/universe";
import { TIMEFRAMES, type Ticker, type Timeframe } from "@/lib/market/types";
import type { Opportunity } from "@/lib/strategies/types";

export default function CommandCenter() {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [events, setEvents] = useState<EconomicEvent[]>([]);
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [scanLoading, setScanLoading] = useState(true);
  const [tf, setTf] = useState<Timeframe>("4h");
  const [market, setMarket] = useState<Market>("crypto");
  const live = useLiveTickers(tickers.map((t) => t.symbol));

  useEffect(() => {
    setTickers([]);
    fetch(apiUrl(`/api/tickers?market=${market}`))
      .then((r) => r.json())
      .then((d) => setTickers(d.tickers ?? []))
      .catch(() => {});
  }, [market]);

  useEffect(() => {
    fetch(apiUrl("/api/calendar"))
      .then((r) => r.json())
      .then((d) => {
        const now = Date.now() / 1000;
        setEvents(
          ((d.events ?? []) as EconomicEvent[])
            .filter((e) => e.impact !== "low" && e.timestamp > now)
            .slice(0, 8),
        );
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setScanLoading(true);
    fetch(apiUrl(`/api/scan?tf=${tf}&market=${market}`))
      .then((r) => r.json())
      .then((d) => setOpportunities(d.opportunities ?? []))
      .catch(() => {})
      .finally(() => setScanLoading(false));
  }, [tf, market]);

  const loadBriefing = useCallback(() => {
    setBriefingLoading(true);
    setBriefingError(null);
    fetch(apiUrl(`/api/ai/briefing?tf=${tf}&market=${market}`))
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "briefing failed");
        setBriefing(d.briefing);
      })
      .catch((e) => setBriefingError(e.message))
      .finally(() => setBriefingLoading(false));
  }, [tf, market]);

  return (
    <div className="space-y-6">
      {/* Market selector */}
      <div className="flex items-center gap-1">
        {MARKETS.map((m) => (
          <button
            key={m}
            onClick={() => setMarket(m)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold ${
              m === market ? "bg-accent text-white" : "border border-edge bg-surface text-muted hover:text-foreground"
            }`}
          >
            {MARKET_LABELS[m]}
          </button>
        ))}
      </div>

      {/* Ticker strip */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        {tickers.map((base) => {
          const t = live[base.symbol] ?? base;
          return (
            <Link
              key={t.symbol}
              href={`/analyze/${t.symbol}`}
              className="min-w-36 shrink-0 rounded-lg border border-edge bg-surface px-3 py-2 hover:border-accent"
            >
              <div className="text-xs font-semibold">{t.symbol}</div>
              <div className="font-mono text-sm">{fmtPrice(t.lastPrice)}</div>
              <div className={`text-xs ${t.change24hPct >= 0 ? "text-bull" : "text-bear"}`}>
                {fmtPct(t.change24hPct)} · {fmtCompact(t.volume24h)}
              </div>
            </Link>
          );
        })}
      </div>

      <FavoritesHeatmap tf={tf} />

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* AI briefing */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">AI Daily Briefing</h2>
              <div className="flex items-center gap-1">
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
              <button
                onClick={loadBriefing}
                disabled={briefingLoading}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {briefingLoading ? "Analyzing markets…" : briefing ? "Refresh" : "Generate briefing"}
              </button>
            </div>
            {briefingError && <p className="mt-3 text-sm text-bear">{briefingError}</p>}
            {briefing ? (
              <div className="mt-3 space-y-3 text-sm">
                <p className="text-base font-semibold">{briefing.headline}</p>
                <div>
                  <div className="text-xs font-semibold uppercase text-muted">Market overview</div>
                  <p className="text-muted">{briefing.marketOverview}</p>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase text-muted">Top setups</div>
                  <p className="text-muted">{briefing.topSetups}</p>
                </div>
                <div>
                  <div className="text-xs font-semibold uppercase text-muted">Event watch</div>
                  <p className="text-muted">{briefing.eventWatch}</p>
                </div>
              </div>
            ) : (
              !briefingError && (
                <p className="mt-3 text-sm text-muted">
                  AI synthesis of the strategy engine&apos;s top setups, market movers and the macro calendar.
                </p>
              )
            )}
          </section>

          {/* Top opportunities */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Top Opportunities ({MARKET_LABELS[market]} · {tf} scan)</h2>
              <Link href="/scanner" className="text-xs text-accent hover:underline">
                Open scanner →
              </Link>
            </div>
            {scanLoading ? (
              <p className="text-sm text-muted">Scanning universe…</p>
            ) : opportunities.length === 0 ? (
              <p className="text-sm text-muted">No qualifying setups right now — the engine requires structural confluence.</p>
            ) : (
              <div className="grid gap-3 md:grid-cols-2">
                {opportunities.slice(0, 6).map((opp, i) => (
                  <OpportunityCard key={`${opp.symbol}-${opp.direction}-${i}`} opp={opp} />
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Upcoming events */}
        <section className="rounded-lg border border-edge bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Upcoming Macro Events</h2>
            <Link href="/calendar" className="text-xs text-accent hover:underline">
              Full calendar →
            </Link>
          </div>
          <ul className="mt-3 space-y-3">
            {events.length === 0 && <li className="text-sm text-muted">No medium/high-impact events loaded.</li>}
            {events.map((e, i) => (
              <li key={i} className="flex items-start justify-between gap-2 text-sm">
                <div>
                  <div>{e.title}</div>
                  <div className="text-xs text-muted">
                    {e.country} · {fmtTime(e.timestamp)}
                  </div>
                </div>
                <span
                  className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                    e.impact === "high" ? "bg-bear/20 text-bear" : "bg-accent/20 text-accent"
                  }`}
                >
                  {e.impact}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
