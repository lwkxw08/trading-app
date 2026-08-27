import { atr } from "@/lib/indicators/core";
import type { Candle } from "@/lib/market/types";
import { detectFairValueGaps, detectStructureBreaks, detectSwings } from "./detectors";
import type { Direction, FairValueGap, Opportunity, SwingPoint } from "./types";

export const TREND_BREAK_STRATEGY_NAME = "15m Trend Break → 1m FVG";

/**
 * 15m trend-break → 1m CHoCH + FVG midpoint setup:
 * 1. 15m context: an established trend with at least 2 BoS in sequence,
 * 2. a trendline through the ascending swing lows (bull) / descending swing
 *    highs (bear) of that trend,
 * 3. price closes through the trendline and a 15m CHoCH confirms the shift,
 * 4. 1m execution: the first 1m CHoCH after the trendline break,
 * 5. then the first 1m FVG in the CHoCH direction,
 * 6. entry at the FVG midpoint when price pulls back into it,
 * 7. SL beyond the recent 1m swing, TP at 3× risk.
 */

export type TrendBreakState =
  | "awaiting_choch" // 15m confirmed, waiting for the first 1m CHoCH
  | "awaiting_fvg" // 1m CHoCH found, waiting for an FVG in its direction
  | "awaiting_pullback" // FVG formed, waiting for price to return to its midpoint
  | "triggered" // price tagged the midpoint
  | "completed" // the trade played out after entry (TP or SL reached)
  | "invalidated";

export interface TrendBreakSetup {
  kind: "trend_break";
  /** trade direction after the break (bearish = prior bull trend broke down) */
  direction: Direction;
  /** the prior 15m trend that broke */
  priorTrend: Direction;
  /** number of same-direction BoS in the prior trend run */
  bosCount: number;
  /** 15m trendline through the higher lows (bull) / lower highs (bear) */
  trendline: { fromTime: number; fromPrice: number; toTime: number; toPrice: number };
  /** 15m candle that closed through the trendline */
  breakTime: number;
  /** trendline value at the break candle */
  breakPrice: number;
  /** 15m CHoCH confirming the shift */
  htfChochTime: number;
  htfChochLevel: number;
  /** first 1m CHoCH after the trendline break */
  ltfChochTime: number | null;
  ltfChochLevel: number | null;
  /** first 1m FVG in the CHoCH direction after the 1m CHoCH */
  fvg: FairValueGap | null;
  /** FVG midpoint */
  entry: number | null;
  /** beyond the recent 1m swing low (long) / high (short) */
  stopLoss: number | null;
  /** 3× risk from entry */
  takeProfit: number | null;
  state: TrendBreakState;
  stateDetail: string;
}

const RISK_MULTIPLE = 3;

/** Last run of ascending swing lows (bull) / descending swing highs (bear) ending before `beforeIndex`. */
function trendlineAnchors(swings: SwingPoint[], bull: boolean, beforeIndex: number): SwingPoint[] {
  const points = swings
    .filter((s) => s.type === (bull ? "low" : "high") && s.index < beforeIndex)
    .sort((a, b) => a.index - b.index);
  // latest run of >= 2 ascending lows (bull) / descending highs (bear)
  for (let end = points.length - 1; end >= 0; end--) {
    const run: SwingPoint[] = [points[end]];
    for (let i = end - 1; i >= 0; i--) {
      const next = run[0];
      if (bull ? points[i].price < next.price : points[i].price > next.price) run.unshift(points[i]);
      else break;
    }
    if (run.length >= 2) return run;
  }
  return [];
}

function lineValueAt(line: { fromTime: number; fromPrice: number; toTime: number; toPrice: number }, time: number): number {
  const span = line.toTime - line.fromTime;
  if (span === 0) return line.toPrice;
  const slope = (line.toPrice - line.fromPrice) / span;
  return line.fromPrice + slope * (time - line.fromTime);
}

