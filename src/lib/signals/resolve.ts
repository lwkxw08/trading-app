import { apiUrl } from "@/components/api";
import type { Candle } from "@/lib/market/types";
import type { TrackedSignal } from "./types";

/** Bars a signal may run before it is closed out as a timeout at that bar's close. */
const MAX_BARS = 100;

function resolveAgainst(signal: TrackedSignal, candles: Candle[]): TrackedSignal {
  const entrySec = Math.floor(signal.capturedAt / 1000);
  const after = candles.filter((c) => c.time > entrySec);
  if (after.length === 0) return signal;

  const sign = signal.direction === "long" ? 1 : -1;
  const risk = Math.abs(signal.entry - signal.stopLoss);

  for (let i = 0; i < after.length; i++) {
    const bar = after[i];
    const hitStop = signal.direction === "long" ? bar.low <= signal.stopLoss : bar.high >= signal.stopLoss;
    const hitTarget = signal.direction === "long" ? bar.high >= signal.takeProfit : bar.low <= signal.takeProfit;
    // Conservative: a bar touching both stop and target counts as a stop.
    if (hitStop) {
      return {
        ...signal,
        outcome: "stop",
        resolvedAt: bar.time * 1000,
        exitPrice: signal.stopLoss,
        rMultiple: -1,
        barsToResolve: i + 1,
      };
    }
    if (hitTarget) {
      return {
        ...signal,
        outcome: "target",
        resolvedAt: bar.time * 1000,
        exitPrice: signal.takeProfit,
        rMultiple: risk > 0 ? Math.abs(signal.takeProfit - signal.entry) / risk : 0,
        barsToResolve: i + 1,
      };
    }
    if (i + 1 >= MAX_BARS) {
      const pnl = sign * (bar.close - signal.entry);
      return {
        ...signal,
        outcome: "timeout",
        resolvedAt: bar.time * 1000,
        exitPrice: bar.close,
        rMultiple: risk > 0 ? pnl / risk : 0,
        barsToResolve: i + 1,
      };
    }
  }
  return signal; // still pending — not enough bars elapsed yet
}

/** Resolves pending signals against market data fetched per symbol/timeframe. */
export async function resolveSignals(signals: TrackedSignal[]): Promise<{ signals: TrackedSignal[]; resolved: number }> {
  const pending = signals.filter((s) => s.outcome === "pending");
  if (pending.length === 0) return { signals, resolved: 0 };

  const groups = new Map<string, TrackedSignal[]>();
  for (const s of pending) {
    const key = `${s.symbol}|${s.timeframe}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }

  const updates = new Map<string, TrackedSignal>();
  await Promise.all(
    [...groups.entries()].map(async ([key, group]) => {
      const [symbol, tf] = key.split("|");
      try {
        const res = await fetch(apiUrl(`/api/klines?symbol=${encodeURIComponent(symbol)}&tf=${tf}&limit=1000`));
        if (!res.ok) return;
        const data = (await res.json()) as { candles: Candle[] };
        for (const s of group) {
          const next = resolveAgainst(s, data.candles);
          if (next.outcome !== "pending") updates.set(s.id, next);
        }
      } catch {
        // leave this group pending on fetch failure
      }
    }),
  );

  if (updates.size === 0) return { signals, resolved: 0 };
  return {
    signals: signals.map((s) => updates.get(s.id) ?? s),
    resolved: updates.size,
  };
}
