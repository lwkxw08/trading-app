import type { Candle } from "@/lib/market/types";
import type { FairValueGap, OrderBlock, SwingPoint, VolumeProfile, VolumeProfileLevel } from "./types";

/**
 * Fair Value Gaps: a 3-candle imbalance where candle 1's high < candle 3's low
 * (bullish) or candle 1's low > candle 3's high (bearish). The gap zone is the
 * unfilled space; later price action can partially or fully fill it.
 */
export function detectFairValueGaps(candles: Candle[], minGapAtrRatio = 0.15, atr14: (number | null)[] = []): FairValueGap[] {
  const gaps: FairValueGap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const c = candles[i];
    const atrVal = atr14[i] ?? null;
    // bullish gap
    if (c.low > a.high) {
      const size = c.low - a.high;
      if (atrVal === null || size >= atrVal * minGapAtrRatio) {
        gaps.push(finalizeGap(candles, i, { kind: "fvg", direction: "bullish", top: c.low, bottom: a.high, index: i - 1, time: candles[i - 1].time, filled: false, fillRatio: 0 }));
      }
    }
    // bearish gap
    if (c.high < a.low) {
      const size = a.low - c.high;
      if (atrVal === null || size >= atrVal * minGapAtrRatio) {
        gaps.push(finalizeGap(candles, i, { kind: "fvg", direction: "bearish", top: a.low, bottom: c.high, index: i - 1, time: candles[i - 1].time, filled: false, fillRatio: 0 }));
      }
    }
  }
  return gaps;
}

function finalizeGap(candles: Candle[], createdAt: number, gap: FairValueGap): FairValueGap {
  const size = gap.top - gap.bottom;
  let deepest = 0;
  for (let j = createdAt + 1; j < candles.length; j++) {
    const c = candles[j];
    if (gap.direction === "bullish" && c.low < gap.top) {
      deepest = Math.max(deepest, Math.min(gap.top - c.low, size));
    } else if (gap.direction === "bearish" && c.high > gap.bottom) {
      deepest = Math.max(deepest, Math.min(c.high - gap.bottom, size));
    }
  }
  const fillRatio = size > 0 ? deepest / size : 1;
  return { ...gap, fillRatio, filled: fillRatio >= 0.999 };
}

/**
 * Swing highs/lows using a symmetric lookback window.
 */
export function detectSwings(candles: Candle[], lookback = 5): SwingPoint[] {
  const swings: SwingPoint[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ kind: "swing", type: "high", price: c.high, index: i, time: c.time });
    if (isLow) swings.push({ kind: "swing", type: "low", price: c.low, index: i, time: c.time });
  }
  return swings;
}

/**
 * Order blocks: the last opposing candle before a strong displacement move
 * (move of >= displacementAtr * ATR within the next `span` candles).
 */
export function detectOrderBlocks(candles: Candle[], atr14: (number | null)[], displacementAtr = 2, span = 3): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  for (let i = 1; i < candles.length - span; i++) {
    const c = candles[i];
    const atrVal = atr14[i];
    if (atrVal === null) continue;
    const isBearishCandle = c.close < c.open;
    const isBullishCandle = c.close > c.open;
    const windowEnd = Math.min(i + span, candles.length - 1);
    const maxClose = Math.max(...candles.slice(i + 1, windowEnd + 1).map((x) => x.close));
    const minClose = Math.min(...candles.slice(i + 1, windowEnd + 1).map((x) => x.close));
    // bullish OB: bearish candle followed by strong up displacement
    if (isBearishCandle && maxClose - c.close >= displacementAtr * atrVal) {
      blocks.push(withMitigation(candles, i, { kind: "order_block", direction: "bullish", top: c.high, bottom: c.low, index: i, time: c.time, mitigated: false }));
    }
    // bearish OB: bullish candle followed by strong down displacement
    if (isBullishCandle && c.close - minClose >= displacementAtr * atrVal) {
      blocks.push(withMitigation(candles, i, { kind: "order_block", direction: "bearish", top: c.high, bottom: c.low, index: i, time: c.time, mitigated: false }));
    }
  }
  return blocks;
}

function withMitigation(candles: Candle[], createdAt: number, block: OrderBlock): OrderBlock {
  for (let j = createdAt + 3; j < candles.length; j++) {
    const c = candles[j];
    if (block.direction === "bullish" && c.low <= block.top) return { ...block, mitigated: true };
    if (block.direction === "bearish" && c.high >= block.bottom) return { ...block, mitigated: true };
  }
  return block;
}

/**
 * Volume profile over the given candles: distributes each candle's volume
 * across the price bins its range covers, then finds POC and the 70% value area.
 */
export function computeVolumeProfile(candles: Candle[], binCount = 50): VolumeProfile {
  const lo = Math.min(...candles.map((c) => c.low));
  const hi = Math.max(...candles.map((c) => c.high));
  const range = hi - lo || 1;
  const binSize = range / binCount;
  const volumes = new Array(binCount).fill(0) as number[];

  for (const c of candles) {
    const startBin = Math.max(0, Math.floor((c.low - lo) / binSize));
    const endBin = Math.min(binCount - 1, Math.floor((c.high - lo) / binSize));
    const spread = endBin - startBin + 1;
    for (let b = startBin; b <= endBin; b++) volumes[b] += c.volume / spread;
  }

  const bins: VolumeProfileLevel[] = volumes.map((v, i) => ({ price: lo + (i + 0.5) * binSize, volume: v }));
  const pocIdx = volumes.indexOf(Math.max(...volumes));
  const totalVolume = volumes.reduce((a, b) => a + b, 0);

  // expand around POC until 70% of volume is captured
  let covered = volumes[pocIdx];
  let lowIdx = pocIdx;
  let highIdx = pocIdx;
  while (covered < totalVolume * 0.7 && (lowIdx > 0 || highIdx < binCount - 1)) {
    const below = lowIdx > 0 ? volumes[lowIdx - 1] : -1;
    const above = highIdx < binCount - 1 ? volumes[highIdx + 1] : -1;
    if (above >= below) {
      highIdx++;
      covered += volumes[highIdx];
    } else {
      lowIdx--;
      covered += volumes[lowIdx];
    }
  }

  return {
    kind: "volume_profile",
    poc: bins[pocIdx].price,
    vah: lo + (highIdx + 1) * binSize,
    val: lo + lowIdx * binSize,
    bins,
  };
}