export function detectTrendBreakSetup(htfCandles: Candle[], ltfCandles: Candle[]): TrendBreakSetup | null {
  if (htfCandles.length < 60 || ltfCandles.length < 60) return null;

  const htfSwings = detectSwings(htfCandles);
  const htfBreaks = detectStructureBreaks(htfCandles, htfSwings);

  // most recent 15m CHoCH — the structural shift that ends the prior trend
  const choch = [...htfBreaks].reverse().find((b) => b.type === "choch");
  if (!choch) return null;
  const direction = choch.direction;
  const bull = direction === "bearish"; // prior trend was bullish when the shift is bearish
  const priorTrend: Direction = bull ? "bullish" : "bearish";

  // require >= 2 BoS in the prior trend direction immediately before the CHoCH
  let bosCount = 0;
  for (let i = htfBreaks.indexOf(choch) - 1; i >= 0; i--) {
    const b = htfBreaks[i];
    if (b.type === "bos" && b.direction === priorTrend) bosCount++;
    else break;
  }
  if (bosCount < 2) return null;

  // trendline through the higher lows (bull trend) / lower highs (bear trend)
  const anchors = trendlineAnchors(htfSwings, bull, choch.index);
  if (anchors.length < 2) return null;
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  const trendline = { fromTime: first.time, fromPrice: first.price, toTime: last.time, toPrice: last.price };

  // first 15m close through the trendline after its last anchor
  let breakIndex = -1;
  for (let i = last.index + 1; i < htfCandles.length; i++) {
    const lineVal = lineValueAt(trendline, htfCandles[i].time);
    if (bull ? htfCandles[i].close < lineVal : htfCandles[i].close > lineVal) {
      breakIndex = i;
      break;
    }
  }
  if (breakIndex < 0) return null;
  const breakTime = htfCandles[breakIndex].time;
  const breakPrice = lineValueAt(trendline, breakTime);

  const base: Omit<TrendBreakSetup, "state" | "stateDetail"> = {
    kind: "trend_break",
    direction,
    priorTrend,
    bosCount,
    trendline,
    breakTime,
    breakPrice,
    htfChochTime: choch.time,
    htfChochLevel: choch.brokenLevel,
    ltfChochTime: null,
    ltfChochLevel: null,
    fvg: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
  };

  // a later opposite 15m CHoCH would mean the shift itself failed
  const laterOpposite = htfBreaks.some((b) => b.type === "choch" && b.index > choch.index);
  if (laterOpposite) {
    return { ...base, state: "invalidated", stateDetail: "A later 15m CHoCH reversed the shift" };
  }

  // 1m data must cover the break — otherwise the first CHoCH can't be identified
  if (ltfCandles[5].time > breakTime) {
    return { ...base, state: "invalidated", stateDetail: "1m history does not reach back to the 15m break" };
  }

  // 1m execution leg
  const ltfSwings = detectSwings(ltfCandles);
  const ltfBreaks = detectStructureBreaks(ltfCandles, ltfSwings);
  const ltfAtr = atr(ltfCandles, 14);
  const atrNow = ltfAtr[ltfCandles.length - 1] ?? 0;

  // the FIRST 1m CHoCH in the setup direction after the trendline break
  const ltfChoch = ltfBreaks.find((b) => b.type === "choch" && b.direction === direction && b.time > breakTime);
  if (!ltfChoch) {
    return { ...base, state: "awaiting_choch", stateDetail: "Waiting for the first 1m CHoCH after the trend break" };
  }
  base.ltfChochTime = ltfChoch.time;
  base.ltfChochLevel = ltfChoch.brokenLevel;

  // the first 1m FVG in the CHoCH direction after the CHoCH
  const fvgs = detectFairValueGaps(ltfCandles, 0.15, ltfAtr);
  const fvg = fvgs.find((g) => g.direction === direction && g.index > ltfChoch.index);
  if (!fvg) {
    return { ...base, state: "awaiting_fvg", stateDetail: "1m CHoCH confirmed — waiting for an FVG in its direction" };
  }
  base.fvg = fvg;

  const isLong = direction === "bullish";
  const entry = (fvg.top + fvg.bottom) / 2;

  // SL beyond the recent 1m swing: the most recent swing low (long) / high (short) before the FVG
  const recentSwing = [...ltfSwings]
    .filter((s) => s.type === (isLong ? "low" : "high") && s.index <= fvg.index)
    .sort((a, b) => b.index - a.index)[0];
  const fallbackWindow = ltfCandles.slice(Math.max(0, fvg.index - 20), fvg.index + 1);
  const swingLevel = recentSwing
    ? recentSwing.price
    : isLong
      ? Math.min(...fallbackWindow.map((c) => c.low))
      : Math.max(...fallbackWindow.map((c) => c.high));
  const buffer = 0.1 * atrNow;
  const stopLoss = isLong ? swingLevel - buffer : swingLevel + buffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) {
    return { ...base, state: "invalidated", stateDetail: "Degenerate risk distance" };
  }
  const takeProfit = isLong ? entry + RISK_MULTIPLE * risk : entry - RISK_MULTIPLE * risk;

  base.entry = entry;
  base.stopLoss = stopLoss;
  base.takeProfit = takeProfit;

  // walk price action after the FVG formed: midpoint touch triggers, SL-side
  // violation or a close through the far side of the gap invalidates first
  let state: TrendBreakState = "awaiting_pullback";
  let stateDetail = "FVG formed — waiting for the pullback to its midpoint";
  for (let i = fvg.index + 2; i < ltfCandles.length; i++) {
    const c = ltfCandles[i];
    const hitStop = isLong ? c.low <= stopLoss : c.high >= stopLoss;
    const closedThrough = isLong ? c.close < fvg.bottom : c.close > fvg.top;
    const touchedEntry = isLong ? c.low <= entry : c.high >= entry;
    if (state === "awaiting_pullback") {
      if (hitStop || closedThrough) {
        state = "invalidated";
        stateDetail = hitStop ? "Stop level was violated before entry" : "Price closed through the FVG before entry";
        break;
      }
      if (touchedEntry) {
        state = "triggered";
        stateDetail = "Price pulled back to the FVG midpoint — entry level tagged";
      }
    } else if (state === "triggered") {
      const hitTarget = isLong ? c.high >= takeProfit : c.low <= takeProfit;
      if (hitTarget) {
        state = "completed";
        stateDetail = "Setup played out — take profit was reached";
        break;
      }
      if (hitStop) {
        state = "completed";
        stateDetail = "Setup played out — stop level was reached after entry";
        break;
      }
    }
  }

  return { ...base, state, stateDetail };
}

