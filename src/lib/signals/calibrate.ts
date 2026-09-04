import { CONDITION_LIBRARY, type ConditionId, type CustomStrategy } from "@/lib/strategies/custom";
import type { Timeframe } from "@/lib/market/types";
import type { TrackedSignal } from "./types";

/**
 * Evidence-based weight calibration: resolved tracked signals are grouped by
 * confluence factor, and each factor's live hit rate and average R scale its
 * default weight up or down. Factors without enough resolved signals keep
 * their defaults. The output maps onto Strategy Lab conditions so the
 * calibrated weights are usable for live evaluation, scanning and backtests.
 */

/** Confluence factor names → the Strategy Lab condition evaluating the same structure. */
const FACTOR_TO_CONDITION: Record<string, ConditionId> = {
  "Fair Value Gap": "fvg_retest",
  "Order Block": "order_block",
  "Volume Profile": "volume_profile_value",
  "HVN Level": "hvn_level",
  "LVN Path": "lvn_path",
  "HVN+FVG Pullback": "hvn_fvg_pullback",
  "Liquidity Sweep": "liquidity_sweep",
  BOS: "bos",
  CHoCH: "choch",
  "Anchored VWAP": "anchored_vwap",
  "Session Level": "session_level",
  "Trend Alignment": "trend_alignment",
  "HTF Alignment": "htf_alignment",
  RSI: "rsi_extreme",
  MACD: "macd_momentum",
};

export const MIN_RESOLVED_FOR_CALIBRATION = 5;

export interface CalibrationRow {
  conditionId: ConditionId;
  label: string;
  defaultWeight: number;
  signals: number;
  resolved: number;
  hitRate: number | null; // targets / (targets + stops), %
  avgR: number | null;
  suggestedWeight: number; // defaultWeight when there is not enough evidence
  calibrated: boolean;
}

export interface CalibrationFilter {
  timeframe?: Timeframe | "all";
  symbol?: string | "all";
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function calibrateWeights(signals: TrackedSignal[], filter: CalibrationFilter = {}): CalibrationRow[] {
  const pool = signals.filter(
    (s) =>
      (!filter.timeframe || filter.timeframe === "all" || s.timeframe === filter.timeframe) &&
      (!filter.symbol || filter.symbol === "all" || s.symbol === filter.symbol),
  );

  return CONDITION_LIBRARY.map((meta) => {
    const factorName = Object.entries(FACTOR_TO_CONDITION).find(([, id]) => id === meta.id)?.[0];
    const withFactor = factorName
      ? pool.filter((s) => s.factors.some((f) => f.name === factorName && f.weight > 0))
      : [];
    const resolved = withFactor.filter((s) => s.outcome !== "pending");
    const targets = resolved.filter((s) => s.outcome === "target").length;
    const stops = resolved.filter((s) => s.outcome === "stop").length;
    const rs = resolved.map((s) => s.rMultiple).filter((r): r is number => r !== null);
    const hitRate = targets + stops > 0 ? (100 * targets) / (targets + stops) : null;
    const avgR = rs.length > 0 ? rs.reduce((a, b) => a + b, 0) / rs.length : null;

    const enough = resolved.length >= MIN_RESOLVED_FOR_CALIBRATION && hitRate !== null;
    let suggestedWeight = meta.defaultWeight;
    if (enough) {
      // 50% hit rate and flat R keep the default; better evidence scales up, worse scales down.
      const multiplier = clamp(0.4 + 0.012 * hitRate + 0.3 * (avgR ?? 0), 0.3, 2);
      suggestedWeight = clamp(Math.round(meta.defaultWeight * multiplier), 1, 30);
    }

    return {
      conditionId: meta.id,
      label: meta.label,
      defaultWeight: meta.defaultWeight,
      signals: withFactor.length,
      resolved: resolved.length,
      hitRate,
      avgR,
      suggestedWeight,
      calibrated: enough,
    };
  });
}

export function calibrationToStrategy(rows: CalibrationRow[], name: string, minScore = 60): CustomStrategy {
  return {
    name,
    minScore,
    conditions: rows.filter((r) => r.suggestedWeight > 0).map((r) => ({ id: r.conditionId, weight: r.suggestedWeight })),
  };
}
