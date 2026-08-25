"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "./api";
import type { Ticker } from "@/lib/market/types";

/** Polls last prices for a set of symbols (mixed providers supported). */
export function usePrices(symbols: string[], intervalMs = 60000): Record<string, number> {
  const [prices, setPrices] = useState<Record<string, number>>({});
  const key = useMemo(() => [...new Set(symbols.map((s) => s.toUpperCase()))].sort().join(","), [symbols]);

  useEffect(() => {
    if (!key) {
      setPrices({});
      return;
    }
    let cancelled = false;
    const load = () => {
      fetch(apiUrl(`/api/tickers?symbols=${key}`))
        .then((r) => r.json())
        .then((d) => {
          if (cancelled || !Array.isArray(d.tickers)) return;
          setPrices(Object.fromEntries((d.tickers as Ticker[]).map((t) => [t.symbol, t.lastPrice])));
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [key, intervalMs]);

  return prices;
}