/** A forming trend-break setup — the 15m context is in place but the 1m leg has not produced an entry yet. */
export interface TrendBreakWatch {
  symbol: string;
  direction: Direction;
  priorTrend: Direction;
  bosCount: number;
  breakPrice: number;
  state: TrendBreakState;
  stateDetail: string;
  generatedAt: number;
}

export function trendBreakWatchItem(symbol: string, setup: TrendBreakSetup): TrendBreakWatch | null {
  if (setup.state !== "awaiting_choch" && setup.state !== "awaiting_fvg") return null;
  return {
    symbol,
    direction: setup.direction,
    priorTrend: setup.priorTrend,
    bosCount: setup.bosCount,
    breakPrice: setup.breakPrice,
    state: setup.state,
    stateDetail: setup.stateDetail,
    generatedAt: Date.now(),
  };
}

/** Scanner shape for an actionable (FVG formed) trend-break setup. */
export function trendBreakOpportunity(symbol: string, setup: TrendBreakSetup): Opportunity | null {
  if (setup.entry === null || setup.stopLoss === null || setup.takeProfit === null) return null;
  if (setup.state !== "awaiting_pullback" && setup.state !== "triggered") return null;
  return {
    symbol,
    timeframe: "1m",
    direction: setup.direction === "bullish" ? "long" : "short",
    score: setup.state === "triggered" ? 85 : 70,
    factors: [
      {
        name: "15m trend break",
        detail: `${setup.bosCount} BoS ${setup.priorTrend} run · trendline broken · CHoCH confirmed`,
        weight: 40,
      },
      { name: "1m CHoCH", detail: "First 1m CHoCH after the trend break", weight: 20 },
      {
        name: "1m FVG midpoint",
        detail: setup.stateDetail,
        weight: setup.state === "triggered" ? 25 : 10,
      },
    ],
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskRewardRatio: RISK_MULTIPLE,
    generatedAt: Date.now(),
  };
}
