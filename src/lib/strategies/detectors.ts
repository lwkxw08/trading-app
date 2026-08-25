import type { Candle } from "@/lib/market/types";
import type {
  AnchoredVwap,
  FairValueGap,
  HvnFvgPullback,
  LiquiditySweep,
  OrderBlock,
  SessionLevels,
  StructureBreak,
  SwingPoint,
  VolumeNode,
  VolumeProfile,
  VolumeProfileLevel,
} from "./types";

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

  const { hvns, lvns } = detectVolumeNodes(bins);

  return {
    kind: "volume_profile",
    poc: bins[pocIdx].price,
    vah: lo + (highIdx + 1) * binSize,
    val: lo + lowIdx * binSize,
    bins,
    hvns,
    lvns,
    lookback: candles.length,
    startTime: candles[0]?.time ?? 0,
  };
}

/**
 * High/low-volume nodes from the profile histogram: HVNs are local maxima in
 * the 3-bin-smoothed profile with meaningfully above-average volume (they act
 * as support/resistance magnets); LVNs are local minima with well
 * below-average volume (thin shelves price tends to traverse quickly).
 */
function detectVolumeNodes(bins: VolumeProfileLevel[]): { hvns: VolumeNode[]; lvns: VolumeNode[] } {
  const n = bins.length;
  if (n < 5) return { hvns: [], lvns: [] };
  const smoothed = bins.map((_, i) => {
    const from = Math.max(0, i - 1);
    const to = Math.min(n - 1, i + 1);
    let sum = 0;
    for (let j = from; j <= to; j++) sum += bins[j].volume;
    return sum / (to - from + 1);
  });
  const peak = Math.max(...smoothed);
  const mean = smoothed.reduce((a, b) => a + b, 0) / n;
  if (peak <= 0) return { hvns: [], lvns: [] };

  const hvns: VolumeNode[] = [];
  const lvns: VolumeNode[] = [];
  for (let i = 1; i < n - 1; i++) {
    const v = smoothed[i];
    const isMax = v >= smoothed[i - 1] && v >= smoothed[i + 1];
    const isMin = v <= smoothed[i - 1] && v <= smoothed[i + 1];
    if (isMax && v >= mean * 1.3) {
      hvns.push({ kind: "volume_node", type: "hvn", price: bins[i].price, volume: bins[i].volume, strength: v / peak });
    } else if (isMin && v <= mean * 0.5) {
      lvns.push({ kind: "volume_node", type: "lvn", price: bins[i].price, volume: bins[i].volume, strength: v / peak });
    }
  }

  // keep the strongest, non-adjacent nodes
  const dedupe = (nodes: VolumeNode[], byStrongest: boolean, cap: number) => {
    const sorted = [...nodes].sort((a, b) => (byStrongest ? b.strength - a.strength : a.strength - b.strength));
    const kept: VolumeNode[] = [];
    const minGap = ((bins[n - 1].price - bins[0].price) / n) * 3;
    for (const node of sorted) {
      if (kept.every((k) => Math.abs(k.price - node.price) >= minGap)) kept.push(node);
      if (kept.length >= cap) break;
    }
    return kept.sort((a, b) => a.price - b.price);
  };

  return { hvns: dedupe(hvns, true, 5), lvns: dedupe(lvns, false, 4) };
}

/**
 * Impulse HVN + FVG pullback setups:
 * 1. find a sharp impulse leg (swing-to-swing move of >= minLegAtr * ATR),
 * 2. profile the volume across that leg and locate its heavy nodes,
 * 3. keep nodes that coincide with an FVG opened during the leg,
 * 4. entry zone = node band ∩ FVG; a pullback into the zone that bounces away
 *    signals a trade in the impulse direction, targeting the next heavy volume
 *    cluster along the move (or the impulse extreme).
 */
