import type { Candle } from "@/lib/market/types";

export type RegimeLabel = "trending_up" | "trending_down" | "ranging" | "volatile";

export interface RegimeState {
  kind: "regime";
  regime: RegimeLabel;
  /** Wilder ADX(14): trend strength regardless of direction */
  adx14: number | null;
  /** where the current ATR sits within its recent distribution, 0..1 */
  atrPercentile: number | null;
  detail: string;
}

const ADX_PERIOD = 14;
const ADX_TREND_THRESHOLD = 23;
const ATR_LOOKBACK = 200;
const VOLATILE_PERCENTILE = 0.9;

/** Wilder's DMI/ADX. Returns the latest ADX plus the latest +DI/-DI. */
function computeAdx(candles: Candle[], period = ADX_PERIOD): { adx: number | null; plusDi: number | null; minusDi: number | null } {
  if (candles.length < period * 2 + 1) return { adx: null, plusDi: null, minusDi: null };
  let trSum = 0;
  let plusSum = 0;
  let minusSum = 0;
  let adx: number | null = null;
  let plusDi: number | null = null;
  let minusDi: number | null = null;
  let dxCount = 0;
  let dxAccum = 0;

  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    const plusDm = up > down && up > 0 ? up : 0;
    const minusDm = down > up && down > 0 ? down : 0;
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );

    if (i <= period) {
      trSum += tr;
      plusSum += plusDm;
      minusSum += minusDm;
      if (i < period) continue;
    } else {
      trSum = trSum - trSum / period + tr;
      plusSum = plusSum - plusSum / period + plusDm;
      minusSum = minusSum - minusSum / period + minusDm;
    }

    plusDi = trSum > 0 ? (100 * plusSum) / trSum : 0;
    minusDi = trSum > 0 ? (100 * minusSum) / trSum : 0;
    const diSum = plusDi + minusDi;
    const dx = diSum > 0 ? (100 * Math.abs(plusDi - minusDi)) / diSum : 0;

    if (adx === null) {
      dxAccum += dx;
      dxCount++;
      if (dxCount === period) adx = dxAccum / period;
    } else {
      adx = (adx * (period - 1) + dx) / period;
    }
  }
  return { adx, plusDi, minusDi };
}

/** Percentile rank of the latest value within the series' recent window. */
function percentileRank(series: (number | null)[], lookback: number): number | null {
  const values = series.filter((v): v is number => v !== null).slice(-lookback);
  if (values.length < 30) return null;
  const latest = values[values.length - 1];
  const below = values.filter((v) => v <= latest).length;
  return below / values.length;
}

/**
 * Classifies the market condition from price action alone: trending (ADX
 * strong, direction from DI dominance), volatile (ATR in the top decile of
 * its recent range) or ranging. A probabilistic read, not a prediction.
 */
export function classifyRegime(candles: Candle[], atrSeries: (number | null)[]): RegimeState {
  const { adx, plusDi, minusDi } = computeAdx(candles);
  const atrPct = percentileRank(atrSeries, ATR_LOOKBACK);

  let regime: RegimeLabel;
  let detail: string;
  if (atrPct !== null && atrPct >= VOLATILE_PERCENTILE) {
    regime = "volatile";
    detail = `ATR in the top ${Math.round((1 - atrPct) * 100) || 10}% of its recent range — expansion/volatility regime, wider stops and faster moves`;
  } else if (adx !== null && adx >= ADX_TREND_THRESHOLD && plusDi !== null && minusDi !== null) {
    regime = plusDi >= minusDi ? "trending_up" : "trending_down";
    detail = `ADX ${adx.toFixed(0)} with ${plusDi >= minusDi ? "+DI" : "-DI"} dominant — directional trend regime, continuation setups favoured`;
  } else {
    regime = "ranging";
    detail = `ADX ${adx !== null ? adx.toFixed(0) : "n/a"} below ${ADX_TREND_THRESHOLD} — rotational/ranging regime, mean-reversion at range edges favoured over breakouts`;
  }

  return { kind: "regime", regime, adx14: adx, atrPercentile: atrPct, detail };
}

export const REGIME_LABELS: Record<RegimeLabel, string> = {
  trending_up: "Trending up",
  trending_down: "Trending down",
  ranging: "Ranging",
  volatile: "Volatile",
};
