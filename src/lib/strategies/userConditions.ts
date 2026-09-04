import type { StrategyAnalysis } from "./types";

/**
 * User-built conditions: rules composed from deterministic metrics computed
 * off the same StrategyAnalysis the built-in conditions use. A condition is
 * a set of AND-ed clauses (metric, comparator, threshold). Rules are written
 * for the long side; by default the short side is evaluated with the mirrored
 * rule (oscillators reflect around 50, signed metrics negate, paired metrics
 * such as swing-high/low distance swap).
 */

export type MetricId =
  | "rsi14"
  | "price_vs_ema20"
  | "price_vs_ema50"
  | "price_vs_ema200"
  | "ema20_vs_ema50"
  | "macd_hist_pct"
  | "price_vs_poc"
  | "price_vs_vah"
  | "price_vs_val"
  | "price_vs_avwap"
  | "atr_pct"
  | "change_5_bars"
  | "change_20_bars"
  | "dist_swing_high_atr"
  | "dist_swing_low_atr";

export type MetricKind = "oscillator" | "signed" | "absolute";

export interface MetricMeta {
  id: MetricId;
  label: string;
  unit: string;
  kind: MetricKind;
  /** metric to substitute when mirroring the rule for shorts (paired metrics) */
  mirrorMetric?: MetricId;
  description: string;
}

export const METRIC_LIBRARY: MetricMeta[] = [
  { id: "rsi14", label: "RSI (14)", unit: "", kind: "oscillator", description: "Momentum oscillator, 0–100" },
  { id: "price_vs_ema20", label: "Price vs EMA20", unit: "%", kind: "signed", description: "Distance of price from EMA20 as % (positive = above)" },
  { id: "price_vs_ema50", label: "Price vs EMA50", unit: "%", kind: "signed", description: "Distance of price from EMA50 as % (positive = above)" },
  { id: "price_vs_ema200", label: "Price vs EMA200", unit: "%", kind: "signed", description: "Distance of price from EMA200 as % (positive = above)" },
  { id: "ema20_vs_ema50", label: "EMA20 vs EMA50", unit: "%", kind: "signed", description: "EMA20 distance from EMA50 as % (positive = bullish spread)" },
  { id: "macd_hist_pct", label: "MACD histogram", unit: "% of price", kind: "signed", description: "MACD histogram normalised as % of price (positive = bullish momentum)" },
  { id: "price_vs_poc", label: "Price vs POC", unit: "%", kind: "signed", description: "Distance of price from the volume-profile POC as % (positive = above)" },
  { id: "price_vs_vah", label: "Price vs VAH", unit: "%", kind: "signed", description: "Distance of price from value area high as % (positive = above)" },
  { id: "price_vs_val", label: "Price vs VAL", unit: "%", kind: "signed", description: "Distance of price from value area low as % (positive = above)" },
  { id: "price_vs_avwap", label: "Price vs Anchored VWAP", unit: "%", kind: "signed", description: "Distance of price from the anchored VWAP as % (positive = above)" },
  { id: "atr_pct", label: "ATR volatility", unit: "% of price", kind: "absolute", description: "ATR(14) as % of price — volatility filter, same for both directions" },
  { id: "change_5_bars", label: "Change over 5 bars", unit: "%", kind: "signed", description: "Close-to-close % change over the last 5 bars" },
  { id: "change_20_bars", label: "Change over 20 bars", unit: "%", kind: "signed", description: "Close-to-close % change over the last 20 bars" },
  { id: "dist_swing_high_atr", label: "Distance to recent swing high", unit: "ATR", kind: "absolute", mirrorMetric: "dist_swing_low_atr", description: "How far the most recent swing high above price is, in ATRs (mirrors to swing low for shorts)" },
  { id: "dist_swing_low_atr", label: "Distance to recent swing low", unit: "ATR", kind: "absolute", mirrorMetric: "dist_swing_high_atr", description: "How far the most recent swing low below price is, in ATRs (mirrors to swing high for shorts)" },
];

export const METRIC_IDS = METRIC_LIBRARY.map((m) => m.id);

export type ClauseOp = "lt" | "gt";

export interface UserClause {
  metric: MetricId;
  op: ClauseOp;
  value: number;
}

export interface UserCondition {
  id: string; // "uc-..."
  label: string;
  /** "mirror": shorts use the mirrored rule; "same": shorts use the rule as written */
  shortMode: "mirror" | "same";
  clauses: UserClause[];
}

function pctFrom(price: number, ref: number | null | undefined): number | null {
  if (ref === null || ref === undefined || ref === 0) return null;
  return ((price - ref) / ref) * 100;
}

