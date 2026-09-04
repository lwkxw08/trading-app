import type { Opportunity } from "@/lib/strategies/types";
import type { SignalBucket, SignalStats, TrackedSignal } from "./types";

const STORAGE_KEY = "tradeintel.signals.v1";
const MAX_SIGNALS = 500;
/** Skip re-capturing the same symbol/tf/direction setup within this window. */
const DEDUPE_MS = 4 * 60 * 60 * 1000;

export function loadSignals(): TrackedSignal[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as TrackedSignal[]) : [];
  } catch {
    return [];
  }
}

export function saveSignals(signals: TrackedSignal[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(signals.slice(0, MAX_SIGNALS)));
}

/** Adds new scanner opportunities, skipping recent duplicates. Returns updated list and count added. */
export function captureSignals(
  existing: TrackedSignal[],
  opportunities: Opportunity[],
  strategyName: string,
): { signals: TrackedSignal[]; added: number } {
  const now = Date.now();
  const fresh: TrackedSignal[] = [];
  for (const opp of opportunities) {
    const dup = [...existing, ...fresh].some(
      (s) =>
        s.symbol === opp.symbol &&
        s.timeframe === opp.timeframe &&
        s.direction === opp.direction &&
        now - s.capturedAt < DEDUPE_MS,
    );
    if (dup) continue;
    fresh.push({
      id: `sig-${now}-${opp.symbol}-${opp.direction}-${Math.random().toString(36).slice(2, 7)}`,
      capturedAt: now,
      strategyName,
      symbol: opp.symbol,
      timeframe: opp.timeframe,
      direction: opp.direction,
      score: opp.score,
      factors: opp.factors,
      entry: opp.entry,
      stopLoss: opp.stopLoss,
      takeProfit: opp.takeProfit,
      riskRewardRatio: opp.riskRewardRatio,
      generatedAt: opp.generatedAt,
      outcome: "pending",
      resolvedAt: null,
      exitPrice: null,
      rMultiple: null,
      barsToResolve: null,
    });
  }
  return { signals: [...fresh, ...existing].slice(0, MAX_SIGNALS), added: fresh.length };
}

function avg(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function bucket(name: string, items: TrackedSignal[]): SignalBucket {
  const resolved = items.filter((s) => s.outcome !== "pending");
  const targets = resolved.filter((s) => s.outcome === "target").length;
  const stops = resolved.filter((s) => s.outcome === "stop").length;
  const timeouts = resolved.filter((s) => s.outcome === "timeout").length;
  const rs = resolved.map((s) => s.rMultiple).filter((r): r is number => r !== null);
  return {
    name,
    signals: items.length,
    targets,
    stops,
    timeouts,
    hitRate: targets + stops > 0 ? (100 * targets) / (targets + stops) : null,
    avgR: avg(rs),
    totalR: Number(rs.reduce((s, r) => s + r, 0).toFixed(2)),
  };
}

function groupBy(signals: TrackedSignal[], key: (s: TrackedSignal) => string): SignalBucket[] {
  const map = new Map<string, TrackedSignal[]>();
  for (const s of signals) {
    const k = key(s);
    map.set(k, [...(map.get(k) ?? []), s]);
  }
  return [...map.entries()].map(([name, items]) => bucket(name, items)).sort((a, b) => b.signals - a.signals);
}

export function computeSignalStats(signals: TrackedSignal[]): SignalStats {
  const resolved = signals.filter((s) => s.outcome !== "pending");
  const targets = resolved.filter((s) => s.outcome === "target").length;
  const stops = resolved.filter((s) => s.outcome === "stop").length;
  const timeouts = resolved.filter((s) => s.outcome === "timeout").length;
  const rs = resolved.map((s) => s.rMultiple).filter((r): r is number => r !== null);

  const factorMap = new Map<string, TrackedSignal[]>();
  for (const s of signals) {
    for (const f of s.factors) {
      if (f.weight <= 0) continue;
      factorMap.set(f.name, [...(factorMap.get(f.name) ?? []), s]);
    }
  }

  return {
    total: signals.length,
    pending: signals.length - resolved.length,
    resolved: resolved.length,
    targets,
    stops,
    timeouts,
    hitRate: targets + stops > 0 ? (100 * targets) / (targets + stops) : null,
    avgR: avg(rs),
    totalR: Number(rs.reduce((s, r) => s + r, 0).toFixed(2)),
    byStrategy: groupBy(signals, (s) => s.strategyName),
    byDirection: groupBy(signals, (s) => s.direction),
    byTimeframe: groupBy(signals, (s) => s.timeframe),
    bySymbol: groupBy(signals, (s) => s.symbol),
    byFactor: [...factorMap.entries()].map(([name, items]) => bucket(name, items)).sort((a, b) => b.signals - a.signals),
  };
}
