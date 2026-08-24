"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import OpportunityCard from "@/components/OpportunityCard";
import { fmtCompact, fmtPct, fmtPrice, fmtTime } from "@/components/format";
import type { DailyBriefing } from "@/lib/ai/analyze";
import type { EconomicEvent } from "@/lib/calendar/types";
import type { Ticker } from "@/lib/market/types";
import type { Opportunity } from "@/lib/strategies/types";

export default function CommandCenter() {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [events, setEvents] = useState<EconomicEvent[]>([]);
  const [briefing, setBriefing] = useState<DailyBriefing | null>(null);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [scanLoading, setScanLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tickers")
      .then((r) => r.json())
      .then((d) => setTickers(d.tickers ?? []))
      .catch(() => {});
    fetch("/api/scan?tf=4h")
      .then((r) => r.json())
      .then((d) => setOpportunities(d.opportunities ?? []))
      .catch(() => {})
      .finally(() => setScanLoading(false));
    fetch("/api/calendar")
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

  const loadBriefing = useCallback(() => {
    setBriefingLoading(true);
    setBriefingError(null);
    fetch("/api/ai/briefing")
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "briefing failed");
        setBriefing(d.briefing);
      })
      .catch((e) => setBriefingError(e.message))
      .finally(() => setBriefingLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      {/* Ticker strip */}
      <div className="flex gap-3 overflow-x-auto pb-1">
        {tickers.map((t) => (
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
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          {/* AI briefing */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">AI Daily Briefing</h2>
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
              <h2 className="font-semibold">Top Opportunities (4h scan)</h2>
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
