import type { ClosedTradeMetrics, JournalStats, JournalTrade } from "./types";

const STORAGE_KEY = "tradeintel.journal.v1";

export function loadTrades(): JournalTrade[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as JournalTrade[]) : [];
  } catch {
    return [];
  }
}

export function saveTrades(trades: JournalTrade[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
}

export function tradeMetrics(t: JournalTrade): ClosedTradeMetrics | null {
  if (t.status !== "closed" || t.exitPrice === null) return null;
  const sign = t.direction === "long" ? 1 : -1;
  const pnlPerUnit = sign * (t.exitPrice - t.entryPrice);
  const risk = t.stopLoss !== null ? Math.abs(t.entryPrice - t.stopLoss) : 0;
  return {
    pnlPerUnit,
    pnl: t.size !== null ? pnlPerUnit * t.size : null,
    rMultiple: risk > 0 ? pnlPerUnit / risk : null,
    win: pnlPerUnit > 0,
  };
}

function avg(nums: number[]): number | null {
  return nums.length > 0 ? nums.reduce((s, n) => s + n, 0) / nums.length : null;
}

function bucketStats(items: { win: boolean; r: number | null }[]) {
  const wins = items.filter((i) => i.win).length;
  const rs = items.map((i) => i.r).filter((r): r is number => r !== null);
  return {
    trades: items.length,
    wins,
    winRate: items.length > 0 ? (100 * wins) / items.length : 0,
    avgR: avg(rs),
  };
}

export function computeStats(trades: JournalTrade[]): JournalStats {
  const closed = trades
    .map((t) => ({ trade: t, m: tradeMetrics(t) }))
    .filter((x): x is { trade: JournalTrade; m: ClosedTradeMetrics } => x.m !== null);

  const rs = closed.map((c) => c.m.rMultiple).filter((r): r is number => r !== null);
  const wins = closed.filter((c) => c.m.win);
  const losses = closed.filter((c) => !c.m.win);
  const grossWin = wins.reduce((s, c) => s + c.m.pnlPerUnit, 0);
  const grossLoss = Math.abs(losses.reduce((s, c) => s + c.m.pnlPerUnit, 0));

  const factorBuckets = new Map<string, { win: boolean; r: number | null }[]>();
  const strategyBuckets = new Map<string, { win: boolean; r: number | null }[]>();
  const directionBuckets = new Map<"long" | "short", { win: boolean; r: number | null }[]>();
  for (const { trade, m } of closed) {
    const item = { win: m.win, r: m.rMultiple };
    for (const f of trade.snapshot?.factors ?? []) {
      if (f.weight <= 0) continue;
      factorBuckets.set(f.name, [...(factorBuckets.get(f.name) ?? []), item]);
    }
    const strat = trade.strategyName || "Unlabeled";
    strategyBuckets.set(strat, [...(strategyBuckets.get(strat) ?? []), item]);
    directionBuckets.set(trade.direction, [...(directionBuckets.get(trade.direction) ?? []), item]);
  }

  return {
    total: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (100 * wins.length) / closed.length : null,
    avgR: avg(rs),
    expectancyR: avg(rs),
    bestR: rs.length > 0 ? Math.max(...rs) : null,
    worstR: rs.length > 0 ? Math.min(...rs) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    byFactor: [...factorBuckets.entries()]
      .map(([name, items]) => ({ name, ...bucketStats(items) }))
      .sort((a, b) => b.trades - a.trades),
    byStrategy: [...strategyBuckets.entries()]
      .map(([name, items]) => ({ name, ...bucketStats(items) }))
      .sort((a, b) => b.trades - a.trades),
    byDirection: [...directionBuckets.entries()].map(([direction, items]) => ({ direction, ...bucketStats(items) })),
  };
}
