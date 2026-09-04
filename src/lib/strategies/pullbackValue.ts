import { atr, ema } from "@/lib/indicators/core";
import type { Candle, Timeframe } from "@/lib/market/types";
import {
  computeVolumeProfile,
  detectFairValueGaps,
  detectLiquiditySweeps,
  detectOrderBlocks,
  detectSwings,
} from "./detectors";
import type { Direction, Opportunity } from "./types";

export const PULLBACK_VALUE_STRATEGY_NAME = "Pullback to Value";

/**
 * HTF-trend pullback-to-value setup (cross-asset, single candle series):
 * 1. Bias: longer-term trend via EMA50 vs EMA200 — only trade with it,
 * 2. Location: a value zone where a heavy volume node (HVN) overlaps a fresh
 *    FVG or unmitigated order block in the trend direction, below price
 *    (longs) / above price (shorts),
 * 3. Trigger: a liquidity sweep into the zone that reclaims the swept level
 *    (stops run, then reversal),
 * 4. Exit: SL beyond the zone/sweep extreme with an ATR buffer, TP at the
 *    next HVN in the trade direction (1.25R fallback) — the "easy" portion
 *    of the move.
 */

export type PullbackValueState =
  | "awaiting_trend" // no clear longer-term trend yet
  | "awaiting_zone" // trend set, waiting for price to pull back into a value zone
  | "awaiting_sweep" // price reached the zone, waiting for the liquidity sweep + reclaim
  | "armed" // sweep reclaimed — entry/SL/TP known, entry not tagged yet
  | "triggered" // entry level tagged after the reclaim
  | "completed" // the trade played out after entry (TP or SL reached)
  | "invalidated";

export interface PullbackValueSetup {
  kind: "pullback_value";
  direction: Direction | null;
  /** value zone: overlap of the HVN band and the FVG/order-block range */
  zoneTop: number | null;
  zoneBottom: number | null;
  /** what formed the zone alongside the HVN */
  zoneSource: "fvg" | "order_block" | null;
  /** HVN price inside the zone */
  hvnPrice: number | null;
  /** the reclaimed sweep that triggers the setup */
  sweptLevel: number | null;
  sweepTime: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  state: PullbackValueState;
  stateDetail: string;
}

const ZONE_MAX_DISTANCE_ATR = 5;
const ZONE_OVERSHOOT_ATR = 3;
const PULLBACK_OVERSHOOT_ATR = 1;
const HVN_BAND_ATR = 0.5;
const STOP_BUFFER_ATR = 0.25;
const FALLBACK_RR = 1.25;

function base(state: PullbackValueState, stateDetail: string, partial?: Partial<PullbackValueSetup>): PullbackValueSetup {
  return {
    kind: "pullback_value",
    direction: null,
    zoneTop: null,
    zoneBottom: null,
    zoneSource: null,
    hvnPrice: null,
    sweptLevel: null,
    sweepTime: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    state,
    stateDetail,
    ...partial,
  };
}