export function detectHvnFvgPullbacks(
  candles: Candle[],
  swings: SwingPoint[],
  fvgs: FairValueGap[],
  atr14: (number | null)[],
  minLegAtr = 3,
  maxAgeBars = 150,
): HvnFvgPullback[] {
  const n = candles.length;
  const atrEnd = atr14[n - 1];
  if (n < 30 || atrEnd === null || atrEnd <= 0) return [];

  const setups: HvnFvgPullback[] = [];
  const ordered = [...swings].sort((a, b) => a.index - b.index);

  for (const direction of ["bullish", "bearish"] as const) {
    const bull = direction === "bullish";
    // most recent swing-to-swing leg in this direction that is sharp enough
    let leg: { start: SwingPoint; end: SwingPoint } | null = null;
    for (let i = ordered.length - 1; i > 0 && !leg; i--) {
      const end = ordered[i];
      if (end.type !== (bull ? "high" : "low") || n - 1 - end.index > maxAgeBars) continue;
      for (let j = i - 1; j >= 0; j--) {
        const start = ordered[j];
        if (start.type !== (bull ? "low" : "high")) continue;
        const move = bull ? end.price - start.price : start.price - end.price;
        if (move >= minLegAtr * atrEnd && end.index - start.index >= 5) leg = { start, end };
        break; // only pair with the nearest opposite swing
      }
    }
    if (!leg) continue;

    const legCandles = candles.slice(leg.start.index, leg.end.index + 1);
    const binCount = Math.min(30, Math.max(10, legCandles.length));
    const profile = computeVolumeProfile(legCandles, binCount);
    const binSize = (Math.max(...legCandles.map((c) => c.high)) - Math.min(...legCandles.map((c) => c.low))) / binCount || 1;

    // FVGs opened during the leg, in the leg direction
    const legFvgs = fvgs.filter((g) => g.direction === direction && g.index >= leg.start.index && g.index <= leg.end.index);

    // strongest HVN inside the leg that coincides with one of those FVGs
    let match: { node: VolumeNode; fvg: FairValueGap } | null = null;
    for (const node of [...profile.hvns].sort((a, b) => b.strength - a.strength)) {
      const fvg = legFvgs.find((g) => node.price + 1.5 * binSize >= g.bottom && node.price - 1.5 * binSize <= g.top);
      if (fvg) {
        match = { node, fvg };
        break;
      }
    }
    if (!match) continue;

    let zoneBottom = Math.max(match.fvg.bottom, match.node.price - 1.5 * binSize);
    let zoneTop = Math.min(match.fvg.top, match.node.price + 1.5 * binSize);
    if (zoneTop <= zoneBottom) {
      zoneBottom = match.node.price - 1.5 * binSize;
      zoneTop = match.node.price + 1.5 * binSize;
    }

    // target: the next heavy volume cluster along the move, else the leg extreme
    const nextHvn = bull
      ? profile.hvns.filter((h) => h.price > zoneTop + binSize).sort((a, b) => a.price - b.price)[0]
      : profile.hvns.filter((h) => h.price < zoneBottom - binSize).sort((a, b) => b.price - a.price)[0];
    const target = nextHvn ? nextHvn.price : leg.end.price;

    // state from price action after the impulse completed
    let touched = false;
    let state: HvnFvgPullback["state"] = "forming";
    for (let i = leg.end.index + 1; i < n; i++) {
      const c = candles[i];
      const closedThrough = bull ? c.close < zoneBottom - 0.25 * atrEnd : c.close > zoneTop + 0.25 * atrEnd;
      if (closedThrough) {
        state = "invalidated";
        break;
      }
      const inZone = bull ? c.low <= zoneTop : c.high >= zoneBottom;
      if (inZone) {
        touched = true;
        state = "in_pullback";
      } else if (touched) {
        const bounced = bull ? c.close > zoneTop : c.close < zoneBottom;
        if (bounced) state = "bounced";
      }
    }

    setups.push({
      kind: "hvn_fvg_pullback",
      direction,
      impulseStartIndex: leg.start.index,
      impulseEndIndex: leg.end.index,
      impulseStartTime: leg.start.time,
      impulseEndTime: leg.end.time,
      impulseStart: leg.start.price,
      impulseEnd: leg.end.price,
      node: match.node,
      fvg: match.fvg,
      zoneTop,
      zoneBottom,
      target,
      state,
    });
  }

  return setups;
}

/**
 * Liquidity sweeps: a candle wicks beyond a prior swing high/low (taking the
 * resting liquidity) but closes back inside — a stop hunt / failed breakout.
 */
export function detectLiquiditySweeps(candles: Candle[], swings: SwingPoint[]): LiquiditySweep[] {
  const sweeps: LiquiditySweep[] = [];
  for (const swing of swings) {
    for (let i = swing.index + 1; i < candles.length; i++) {
      const c = candles[i];
      if (swing.type === "low" && c.low < swing.price && c.close > swing.price) {
        sweeps.push({ kind: "liquidity_sweep", direction: "bullish", sweptLevel: swing.price, extreme: c.low, index: i, time: c.time });
        break;
      }
      if (swing.type === "high" && c.high > swing.price && c.close < swing.price) {
        sweeps.push({ kind: "liquidity_sweep", direction: "bearish", sweptLevel: swing.price, extreme: c.high, index: i, time: c.time });
        break;
      }
      // once price closes through the level, the liquidity is gone — no sweep
      if (swing.type === "low" && c.close < swing.price) break;
      if (swing.type === "high" && c.close > swing.price) break;
    }
  }
  return sweeps.sort((a, b) => a.index - b.index);
}