export function metricValue(id: MetricId, a: StrategyAnalysis): number | null {
  const price = a.lastPrice;
  const atrVal = a.trend.atr14 ?? price * 0.01;
  switch (id) {
    case "rsi14":
      return a.trend.rsi14;
    case "price_vs_ema20":
      return pctFrom(price, a.trend.ema20);
    case "price_vs_ema50":
      return pctFrom(price, a.trend.ema50);
    case "price_vs_ema200":
      return pctFrom(price, a.trend.ema200);
    case "ema20_vs_ema50":
      return a.trend.ema20 !== null && a.trend.ema50 !== null && a.trend.ema50 !== 0
        ? ((a.trend.ema20 - a.trend.ema50) / a.trend.ema50) * 100
        : null;
    case "macd_hist_pct":
      return a.trend.macdHistogram !== null && price !== 0 ? (a.trend.macdHistogram / price) * 100 : null;
    case "price_vs_poc":
      return pctFrom(price, a.volumeProfile.poc);
    case "price_vs_vah":
      return pctFrom(price, a.volumeProfile.vah);
    case "price_vs_val":
      return pctFrom(price, a.volumeProfile.val);
    case "price_vs_avwap":
      return a.anchoredVwap ? pctFrom(price, a.anchoredVwap.value) : null;
    case "atr_pct":
      return price !== 0 ? (atrVal / price) * 100 : null;
    case "change_5_bars":
    case "change_20_bars": {
      const n = id === "change_5_bars" ? 5 : 20;
      const closes = a.candles;
      if (closes.length < n + 1) return null;
      const prev = closes[closes.length - 1 - n].close;
      return prev !== 0 ? ((closes[closes.length - 1].close - prev) / prev) * 100 : null;
    }
    case "dist_swing_high_atr": {
      const high = a.swings
        .slice(-10)
        .filter((s) => s.type === "high" && s.price > price)
        .map((s) => s.price)
        .sort((x, y) => x - y)[0];
      return high !== undefined && atrVal > 0 ? (high - price) / atrVal : null;
    }
    case "dist_swing_low_atr": {
      const low = a.swings
        .slice(-10)
        .filter((s) => s.type === "low" && s.price < price)
        .map((s) => s.price)
        .sort((x, y) => y - x)[0];
      return low !== undefined && atrVal > 0 ? (price - low) / atrVal : null;
    }
  }
}

/** The clause a short evaluation actually tests, given the condition's shortMode. */
function clauseForDirection(clause: UserClause, direction: "long" | "short", shortMode: UserCondition["shortMode"]): UserClause {
  if (direction === "long" || shortMode === "same") return clause;
  const meta = METRIC_LIBRARY.find((m) => m.id === clause.metric);
  if (!meta) return clause;
  if (meta.mirrorMetric) return { metric: meta.mirrorMetric, op: clause.op, value: clause.value };
  if (meta.kind === "oscillator") return { metric: clause.metric, op: clause.op === "lt" ? "gt" : "lt", value: 100 - clause.value };
  if (meta.kind === "signed") return { metric: clause.metric, op: clause.op === "lt" ? "gt" : "lt", value: -clause.value };
  return clause;
}

export function evaluateUserCondition(
  cond: UserCondition,
  a: StrategyAnalysis,
  direction: "long" | "short",
): { met: boolean; detail: string } {
  const parts: string[] = [];
  let met = cond.clauses.length > 0;
  for (const raw of cond.clauses) {
    const clause = clauseForDirection(raw, direction, cond.shortMode);
    const meta = METRIC_LIBRARY.find((m) => m.id === clause.metric);
    const value = metricValue(clause.metric, a);
    if (value === null) {
      met = false;
      parts.push(`${meta?.label ?? clause.metric}: no data`);
      continue;
    }
    const ok = clause.op === "lt" ? value < clause.value : value > clause.value;
    if (!ok) met = false;
    parts.push(`${meta?.label ?? clause.metric} ${value.toFixed(2)} ${clause.op === "lt" ? "<" : ">"} ${clause.value}${meta?.unit ? ` ${meta.unit}` : ""} ${ok ? "✓" : "✗"}`);
  }
  return { met, detail: parts.join(" · ") || "No clauses" };
}

/** Human-readable rule summary, e.g. for the condition picker and AI compose. */
export function describeUserCondition(cond: UserCondition): string {
  const rule = cond.clauses
    .map((c) => {
      const meta = METRIC_LIBRARY.find((m) => m.id === c.metric);
      return `${meta?.label ?? c.metric} ${c.op === "lt" ? "<" : ">"} ${c.value}${meta?.unit ? ` ${meta.unit}` : ""}`;
    })
    .join(" AND ");
  return `${rule}${cond.shortMode === "mirror" ? " (mirrored for shorts)" : " (same rule both directions)"}`;
}

const STORAGE_KEY = "tradeintel.userconditions.v1";
const MAX_CONDITIONS = 40;

export function loadUserConditions(): UserCondition[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as UserCondition[]) : [];
  } catch {
    return [];
  }
}

export function saveUserConditions(list: UserCondition[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_CONDITIONS)));
}

export function newUserConditionId(): string {
  return `uc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