export function detectPullbackValueSetup(candles: Candle[]): PullbackValueSetup | null {
  if (candles.length < 220) return null;

  const closes = candles.map((c) => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const atr14 = atr(candles, 14);
  const lastIdx = candles.length - 1;
  const price = closes[lastIdx];
  const atrNow = atr14[lastIdx] ?? price * 0.01;
  const e50 = ema50[lastIdx];
  const e200 = ema200[lastIdx];
  if (e50 === null || e200 === null) return null;

  // 1. longer-term bias
  const bull = e50 > e200 && price > e200;
  const bear = e50 < e200 && price < e200;
  if (!bull && !bear) {
    return base("awaiting_trend", "No clear longer-term trend (EMA50 vs EMA200) — standing aside");
  }
  const direction: Direction = bull ? "bullish" : "bearish";

  // 2. value zone: HVN band overlapping a fresh FVG or unmitigated order block
  //    in the trend direction, on the pullback side of price
  const profile = computeVolumeProfile(candles.slice(-Math.min(candles.length, 200)));
  const fvgs = detectFairValueGaps(candles, 0.15, atr14);
  const orderBlocks = detectOrderBlocks(candles, atr14);

  interface Zone {
    top: number;
    bottom: number;
    source: "fvg" | "order_block";
    hvnPrice: number;
    formedIndex: number;
  }
  const zones: Zone[] = [];
  for (const hvn of profile.hvns) {
    const bandTop = hvn.price + HVN_BAND_ATR * atrNow;
    const bandBottom = hvn.price - HVN_BAND_ATR * atrNow;
    for (const g of fvgs) {
      if (g.filled || g.direction !== direction) continue;
      const top = Math.min(bandTop, g.top);
      const bottom = Math.max(bandBottom, g.bottom);
      if (top > bottom) zones.push({ top, bottom, source: "fvg", hvnPrice: hvn.price, formedIndex: g.index });
    }
    for (const ob of orderBlocks) {
      if (ob.mitigated || ob.direction !== direction) continue;
      const top = Math.min(bandTop, ob.top);
      const bottom = Math.max(bandBottom, ob.bottom);
      if (top > bottom) zones.push({ top, bottom, source: "order_block", hvnPrice: hvn.price, formedIndex: ob.index });
    }
  }
  // nearest zone on the pullback side: within reach above/below price, and
  // still valid while price is inside it or briefly wicking beyond it
  const candidates = zones
    .filter((z) => (bull ? price - z.top : z.bottom - price) <= ZONE_MAX_DISTANCE_ATR * atrNow)
    .filter((z) => (bull ? z.bottom - price : price - z.top) <= ZONE_OVERSHOOT_ATR * atrNow)
    .sort((a, b) => (bull ? b.top - a.top : a.bottom - b.bottom));
  const zone = candidates[0];
  if (!zone) {
    return base("awaiting_zone", `Trend is ${bull ? "up" : "down"} — waiting for a fresh FVG/order block overlapping a heavy volume node ${bull ? "below" : "above"} price`, { direction });
  }

  const zoneInfo: Partial<PullbackValueSetup> = {
    direction,
    zoneTop: zone.top,
    zoneBottom: zone.bottom,
    zoneSource: zone.source,
    hvnPrice: zone.hvnPrice,
  };

  // has price pulled back into the zone since it formed?
  let touchIndex = -1;
  for (let i = zone.formedIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    if (bull ? c.low <= zone.top : c.high >= zone.bottom) {
      touchIndex = i;
      break;
    }
  }
  if (touchIndex < 0) {
    return base("awaiting_zone", `Value zone ${zone.bottom.toFixed(2)}–${zone.top.toFixed(2)} (${zone.source === "fvg" ? "FVG" : "order block"} + HVN) — waiting for the pullback into it`, zoneInfo);
  }

  // 3. liquidity sweep into the zone with a reclaim, after the pullback began
  const swings = detectSwings(candles);
  const sweeps = detectLiquiditySweeps(candles, swings);
  const sweep = [...sweeps]
    .reverse()
    .find((s) => s.direction === direction && s.index >= touchIndex && (bull ? s.extreme <= zone.top : s.extreme >= zone.bottom));
  if (!sweep) {
    // without a sweep/reclaim, a deep close beyond the zone is a failed
    // pullback, not a setup in waiting
    if (bull ? price < zone.bottom - PULLBACK_OVERSHOOT_ATR * atrNow : price > zone.top + PULLBACK_OVERSHOOT_ATR * atrNow) {
      return base("awaiting_zone", `Pullback overshot the value zone — waiting for a fresh FVG/order block overlapping a heavy volume node ${bull ? "below" : "above"} price`, { direction });
    }
    return base("awaiting_sweep", "Price reached the value zone — waiting for a liquidity sweep and reclaim to confirm the reversal", zoneInfo);
  }

  // levels: entry at the trend-side edge of the zone, SL beyond zone/sweep
  // extreme, TP at the next HVN in the trade direction (fallback 1.25R)
  const entry = bull ? zone.top : zone.bottom;
  const stopAnchor = bull ? Math.min(sweep.extreme, zone.bottom) : Math.max(sweep.extreme, zone.top);
  const stopLoss = bull ? stopAnchor - STOP_BUFFER_ATR * atrNow : stopAnchor + STOP_BUFFER_ATR * atrNow;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) {
    return base("invalidated", "Degenerate risk distance", zoneInfo);
  }
  const nextHvn = bull
    ? profile.hvns.filter((n) => n.price >= entry + 0.5 * atrNow).map((n) => n.price).sort((x, y) => x - y)[0]
    : profile.hvns.filter((n) => n.price <= entry - 0.5 * atrNow).map((n) => n.price).sort((x, y) => y - x)[0];
  const fallbackTp = bull ? entry + FALLBACK_RR * risk : entry - FALLBACK_RR * risk;
  const takeProfit = nextHvn !== undefined ? nextHvn : fallbackTp;

  const levels: Partial<PullbackValueSetup> = {
    ...zoneInfo,
    sweptLevel: sweep.sweptLevel,
    sweepTime: sweep.time,
    entry,
    stopLoss,
    takeProfit,
  };

  // 4. walk price action after the sweep: entry tag triggers, stop-side close
  //    invalidates, TP/SL hit after entry completes the setup
  let state: PullbackValueState = "armed";
  let stateDetail = "Sweep reclaimed — setup armed, entry at the zone edge";
  for (let i = sweep.index + 1; i < candles.length; i++) {
    const c = candles[i];
    if (state === "armed") {
      if (bull ? c.close < stopLoss : c.close > stopLoss) {
        state = "invalidated";
        stateDetail = "Price closed beyond the stop level before entry";
        break;
      }
      if (c.low <= entry && c.high >= entry) {
        state = "triggered";
        stateDetail = "Entry level tagged after the sweep reclaim";
      }
    } else if (state === "triggered") {
      if (bull ? c.high >= takeProfit : c.low <= takeProfit) {
        state = "completed";
        stateDetail = "Setup played out — take profit was reached";
        break;
      }
      if (bull ? c.low <= stopLoss : c.high >= stopLoss) {
        state = "completed";
        stateDetail = "Setup played out — stop level was reached after entry";
        break;
      }
    }
  }

  return { ...base(state, stateDetail, levels) };
}

