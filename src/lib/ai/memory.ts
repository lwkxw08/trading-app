import type { JournalTrade } from "@/lib/journal/types";
import { tradeMetrics } from "@/lib/journal/store";
import type { Timeframe } from "@/lib/market/types";
import type { TrackedSignal } from "@/lib/signals/types";

/**
 * Personal pattern memory: compact, deterministic statistics derived from the
 * user's resolved tracked signals and journal trades, sent alongside AI
 * requests so advice can reference what has actually been winning or losing
 * for THIS user — per symbol, timeframe, factor and strategy.
 */

export interface MemoryBucket {
  name: string;
  resolved: number;
  hitRate: number | null; // % of resolved signals that hit target (vs stop)
  avgR: number | null;
}

export interface PatternMemory {
  signalsResolved: number;
  signalsHitRate: number | null;
  signalsAvgR: number | null;
  journalClosed: number;
  journalWinRate: number | null;
  journalAvgR: number | null;
  thisSymbol: MemoryBucket | null;
  thisSymbolTimeframe: MemoryBucket | null;
  strongestFactors: MemoryBucket[];
  weakestFactors: MemoryBucket[];
  journalByStrategy: MemoryBucket[];
}

const MIN_BUCKET = 3; // resolved outcomes needed before a bucket is reported

function signalBucket(name: string, items: TrackedSignal[]): MemoryBucket | null {
  const resolved = items.filter((s) => s.outcome === "target" || s.outcome === "stop");
  if (resolved.length < MIN_BUCKET) return null;
  const targets = resolved.filter((s) => s.outcome === "target").length;
  const rs = resolved.map((s) => s.rMultiple).filter((r): r is number => r !== null);
  return {
    name,
    resolved: resolved.length,
    hitRate: Number(((100 * targets) / resolved.length).toFixed(1)),
    avgR: rs.length > 0 ? Number((rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(2)) : null,
  };
}

export function buildPatternMemory(
  signals: TrackedSignal[],
  trades: JournalTrade[],
  symbol?: string,
  timeframe?: Timeframe,
): PatternMemory | null {
  const resolvedSignals = signals.filter((s) => s.outcome === "target" || s.outcome === "stop");
  const closedTrades = trades
    .map((t) => ({ t, m: tradeMetrics(t) }))
    .filter((x): x is { t: JournalTrade; m: NonNullable<ReturnType<typeof tradeMetrics>> } => x.m !== null);
  if (resolvedSignals.length === 0 && closedTrades.length === 0) return null;

  const targets = resolvedSignals.filter((s) => s.outcome === "target").length;
  const signalRs = resolvedSignals.map((s) => s.rMultiple).filter((r): r is number => r !== null);
  const journalRs = closedTrades.map((x) => x.m.rMultiple).filter((r): r is number => r !== null);
  const journalWins = closedTrades.filter((x) => x.m.win).length;

  // Per-factor buckets across resolved signals
  const factorMap = new Map<string, TrackedSignal[]>();
  for (const s of resolvedSignals) {
    for (const f of s.factors) {
      if (f.weight <= 0) continue;
      factorMap.set(f.name, [...(factorMap.get(f.name) ?? []), s]);
    }
  }
  const factorBuckets = [...factorMap.entries()]
    .map(([name, items]) => signalBucket(name, items))
    .filter((b): b is MemoryBucket => b !== null)
    .sort((a, b) => (b.avgR ?? 0) - (a.avgR ?? 0));

  // Journal per-strategy buckets
  const strategyMap = new Map<string, { win: boolean; r: number | null }[]>();
  for (const { t, m } of closedTrades) {
    const key = t.strategyName || "Unlabeled";
    strategyMap.set(key, [...(strategyMap.get(key) ?? []), { win: m.win, r: m.rMultiple }]);
  }
  const journalByStrategy = [...strategyMap.entries()]
    .filter(([, items]) => items.length >= MIN_BUCKET)
    .map(([name, items]) => {
      const wins = items.filter((i) => i.win).length;
      const rs = items.map((i) => i.r).filter((r): r is number => r !== null);
      return {
        name,
        resolved: items.length,
        hitRate: Number(((100 * wins) / items.length).toFixed(1)),
        avgR: rs.length > 0 ? Number((rs.reduce((s, r) => s + r, 0) / rs.length).toFixed(2)) : null,
      };
    })
    .sort((a, b) => b.resolved - a.resolved)
    .slice(0, 6);

  return {
    signalsResolved: resolvedSignals.length,
    signalsHitRate: resolvedSignals.length > 0 ? Number(((100 * targets) / resolvedSignals.length).toFixed(1)) : null,
    signalsAvgR: signalRs.length > 0 ? Number((signalRs.reduce((s, r) => s + r, 0) / signalRs.length).toFixed(2)) : null,
    journalClosed: closedTrades.length,
    journalWinRate: closedTrades.length > 0 ? Number(((100 * journalWins) / closedTrades.length).toFixed(1)) : null,
    journalAvgR: journalRs.length > 0 ? Number((journalRs.reduce((s, r) => s + r, 0) / journalRs.length).toFixed(2)) : null,
    thisSymbol: symbol ? signalBucket(symbol, resolvedSignals.filter((s) => s.symbol === symbol)) : null,
    thisSymbolTimeframe:
      symbol && timeframe
        ? signalBucket(`${symbol} ${timeframe}`, resolvedSignals.filter((s) => s.symbol === symbol && s.timeframe === timeframe))
        : null,
    strongestFactors: factorBuckets.slice(0, 4),
    weakestFactors: factorBuckets.slice(-4).reverse().filter((b) => (b.avgR ?? 0) < 0 || (b.hitRate ?? 100) < 50),
    journalByStrategy,
  };
}

/** Runtime shape check for memory payloads sent from the browser. */
export function sanitizePatternMemory(input: unknown): PatternMemory | null {
  if (typeof input !== "object" || input === null) return null;
  const m = input as Record<string, unknown>;
  if (typeof m.signalsResolved !== "number" || typeof m.journalClosed !== "number") return null;
  // Cap array sizes so a malformed payload can't blow up the prompt.
  const capBuckets = (v: unknown): MemoryBucket[] =>
    Array.isArray(v)
      ? v
          .filter(
            (b): b is MemoryBucket =>
              typeof b === "object" && b !== null && typeof (b as MemoryBucket).name === "string" && typeof (b as MemoryBucket).resolved === "number",
          )
          .slice(0, 8)
          .map((b) => ({ ...b, name: b.name.slice(0, 60) }))
      : [];
  const bucketOrNull = (v: unknown): MemoryBucket | null => capBuckets(v ? [v] : [])[0] ?? null;
  return {
    signalsResolved: m.signalsResolved,
    signalsHitRate: typeof m.signalsHitRate === "number" ? m.signalsHitRate : null,
    signalsAvgR: typeof m.signalsAvgR === "number" ? m.signalsAvgR : null,
    journalClosed: m.journalClosed,
    journalWinRate: typeof m.journalWinRate === "number" ? m.journalWinRate : null,
    journalAvgR: typeof m.journalAvgR === "number" ? m.journalAvgR : null,
    thisSymbol: bucketOrNull(m.thisSymbol),
    thisSymbolTimeframe: bucketOrNull(m.thisSymbolTimeframe),
    strongestFactors: capBuckets(m.strongestFactors),
    weakestFactors: capBuckets(m.weakestFactors),
    journalByStrategy: capBuckets(m.journalByStrategy),
  };
}
