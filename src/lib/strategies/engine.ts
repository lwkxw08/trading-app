import { atr, ema, last, macd, rsi } from "@/lib/indicators/core";
import type { Candle, Timeframe } from "@/lib/market/types";
import {
  computeAnchoredVwap,
  computeSessionLevels,
  computeVolumeProfile,
  detectFairValueGaps,
  detectHvnFvgPullbacks,
  detectLiquiditySweeps,
  detectOrderBlocks,
  detectStructureBreaks,
  detectSwings,
} from "./detectors";
import type { StrategyAnalysis, TrendState } from "./types";

export function computeTrend(candles: Candle[], timeframe: Timeframe): TrendState {
  const closes = candles.map((c) => c.close);
  const ema20 = last(ema(closes, 20));
  const ema50 = last(ema(closes, 50));
  const ema200 = last(ema(closes, 200));
  const rsi14 = last(rsi(closes, 14));
  const macdHistogram = last(macd(closes).histogram);
  const atr14 = last(atr(candles, 14));
  const price = closes[closes.length - 1];

  let direction: TrendState["direction"] = "sideways";
  if (ema20 !== null && ema50 !== null) {
    if (price > ema20 && ema20 > ema50) direction = "up";
    else if (price < ema20 && ema20 < ema50) direction = "down";
  }

  return { timeframe, direction, ema20, ema50, ema200, rsi14, macdHistogram, atr14 };
}

export function analyze(symbol: string, timeframe: Timeframe, candles: Candle[], higherTfCandles?: Candle[], higherTf?: Timeframe, opts?: { vpBars?: number }): StrategyAnalysis {
  const atr14 = atr(candles, 14);
  const vpBars = opts?.vpBars ?? 200;
  const profileWindow = candles.slice(-Math.min(candles.length, vpBars));
  const swings = detectSwings(candles);
  const fvgs = detectFairValueGaps(candles, 0.15, atr14);
  return {
    symbol,
    timeframe,
    lastPrice: candles[candles.length - 1].close,
    candles,
    fvgs,
    orderBlocks: detectOrderBlocks(candles, atr14),
    swings,
    volumeProfile: computeVolumeProfile(profileWindow),
    hvnFvgPullbacks: detectHvnFvgPullbacks(candles, swings, fvgs, atr14),
    liquiditySweeps: detectLiquiditySweeps(candles, swings),
    structureBreaks: detectStructureBreaks(candles, swings),
    anchoredVwap: computeAnchoredVwap(candles, swings),
    sessionLevels: computeSessionLevels(candles.slice(-Math.min(candles.length, 300))),
    trend: computeTrend(candles, timeframe),
    higherTimeframeTrend: higherTfCandles && higherTf ? computeTrend(higherTfCandles, higherTf) : undefined,
  };
}

/** The next timeframe up, used for multi-timeframe confluence. */
export function higherTimeframe(tf: Timeframe): Timeframe {
  const ladder: Record<Timeframe, Timeframe> = {
    "1m": "15m", "5m": "30m", "15m": "1h", "30m": "2h",
    "1h": "4h", "2h": "1d", "4h": "1d", "1d": "1w", "1w": "1w",
  };
  return ladder[tf];
}
