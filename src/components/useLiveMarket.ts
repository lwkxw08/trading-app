"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/components/api";
import { isCryptoSymbol } from "@/lib/market/symbols";
import type { Candle, Ticker, Timeframe } from "@/lib/market/types";

// data-stream.binance.vision mirrors the market-data streams for regions
// where stream.binance.com is geo-restricted.
const WS_HOSTS = ["wss://stream.binance.com:9443", "wss://data-stream.binance.vision"];

interface MiniTickerMsg {
  s: string; // symbol
  c: string; // close
  o: string; // open 24h ago
  q: string; // quote volume 24h
}

interface KlineMsg {
  k: {
    t: number; // open time ms
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
  };
}

function connect(streams: string[], onMessage: (data: unknown) => void): () => void {
  let ws: WebSocket | null = null;
  let hostIdx = 0;
  let closed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed || streams.length === 0) return;
    ws = new WebSocket(`${WS_HOSTS[hostIdx % WS_HOSTS.length]}/stream?streams=${streams.join("/")}`);
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string);
        onMessage(parsed.data ?? parsed);
      } catch {
        // ignore malformed frames
      }
    };
    ws.onclose = () => {
      if (closed) return;
      hostIdx += 1;
      retryTimer = setTimeout(open, 2000);
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    ws?.close();
  };
}

/**
 * Streams 24h mini-ticker updates for the given symbols; returns a symbol → Ticker map.
 * Crypto symbols stream over the Binance websocket; stocks/forex symbols poll
 * the tickers API instead (no public websocket on the free data tier).
 */
export function useLiveTickers(symbols: string[]): Record<string, Ticker> {
  const [tickers, setTickers] = useState<Record<string, Ticker>>({});
  const key = symbols.join(",");
  const pendingRef = useRef<Record<string, Ticker>>({});

  useEffect(() => {
    const polled = symbols.filter((s) => !isCryptoSymbol(s));
    if (polled.length === 0) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/tickers?symbols=${encodeURIComponent(polled.join(","))}`));
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { tickers?: Ticker[] };
        const update: Record<string, Ticker> = {};
        for (const t of data.tickers ?? []) update[t.symbol] = t;
        if (!cancelled && Object.keys(update).length > 0) setTickers((prev) => ({ ...prev, ...update }));
      } catch {
        // transient network error — next poll retries
      }
    };
    poll();
    const timer = setInterval(poll, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const streamed = symbols.filter(isCryptoSymbol);
    if (streamed.length === 0) return;
    const streams = streamed.map((s) => `${s.toLowerCase()}@miniTicker`);
    // Batch updates on a short interval so rapid frames don't thrash renders.
    const flush = setInterval(() => {
      const pending = pendingRef.current;
      if (Object.keys(pending).length === 0) return;
      pendingRef.current = {};
      setTickers((prev) => ({ ...prev, ...pending }));
    }, 1000);

    const close = connect(streams, (data) => {
      const t = data as MiniTickerMsg;
      if (!t.s || !t.c) return;
      const close_ = parseFloat(t.c);
      const open_ = parseFloat(t.o);
      pendingRef.current[t.s] = {
        symbol: t.s,
        lastPrice: close_,
        change24hPct: open_ > 0 ? ((close_ - open_) / open_) * 100 : 0,
        volume24h: parseFloat(t.q),
      };
    });
    return () => {
      clearInterval(flush);
      close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return tickers;
}

/**
 * Streams live kline updates for one symbol/timeframe; returns the latest
 * in-progress candle. Crypto uses the Binance websocket; stocks/forex poll the
 * klines API on a short interval instead.
 */
export function useLiveKline(symbol: string, tf: Timeframe): Candle | null {
  const [candle, setCandle] = useState<Candle | null>(null);

  useEffect(() => {
    setCandle(null);
    if (!symbol || isCryptoSymbol(symbol)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(apiUrl(`/api/klines?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=1`));
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { candles?: Candle[] };
        const last = data.candles?.[data.candles.length - 1];
        if (!cancelled && last) setCandle(last);
      } catch {
        // transient network error — next poll retries
      }
    };
    const timer = setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbol, tf]);

  useEffect(() => {
    if (!symbol || !isCryptoSymbol(symbol)) return;
    const close = connect([`${symbol.toLowerCase()}@kline_${tf}`], (data) => {
      const m = data as KlineMsg;
      if (!m.k) return;
      setCandle({
        time: Math.floor(m.k.t / 1000),
        open: parseFloat(m.k.o),
        high: parseFloat(m.k.h),
        low: parseFloat(m.k.l),
        close: parseFloat(m.k.c),
        volume: parseFloat(m.k.v),
      });
    });
    return close;
  }, [symbol, tf]);

  return candle;
}