/** A forming pullback-to-value setup — not actionable yet, worth watching. */
export interface PullbackValueWatch {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction | null;
  state: PullbackValueState;
  stateDetail: string;
  zoneTop: number | null;
  zoneBottom: number | null;
  generatedAt: number;
}

export function pullbackValueWatchItem(symbol: string, timeframe: Timeframe, setup: PullbackValueSetup): PullbackValueWatch | null {
  if (setup.state !== "awaiting_zone" && setup.state !== "awaiting_sweep") return null;
  return {
    symbol,
    timeframe,
    direction: setup.direction,
    state: setup.state,
    stateDetail: setup.stateDetail,
    zoneTop: setup.zoneTop,
    zoneBottom: setup.zoneBottom,
    generatedAt: Date.now(),
  };
}

/** Scanner shape for an actionable pullback-to-value setup. */
export function pullbackValueOpportunity(symbol: string, timeframe: Timeframe, setup: PullbackValueSetup): Opportunity | null {
  if (setup.direction === null || setup.entry === null || setup.stopLoss === null || setup.takeProfit === null) return null;
  if (setup.state !== "armed" && setup.state !== "triggered") return null;
  const risk = Math.abs(setup.entry - setup.stopLoss);
  return {
    symbol,
    timeframe,
    direction: setup.direction === "bullish" ? "long" : "short",
    score: setup.state === "triggered" ? 85 : 75,
    factors: [
      { name: "HTF trend", detail: `Longer-term trend is ${setup.direction === "bullish" ? "up" : "down"} (EMA50 vs EMA200)`, weight: 25 },
      {
        name: "Value zone",
        detail: `${setup.zoneSource === "fvg" ? "FVG" : "Order block"} + HVN zone ${setup.zoneBottom?.toFixed(2)}–${setup.zoneTop?.toFixed(2)}`,
        weight: 25,
      },
      { name: "Liquidity sweep", detail: `Swept ${setup.sweptLevel?.toFixed(2)} into the zone and reclaimed`, weight: 25 },
      { name: "Entry", detail: setup.stateDetail, weight: setup.state === "triggered" ? 10 : 0 },
    ],
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskRewardRatio: risk > 0 ? Math.abs(setup.takeProfit - setup.entry) / risk : 0,
    generatedAt: Date.now(),
  };
}
