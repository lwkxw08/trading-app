import { buildTradeLevels } from "./confluence";
import type { StrategyAnalysis } from "./types";

/**
 * Per-strategy risk settings: how the stop-loss is placed and how the target
 * is derived. Rules are structural (swing/HVN) or mechanical (ATR/percent/RR),
 * with the default falling back to the shared structure-based levels.
 */

export type StopRule =
  | { type: "default" }
  | { type: "atr"; multiple: number }
  | { type: "percent"; percent: number }
  | { type: "swing"; bufferAtr: number }
  | { type: "hvn"; bufferAtr: number };

export type TargetRule =
  | { type: "default" }
  | { type: "rr"; ratio: number }
  | { type: "atr"; multiple: number }
  | { type: "swing" }
  | { type: "hvn" };

export interface RiskSettings {
  stop: StopRule;
  target: TargetRule;
}

export const DEFAULT_RISK: RiskSettings = { stop: { type: "default" }, target: { type: "default" } };

export function describeStopRule(rule: StopRule): string {
  switch (rule.type) {
    case "default":
      return "Structure default (beyond recent swing, ATR fallback)";
    case "atr":
      return `${rule.multiple}× ATR from entry`;
    case "percent":
      return `${rule.percent}% from entry`;
    case "swing":
      return `Beyond recent swing low/high + ${rule.bufferAtr} ATR buffer`;
    case "hvn":
      return `Beyond nearest HVN on the stop side + ${rule.bufferAtr} ATR buffer`;
  }
}

export function describeTargetRule(rule: TargetRule): string {
  switch (rule.type) {
    case "default":
      return "Structure default (opposing structure or 2R)";
    case "rr":
      return `${rule.ratio}R (risk multiple of the stop distance)`;
    case "atr":
      return `${rule.multiple}× ATR from entry`;
    case "swing":
      return "Next swing high/low in trade direction";
    case "hvn":
      return "Next HVN in trade direction";
  }
}

/** Entry/SL/TP using the strategy's risk rules, falling back to the shared structure defaults. */
export function buildRiskTradeLevels(
  a: StrategyAnalysis,
  direction: "long" | "short",
  risk: RiskSettings,
): { entry: number; stopLoss: number; takeProfit: number; riskRewardRatio: number } {
  const fallback = buildTradeLevels(a, direction);
  const price = a.lastPrice;
  const atrVal = a.trend.atr14 ?? price * 0.01;
  const bull = direction === "long";
  const entry = price;

  const recentSwings = a.swings.slice(-10);
  const swingLow = recentSwings.filter((s) => s.type === "low" && s.price < price).map((s) => s.price).sort((x, y) => y - x)[0];
  const swingHigh = recentSwings.filter((s) => s.type === "high" && s.price > price).map((s) => s.price).sort((x, y) => x - y)[0];
  const hvnBelow = a.volumeProfile.hvns.filter((n) => n.price < price).map((n) => n.price).sort((x, y) => y - x)[0];
  const hvnAbove = a.volumeProfile.hvns.filter((n) => n.price > price).map((n) => n.price).sort((x, y) => x - y)[0];

  let stopLoss: number;
  switch (risk.stop.type) {
    case "default":
      stopLoss = fallback.stopLoss;
      break;
    case "atr":
      stopLoss = bull ? entry - risk.stop.multiple * atrVal : entry + risk.stop.multiple * atrVal;
      break;
    case "percent":
      stopLoss = bull ? entry * (1 - risk.stop.percent / 100) : entry * (1 + risk.stop.percent / 100);
      break;
    case "swing": {
      const level = bull ? swingLow : swingHigh;
      stopLoss =
        level !== undefined
          ? bull
            ? Math.min(level - risk.stop.bufferAtr * atrVal, entry - 0.25 * atrVal)
            : Math.max(level + risk.stop.bufferAtr * atrVal, entry + 0.25 * atrVal)
          : fallback.stopLoss;
      break;
    }
    case "hvn": {
      const level = bull ? hvnBelow : hvnAbove;
      stopLoss =
        level !== undefined
          ? bull
            ? Math.min(level - risk.stop.bufferAtr * atrVal, entry - 0.25 * atrVal)
            : Math.max(level + risk.stop.bufferAtr * atrVal, entry + 0.25 * atrVal)
          : fallback.stopLoss;
      break;
    }
  }

  const stopDistance = Math.abs(entry - stopLoss);
  let takeProfit: number;
  switch (risk.target.type) {
    case "default":
      takeProfit = fallback.takeProfit;
      break;
    case "rr":
      takeProfit = bull ? entry + risk.target.ratio * stopDistance : entry - risk.target.ratio * stopDistance;
      break;
    case "atr":
      takeProfit = bull ? entry + risk.target.multiple * atrVal : entry - risk.target.multiple * atrVal;
      break;
    case "swing": {
      const level = bull ? swingHigh : swingLow;
      takeProfit = level !== undefined ? level : fallback.takeProfit;
      break;
    }
    case "hvn": {
      const level = bull ? hvnAbove : hvnBelow;
      takeProfit = level !== undefined ? level : fallback.takeProfit;
      break;
    }
  }
  // A target on the wrong side of entry (structure missing/inverted) falls back.
  if ((bull && takeProfit <= entry) || (!bull && takeProfit >= entry)) takeProfit = fallback.takeProfit;

  const reward = Math.abs(takeProfit - entry);
  return { entry, stopLoss, takeProfit, riskRewardRatio: stopDistance > 0 ? reward / stopDistance : 0 };
}