/**
 * Break of Structure (BOS) and Change of Character (CHoCH) from the swing
 * sequence: a close beyond the latest swing high/low is a BOS when it continues
 * the prevailing structure and a CHoCH when it is the first break against it.
 */
export function detectStructureBreaks(candles: Candle[], swings: SwingPoint[]): StructureBreak[] {
  const breaks: StructureBreak[] = [];
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  let bias: "bullish" | "bearish" | null = null;

  const events: { index: number; swing: SwingPoint }[] = swings.map((s) => ({ index: s.index, swing: s }));
  events.sort((a, b) => a.index - b.index);

  let ev = 0;
  for (let i = 0; i < candles.length; i++) {
    while (ev < events.length && events[ev].index <= i - 1) {
      const s = events[ev].swing;
      if (s.type === "high") lastHigh = s;
      else lastLow = s;
      ev++;
    }
    const c = candles[i];
    if (lastHigh && c.close > lastHigh.price && i > lastHigh.index) {
      const type = bias === "bearish" ? "choch" : "bos";
      breaks.push({ kind: "structure_break", type, direction: "bullish", brokenLevel: lastHigh.price, index: i, time: c.time });
      bias = "bullish";
      lastHigh = null;
    } else if (lastLow && c.close < lastLow.price && i > lastLow.index) {
      const type = bias === "bullish" ? "choch" : "bos";
      breaks.push({ kind: "structure_break", type, direction: "bearish", brokenLevel: lastLow.price, index: i, time: c.time });
      bias = "bearish";
      lastLow = null;
    }
  }
  return breaks;
}

/**
 * Anchored VWAP from the most recent significant swing (the last swing low for
 * a rising market, last swing high for a falling one), falling back to the
 * start of the window.
 */
export function computeAnchoredVwap(candles: Candle[], swings: SwingPoint[]): AnchoredVwap | null {
  if (candles.length === 0) return null;
  const lastPrice = candles[candles.length - 1].close;
  const recent = swings.slice(-8);
  const lows = recent.filter((s) => s.type === "low");
  const highs = recent.filter((s) => s.type === "high");
  let anchorIndex = 0;
  let anchorType: AnchoredVwap["anchorType"] = "range_start";
  const lastLow = lows[lows.length - 1];
  const lastHigh = highs[highs.length - 1];
  if (lastLow && lastPrice > lastLow.price && (!lastHigh || lastLow.index >= lastHigh.index)) {
    anchorIndex = lastLow.index;
    anchorType = "swing_low";
  } else if (lastHigh) {
    anchorIndex = lastHigh.index;
    anchorType = "swing_high";
  }

  const series: (number | null)[] = new Array(candles.length).fill(null);
  let cumPV = 0;
  let cumV = 0;
  for (let i = anchorIndex; i < candles.length; i++) {
    const c = candles[i];
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
    series[i] = cumV > 0 ? cumPV / cumV : typical;
  }
  const value = series[candles.length - 1];
  if (value === null) return null;
  return { kind: "anchored_vwap", anchorType, anchorTime: candles[anchorIndex].time, value, series };
}

const SESSION_WINDOWS: { name: "asia" | "london" | "newyork"; startHour: number; endHour: number }[] = [
  { name: "asia", startHour: 0, endHour: 8 },
  { name: "london", startHour: 7, endHour: 16 },
  { name: "newyork", startHour: 13, endHour: 21 },
];

/**
 * Session highs/lows (UTC windows) for the most recent completed or in-progress
 * occurrence of each session. Prior-session extremes act as intraday
 * support/resistance and liquidity pools.
 */
export function computeSessionLevels(candles: Candle[]): SessionLevels {
  const sessions: SessionLevels["sessions"] = [];
  for (const w of SESSION_WINDOWS) {
    let best: { high: number; low: number; startTime: number; endTime: number } | null = null;
    let current: { high: number; low: number; startTime: number; endTime: number } | null = null;
    for (const c of candles) {
      const hour = new Date(c.time * 1000).getUTCHours();
      const inSession = hour >= w.startHour && hour < w.endHour;
      if (inSession) {
        if (current === null || c.time - current.endTime > 3600 * 4) {
          if (current) best = current;
          current = { high: c.high, low: c.low, startTime: c.time, endTime: c.time };
        } else {
          current.high = Math.max(current.high, c.high);
          current.low = Math.min(current.low, c.low);
          current.endTime = c.time;
        }
      }
    }
    const latest = current ?? best;
    if (latest) sessions.push({ name: w.name, ...latest });
  }
  return { kind: "session_levels", sessions };
}
