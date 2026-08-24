"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import { fmtPct, fmtPrice } from "./format";
import { useFavorites } from "./useFavorites";
import { useLiveTickers } from "./useLiveMarket";
import type { Ticker, Timeframe } from "@/lib/market/types";
import type { Opportunity } from "@/lib/strategies/types";

function tileColor(changePct: number): string {
  if (changePct >= 3) return "bg-bull/30 border-bull/40";
  if (changePct >= 1) return "bg-bull/15 border-bull/25";
  if (changePct > 0) return "bg-bull/5 border-edge";
  if (changePct <= -3) return "bg-bear/30 border-bear/40";
  if (changePct <= -1) return "bg-bear/15 border-bear/25";
  if (changePct < 0) return "bg-bear/5 border-edge";
  return "bg-surface border-edge";
}

export default function FavoritesHeatmap({ tf }: { tf: Timeframe }) {
  const { favorites } = useFavorites();
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [setups, setSetups] = useState<Record<string, Opportunity>>({});
  const live = useLiveTickers(favorites);
  const key = favorites.join(",");

  useEffect(() => {
    if (favorites.length === 0) {
      setTickers([]);
      return;
    }
    fetch(apiUrl(`/api/tickers?symbols=${key}`))
      .then((r) => r.json())
      .then((d) => setTickers(d.tickers ?? []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    if (favorites.length === 0) {
      setSetups({});
      return;
    }
    fetch(apiUrl(`/api/scan?tf=${tf}&symbols=${key}`))
      .then((r) => r.json())
      .then((d) => {
        const best: Record<string, Opportunity> = {};
        for (const opp of (d.opportunities ?? []) as Opportunity[]) {
          if (!best[opp.symbol] || opp.score > best[opp.symbol].score) best[opp.symbol] = opp;
        }
        setSetups(best);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tf]);

  const merged = useMemo(() => {
    const bySymbol = new Map(tickers.map((t) => [t.symbol, t]));
    return favorites.map((s) => live[s] ?? bySymbol.get(s) ?? null);
  }, [favorites, tickers, live]);

  if (favorites.length === 0) return null;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">
          <span className="mr-1 text-amber-400">★</span>Favourites Heatmap
        </h2>
        <span className="text-xs text-muted">24h change · setup scores on {tf}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
        {favorites.map((symbol, i) => {
          const t = merged[i];
          const setup = setups[symbol];
          return (
            <Link
              key={symbol}
              href={`/analyze/${symbol}?tf=${tf}`}
              className={`rounded-lg border p-3 transition hover:brightness-125 ${tileColor(t?.change24hPct ?? 0)}`}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-sm font-semibold">{symbol}</span>
                {setup && (
                  <span
                    className={`shrink-0 rounded px-1 py-0.5 text-[10px] font-bold uppercase ${
                      setup.direction === "long" ? "bg-bull/30 text-bull" : "bg-bear/30 text-bear"
                    }`}
                  >
                    {setup.direction} {setup.score}
                  </span>
                )}
              </div>
              {t ? (
                <>
                  <div className="mt-1 font-mono text-sm">{fmtPrice(t.lastPrice)}</div>
                  <div className={`text-xs font-semibold ${t.change24hPct >= 0 ? "text-bull" : "text-bear"}`}>
                    {fmtPct(t.change24hPct)}
                  </div>
                </>
              ) : (
                <div className="mt-1 text-xs text-muted">no data</div>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
