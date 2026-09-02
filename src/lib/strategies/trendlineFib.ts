import { atr, rsi } from "@/lib/indicators/core";
import type { Candle, Timeframe } from "@/lib/market/types";
import { detectSwings } from "./detectors";
import type { Direction, Opportunity, SwingPoint } from "./types";

export const TRENDLINE_FIB_STRATEGY_NAME = "Trendline Break + Fib Retracement";

/**
 * Trendline break + fibonacci retracement (any symbol/timeframe):
 * 1. Trendline: a falling resistance line through descending swing highs
 *    (downtrend) or a rising support line through ascending swing lows
 *    (uptrend) with at least 3 touch points, respected between touches
 *    (no candle CLOSE through the line),
 * 2. Break: a candle CLOSES through the line — a wick poking through that
 *    closes back on the trend side does not count. The fib anchors to the
 *    first candle that closes through the line IN THE TRADE'S DIRECTION
 *    (green for a buy, red for a sell); if no directional close arrives
 *    within a few candles of the break, the setup is abandoned,
 * 3. Fib: anchored from the swing extreme of the leg running into the break
 *    (fib 0 — the lowest low for a downtrend, highest high for an uptrend,
 *    measured from the line's last touch) to the anchor candle's high/low
 *    (fib 1),
 * 4. Entry: the 0.618 retracement on the break side of the line,
 * 5. SL just beyond the swing extreme (fib 0) with an ATR buffer,
 * 6. TP at a fib extension level — 2.618 by default, selectable.
 * Confirmation filters (toggleable): decisive break margin, a strong
 * directional break candle, and momentum (RSI) agreement.
 */

export type TrendlineFibState =
  | "awaiting_break" // a valid 3-touch trendline is in place, no close through it yet
  | "awaiting_pullback" // break candle closed through the line — waiting for the 0.618 tag
  | "triggered" // the 0.618 entry was tagged
  | "completed" // the trade played out after entry (TP or SL reached)
  | "invalidated";

export interface TrendlineFibSetup {
  kind: "trendline_fib";
  /** trade direction: bullish = downtrend line broken up, bearish = uptrend line broken down */
  direction: Direction;
  /** the trend the broken line belonged to */
  priorTrend: Direction;
  trendline: { fromTime: number; fromPrice: number; toTime: number; toPrice: number };
  /** number of qualifying touch points on the line */
  touches: number;
  touchTimes: number[];
  /** anchor candle (the first candle that CLOSED through the line in the trade's direction), once it exists */
  breakTime: number | null;
  /** trendline value at the anchor candle */
  breakLinePrice: number | null;
  /** fib 1 anchor: the anchor candle's high (bullish) / low (bearish) */
  fibOne: number | null;
  /** fib 0 anchor: the swing low (bullish) / swing high (bearish) of the leg into the break */
  swingPrice: number | null;
  swingTime: number | null;
  /** fib level used for the target */
  targetFib: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  state: TrendlineFibState;
  stateDetail: string;
}

export const FIB_TARGET_LEVELS = [1, 1.272, 1.618, 2, 2.618, 3, 3.618, 4.236] as const;
export const DEFAULT_FIB_TARGET = 2.618;
export const ENTRY_FIB = 0.618;
/** a clean setup pulls back to the 0.618 promptly — waiting longer invalidates */
export const DEFAULT_MAX_PULLBACK_BARS = 15;

const SWING_LOOKBACK = 5; // pivots confirm this many bars after the extreme
const MIN_TOUCHES = 3;
const TOUCH_TOL_ATR = 0.5; // a pivot within this of the line counts as a touch
const RESPECT_TOL_ATR = 0.1; // closes may exceed the line by at most this between touches
const MIN_TOUCH_SEP_BARS = 6; // touches must be distinct pivots, not one cluster
const MIN_TREND_SPAN_ATR = 2; // the line must cover a genuine trend leg
const BREAK_MARGIN_ATR = 0.15; // decisive break: the close must clear the line by this
const STRONG_BODY_RATIO = 0.5; // strong break candle: body at least this fraction of its range
const SL_BUFFER_ATR = 0.25; // "just outside" the swing extreme
const MAX_LINE_AGE_BARS = 60; // a forming line is only watched while its last touch is recent
const ANCHOR_WAIT_BARS = 5; // the directional close anchoring the fib must arrive this soon after the break

/** Confirmation checks that the price action is heading in the break direction (all on by default). */
export interface TrendlineFibFilters {
  /** the break close must clear the line by an ATR margin, not squeak through */
  decisiveBreak: boolean;
  /** the break candle must be a strong directional candle (body >= half its range, correct colour) */
  strongBreakCandle: boolean;
  /** RSI(14) must agree with the break direction on the break bar (> 50 buys, < 50 sells) */
  momentumFilter: boolean;
}

export const DEFAULT_TRENDLINE_FIB_FILTERS: TrendlineFibFilters = {
  decisiveBreak: true,
  strongBreakCandle: true,
  momentumFilter: true,
};

interface Line {
  /** bullish trade = falling resistance broken up; bearish trade = rising support broken down */
  direction: Direction;
  priorTrend: Direction;
  slope: number; // price per bar index
  anchorIndex: number;
  anchorPrice: number;
  touches: SwingPoint[];
}

function lineValueAt(line: Line, index: number): number {
  return line.anchorPrice + line.slope * (index - line.anchorIndex);
}

/**
 * Candidate trendlines with >= MIN_TOUCHES touches, respected between the
 * first and last touch (no close through the line beyond a small tolerance).
 * `resistance` finds falling lines over swing highs (downtrend); otherwise
 * rising lines over swing lows (uptrend).
 */
function findLines(candles: Candle[], pivots: SwingPoint[], atr14: (number | null)[], resistance: boolean): Line[] {
  const lines: Line[] = [];
  for (let a = 0; a < pivots.length - 1; a++) {
    for (let b = a + 1; b < pivots.length; b++) {
      const p1 = pivots[a];
      const p2 = pivots[b];
      if (p2.index - p1.index < MIN_TOUCH_SEP_BARS) continue;
      if (resistance ? p2.price >= p1.price : p2.price <= p1.price) continue;
      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      const line: Line = {
        direction: resistance ? "bullish" : "bearish",
        priorTrend: resistance ? "bearish" : "bullish",
        slope,
        anchorIndex: p1.index,
        anchorPrice: p1.price,
        touches: [],
      };
      // touches: pivots on/near the line, adequately separated
      const touches: SwingPoint[] = [];
      for (const p of pivots) {
        if (p.index < p1.index) continue;
        const tol = TOUCH_TOL_ATR * (atr14[p.index] ?? candles[p.index].close * 0.01);
        if (Math.abs(p.price - lineValueAt(line, p.index)) > tol) continue;
        if (touches.length > 0 && p.index - touches[touches.length - 1].index < MIN_TOUCH_SEP_BARS) continue;
        touches.push(p);
      }
      if (touches.length < MIN_TOUCHES) continue;
      const lastTouch = touches[touches.length - 1];
      // the line must cover a genuine trend leg, not a flat drift
      const atrLast = atr14[lastTouch.index] ?? candles[lastTouch.index].close * 0.01;
      const span = Math.abs(lineValueAt(line, p1.index) - lineValueAt(line, lastTouch.index));
      if (span < MIN_TREND_SPAN_ATR * atrLast) continue;
      // respected between the first and last touch: no candle CLOSE through the line
      let respected = true;
      for (let i = p1.index; i <= lastTouch.index; i++) {
        const lv = lineValueAt(line, i);
        const tol = RESPECT_TOL_ATR * (atr14[i] ?? candles[i].close * 0.01);
        if (resistance ? candles[i].close > lv + tol : candles[i].close < lv - tol) {
          respected = false;
          break;
        }
      }
      if (!respected) continue;
      line.touches = touches;
      lines.push(line);
    }
  }
  return lines;
}

/** The first candle after the last touch that CLOSES through the line at all. */
function findBreak(candles: Candle[], line: Line): number {
  const lastTouch = line.touches[line.touches.length - 1];
  const bullish = line.direction === "bullish";
  for (let i = lastTouch.index + 1; i < candles.length; i++) {
    const lv = lineValueAt(line, i);
    if (bullish ? candles[i].close > lv : candles[i].close < lv) return i;
  }
  return 0; // still unbroken
}

/**
 * The candle the fib anchors to: the first candle from the break onwards that
 * closes through the line in the trade's direction (green for a buy, red for
 * a sell), with the decisive margin when that filter is on. Returns the
 * anchor index, -1 if the setup failed (price closed back on the trend side
 * or no directional close arrived within ANCHOR_WAIT_BARS), or -2 if the
 * series ended while still waiting.
 */
function findAnchor(candles: Candle[], line: Line, breakIdx: number, atr14: (number | null)[], decisive: boolean): number {
  const bullish = line.direction === "bullish";
  for (let i = breakIdx; i < candles.length; i++) {
    if (i - breakIdx > ANCHOR_WAIT_BARS) return -1;
    const c = candles[i];
    const lv = lineValueAt(line, i);
    if (bullish ? c.close < lv : c.close > lv) return -1; // closed back on the trend side
    const margin = decisive ? BREAK_MARGIN_ATR * (atr14[i] ?? c.close * 0.01) : 0;
    const directional = bullish ? c.close > c.open : c.close < c.open;
    if (directional && (bullish ? c.close > lv + margin : c.close < lv - margin)) return i;
  }
  return -2; // still waiting for the directional close
}

interface BreakLevels {
  swingIndex: number;
  swingPrice: number;
  fibOne: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

/** Fib anchors and levels for a confirmed break of `line` anchored at `anchorIdx`. */
function fibLevels(candles: Candle[], line: Line, anchorIdx: number, atr14: (number | null)[], targetFib: number): BreakLevels | null {
  const bullish = line.direction === "bullish";
  const lastTouch = line.touches[line.touches.length - 1];
  // fib 0: the swing extreme of the leg running into the break — the lowest
  // low (bullish) / highest high (bearish) between the last touch and the
  // anchor candle
  let swingIndex = lastTouch.index;
  let swingPrice = bullish ? candles[lastTouch.index].low : candles[lastTouch.index].high;
  for (let i = lastTouch.index; i <= anchorIdx; i++) {
    if (bullish ? candles[i].low < swingPrice : candles[i].high > swingPrice) {
      swingPrice = bullish ? candles[i].low : candles[i].high;
      swingIndex = i;
    }
  }
  // fib 1: the anchor candle's high (bullish) / low (bearish)
  const fibOne = bullish ? candles[anchorIdx].high : candles[anchorIdx].low;
  const range = Math.abs(fibOne - swingPrice);
  if (range <= 0) return null;
  const atrHere = atr14[anchorIdx] ?? candles[anchorIdx].close * 0.01;
  const entry = bullish ? swingPrice + ENTRY_FIB * range : swingPrice - ENTRY_FIB * range;
  const stopLoss = bullish ? swingPrice - SL_BUFFER_ATR * atrHere : swingPrice + SL_BUFFER_ATR * atrHere;
  const takeProfit = bullish ? swingPrice + targetFib * range : swingPrice - targetFib * range;
  if (Math.abs(entry - stopLoss) <= 0) return null;
  return { swingIndex, swingPrice, fibOne, entry, stopLoss, takeProfit };
}

/** Confirmation filters applied to the break candle. */
function breakConfirmed(candles: Candle[], breakIdx: number, bullish: boolean, rsi14: (number | null)[], filters: TrendlineFibFilters): string | null {
  const c = candles[breakIdx];
  if (filters.strongBreakCandle) {
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const rightColour = bullish ? c.close > c.open : c.close < c.open;
    if (!rightColour || range <= 0 || body < STRONG_BODY_RATIO * range) {
      return "weak break candle";
    }
  }
  if (filters.momentumFilter) {
    const r = rsi14[breakIdx];
    if (r !== null && (bullish ? r <= 50 : r >= 50)) {
      return "momentum (RSI) against the break";
    }
  }
  return null;
}

export function detectTrendlineFibSetup(
  candles: Candle[],
  targetFib: number = DEFAULT_FIB_TARGET,
  filters: TrendlineFibFilters = DEFAULT_TRENDLINE_FIB_FILTERS,
  maxPullbackBars: number = DEFAULT_MAX_PULLBACK_BARS,
): TrendlineFibSetup | null {
  if (candles.length < 80) return null;
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(candles.map((c) => c.close), 14);
  const swings = detectSwings(candles, SWING_LOOKBACK);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");

  const lines = [
    ...findLines(candles, highs, atr14, true),
    ...findLines(candles, lows, atr14, false),
  ];
  if (lines.length === 0) return null;

  // most recent anchored break wins; among unbroken lines, the freshest (last touch)
  let best: { line: Line; anchorIdx: number } | null = null;
  let pending: { line: Line; breakIdx: number } | null = null;
  let forming: Line | null = null;
  for (const line of lines) {
    const breakIdx = findBreak(candles, line);
    if (breakIdx > 0) {
      const anchorIdx = findAnchor(candles, line, breakIdx, atr14, filters.decisiveBreak);
      if (anchorIdx >= 0) {
        if (!best || anchorIdx > best.anchorIdx || (anchorIdx === best.anchorIdx && line.touches.length > best.line.touches.length)) {
          best = { line, anchorIdx };
        }
      } else if (anchorIdx === -2) {
        if (!pending || breakIdx > pending.breakIdx) pending = { line, breakIdx };
      }
    } else {
      const lastTouch = line.touches[line.touches.length - 1];
      if (candles.length - 1 - lastTouch.index > MAX_LINE_AGE_BARS) continue;
      if (!forming || lastTouch.index > forming.touches[forming.touches.length - 1].index) forming = line;
    }
  }

  const describe = (line: Line): Pick<TrendlineFibSetup, "kind" | "direction" | "priorTrend" | "trendline" | "touches" | "touchTimes" | "targetFib"> => {
    const first = line.touches[0];
    const last = line.touches[line.touches.length - 1];
    return {
      kind: "trendline_fib",
      direction: line.direction,
      priorTrend: line.priorTrend,
      trendline: {
        fromTime: first.time,
        fromPrice: lineValueAt(line, first.index),
        toTime: last.time,
        toPrice: lineValueAt(line, last.index),
      },
      touches: line.touches.length,
      touchTimes: line.touches.map((t) => t.time),
      targetFib,
    };
  };

  if (!best) {
    const watch = pending?.line ?? forming;
    if (!watch) return null;
    const bullish = watch.direction === "bullish";
    return {
      ...describe(watch),
      breakTime: pending ? candles[pending.breakIdx].time : null,
      breakLinePrice: pending ? lineValueAt(pending.line, pending.breakIdx) : null,
      fibOne: null,
      swingPrice: null,
      swingTime: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      state: "awaiting_break",
      stateDetail: pending
        ? `Line broken — waiting for a ${bullish ? "green" : "red"} candle to CLOSE ${bullish ? "above" : "below"} it to anchor the fib`
        : `${bullish ? "Falling resistance" : "Rising support"} line with ${watch.touches.length} touches — waiting for a candle to CLOSE ${bullish ? "above" : "below"} it`,
    };
  }

  const { line, anchorIdx } = best;
  const bullish = line.direction === "bullish";
  const baseInfo = describe(line);
  const breakInfo = {
    breakTime: candles[anchorIdx].time,
    breakLinePrice: lineValueAt(line, anchorIdx),
  };

  const rejected = breakConfirmed(candles, anchorIdx, bullish, rsi14, filters);
  if (rejected) {
    return {
      ...baseInfo,
      ...breakInfo,
      fibOne: null,
      swingPrice: null,
      swingTime: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      state: "invalidated",
      stateDetail: `Trendline break rejected — ${rejected}`,
    };
  }

  const levels = fibLevels(candles, line, anchorIdx, atr14, targetFib);
  if (!levels) {
    return {
      ...baseInfo,
      ...breakInfo,
      fibOne: null,
      swingPrice: null,
      swingTime: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      state: "invalidated",
      stateDetail: "Degenerate fib range at the break",
    };
  }

  const full = {
    ...baseInfo,
    ...breakInfo,
    fibOne: levels.fibOne,
    swingPrice: levels.swingPrice,
    swingTime: candles[levels.swingIndex].time,
    entry: levels.entry,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
  };

  // walk price action after the break: the 0.618 tag triggers; a close back
  // through the line before the fill, a stop-side close, or expiry invalidates
  let state: TrendlineFibState = "awaiting_pullback";
  let stateDetail = `Break candle closed ${bullish ? "above the falling resistance" : "below the rising support"} — waiting for the ${ENTRY_FIB} fib pullback`;
  for (let i = anchorIdx + 1; i < candles.length; i++) {
    const c = candles[i];
    if (state === "awaiting_pullback") {
      const lv = lineValueAt(line, i);
      if (bullish ? c.close < lv : c.close > lv) {
        state = "invalidated";
        stateDetail = "Price closed back through the trendline before the fib entry filled";
        break;
      }
      if (bullish ? c.close < levels.stopLoss : c.close > levels.stopLoss) {
        state = "invalidated";
        stateDetail = "Price closed beyond the fib 0 swing before the entry filled";
        break;
      }
      if (i - anchorIdx > maxPullbackBars) {
        state = "invalidated";
        stateDetail = `Pullback took too long — the ${ENTRY_FIB} fib did not fill within ${maxPullbackBars} candles of the break`;
        break;
      }
      // the entry must be on the break side of the (extended) trendline
      const entryOnBreakSide = bullish ? levels.entry >= lv : levels.entry <= lv;
      if (entryOnBreakSide && (bullish ? c.low <= levels.entry : c.high >= levels.entry)) {
        state = "triggered";
        stateDetail = `Price pulled back to the ${ENTRY_FIB} fib — entry tagged`;
        continue;
      }
      if (bullish ? c.high >= levels.takeProfit : c.low <= levels.takeProfit) {
        state = "invalidated";
        stateDetail = "Price ran to the fib target without the pullback — entry missed";
        break;
      }
    } else if (state === "triggered") {
      if (bullish ? c.low <= levels.stopLoss : c.high >= levels.stopLoss) {
        state = "completed";
        stateDetail = "Setup played out — stop level was reached after entry";
        break;
      }
      if (bullish ? c.high >= levels.takeProfit : c.low <= levels.takeProfit) {
        state = "completed";
        stateDetail = "Setup played out — take profit was reached";
        break;
      }
    }
  }

  return { ...full, state, stateDetail };
}

export interface TrendlineFibTrade {
  direction: Direction;
  touches: number;
  breakTime: number;
  swingPrice: number;
  fibOne: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  targetFib: number;
  entryTime: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "tp" | "sl";
  rMultiple: number;
}

export interface TrendlineFibBacktest {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  /** distinct qualifying trendline breaks (both directions) */
  breaks: number;
  /** breaks rejected by the confirmation filters */
  filtered: number;
  /** confirmed breaks whose 0.618 entry never filled (invalidated/expired/ran off) */
  noFill: number;
  openAtEnd: number;
  trades: TrendlineFibTrade[];
  wins: number;
  losses: number;
  winRatePct: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownR: number;
  equityR: number[];
}

/**
 * Replay the trendline-break/fib strategy over a candle series exactly as
 * live detection resolves it: 3-touch trendline, a candle CLOSING through it,
 * fib from the trend's swing extreme (0) to the break candle's high/low (1),
 * entry at the 0.618 pullback on the break side, SL beyond the swing with an
 * ATR buffer, TP at the chosen fib extension (2.618 default). No look-ahead:
 * a line's touches are swing pivots that only confirm SWING_LOOKBACK bars
 * later, and entries only fill from the break candle onwards. One position at
 * a time; a bar spanning both SL and TP counts as a stop (conservative).
 */
export function backtestTrendlineFib(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  targetFib: number = DEFAULT_FIB_TARGET,
  filters: TrendlineFibFilters = DEFAULT_TRENDLINE_FIB_FILTERS,
  maxPullbackBars: number = DEFAULT_MAX_PULLBACK_BARS,
): TrendlineFibBacktest {
  const n = candles.length;
  const atr14 = atr(candles, 14);
  const rsi14 = rsi(candles.map((c) => c.close), 14);
  const swings = detectSwings(candles, SWING_LOOKBACK);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");

  const lines = [
    ...findLines(candles, highs, atr14, true),
    ...findLines(candles, lows, atr14, false),
  ];

  // one event per (direction, break bar): overlapping pivot pairs describe the
  // same line — keep the one with the most touches
  const events = new Map<string, { line: Line; breakIdx: number; anchorIdx: number }>();
  let filtered = 0;
  for (const line of lines) {
    const breakIdx = findBreak(candles, line);
    if (breakIdx <= 0) continue;
    // the last touch pivot must have been confirmable before the break
    const lastTouch = line.touches[line.touches.length - 1];
    if (breakIdx < lastTouch.index + SWING_LOOKBACK) continue;
    const anchorIdx = findAnchor(candles, line, breakIdx, atr14, filters.decisiveBreak);
    if (anchorIdx < 0) continue;
    const key = `${line.direction}-${breakIdx}`;
    const cur = events.get(key);
    if (!cur || line.touches.length > cur.line.touches.length) events.set(key, { line, breakIdx, anchorIdx });
  }

  const ordered = [...events.values()].sort((x, y) => x.anchorIdx - y.anchorIdx);
  const trades: TrendlineFibTrade[] = [];
  let noFill = 0;
  let openAtEnd = 0;
  let busyUntil = -1;

  for (const { line, anchorIdx } of ordered) {
    if (anchorIdx <= busyUntil) continue;
    const bullish = line.direction === "bullish";
    if (breakConfirmed(candles, anchorIdx, bullish, rsi14, filters) !== null) {
      filtered++;
      continue;
    }
    const levels = fibLevels(candles, line, anchorIdx, atr14, targetFib);
    if (!levels) {
      filtered++;
      continue;
    }

    // wait for the 0.618 fill on the break side of the extended line
    let entryIdx = -1;
    for (let i = anchorIdx + 1; i < n; i++) {
      const c = candles[i];
      const lv = lineValueAt(line, i);
      if (bullish ? c.close < lv : c.close > lv) break;
      if (bullish ? c.close < levels.stopLoss : c.close > levels.stopLoss) break;
      if (i - anchorIdx > maxPullbackBars) break;
      const entryOnBreakSide = bullish ? levels.entry >= lv : levels.entry <= lv;
      if (entryOnBreakSide && (bullish ? c.low <= levels.entry : c.high >= levels.entry)) {
        entryIdx = i;
        break;
      }
      if (bullish ? c.high >= levels.takeProfit : c.low <= levels.takeProfit) break;
    }
    if (entryIdx < 0) {
      noFill++;
      continue;
    }

    // in trade: SL checked before TP (conservative on bars spanning both)
    let exit: { index: number; price: number; reason: "tp" | "sl" } | null = null;
    for (let i = entryIdx + 1; i < n; i++) {
      const c = candles[i];
      if (bullish ? c.low <= levels.stopLoss : c.high >= levels.stopLoss) {
        exit = { index: i, price: levels.stopLoss, reason: "sl" };
        break;
      }
      if (bullish ? c.high >= levels.takeProfit : c.low <= levels.takeProfit) {
        exit = { index: i, price: levels.takeProfit, reason: "tp" };
        break;
      }
    }
    if (!exit) {
      openAtEnd++;
      busyUntil = n;
      continue;
    }

    const risk = Math.abs(levels.entry - levels.stopLoss);
    trades.push({
      direction: line.direction,
      touches: line.touches.length,
      breakTime: candles[anchorIdx].time,
      swingPrice: levels.swingPrice,
      fibOne: levels.fibOne,
      entry: levels.entry,
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      targetFib,
      entryTime: candles[entryIdx].time,
      exitTime: candles[exit.index].time,
      exitPrice: exit.price,
      exitReason: exit.reason,
      rMultiple: exit.reason === "tp" ? Number((Math.abs(levels.takeProfit - levels.entry) / risk).toFixed(2)) : -1,
    });
    busyUntil = exit.index;
  }

  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = trades.filter((t) => t.rMultiple <= 0).length;
  const totalR = trades.reduce((s, t) => s + t.rMultiple, 0);
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rMultiple < 0).reduce((s, t) => s + t.rMultiple, 0));
  const equityR: number[] = [];
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of trades) {
    eq += t.rMultiple;
    equityR.push(Number(eq.toFixed(2)));
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, peak - eq);
  }

  return {
    symbol: symbol.toUpperCase(),
    timeframe,
    bars: n,
    breaks: ordered.length,
    filtered,
    noFill,
    openAtEnd,
    trades,
    wins,
    losses,
    winRatePct: trades.length ? Number(((wins / trades.length) * 100).toFixed(1)) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: trades.length ? Number((totalR / trades.length).toFixed(2)) : 0,
    profitFactor: grossLoss > 0 ? Number((grossWin / grossLoss).toFixed(2)) : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: Number(maxDd.toFixed(2)),
    equityR,
  };
}

/** A forming trendline-fib setup — not actionable yet, worth watching. */
export interface TrendlineFibWatch {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction;
  priorTrend: Direction;
  touches: number;
  state: TrendlineFibState;
  stateDetail: string;
  generatedAt: number;
}

export function trendlineFibWatchItem(symbol: string, timeframe: Timeframe, setup: TrendlineFibSetup): TrendlineFibWatch | null {
  if (setup.state !== "awaiting_break") return null;
  return {
    symbol,
    timeframe,
    direction: setup.direction,
    priorTrend: setup.priorTrend,
    touches: setup.touches,
    state: setup.state,
    stateDetail: setup.stateDetail,
    generatedAt: Date.now(),
  };
}

/** Scanner shape for an actionable trendline-fib setup. */
export function trendlineFibOpportunity(symbol: string, timeframe: Timeframe, setup: TrendlineFibSetup): Opportunity | null {
  if (setup.entry === null || setup.stopLoss === null || setup.takeProfit === null) return null;
  if (setup.state !== "awaiting_pullback" && setup.state !== "triggered") return null;
  const risk = Math.abs(setup.entry - setup.stopLoss);
  const bullish = setup.direction === "bullish";
  return {
    symbol,
    timeframe,
    direction: bullish ? "long" : "short",
    score: setup.state === "triggered" ? 85 : 75,
    factors: [
      {
        name: bullish ? "Falling resistance broken" : "Rising support broken",
        detail: `${setup.touches}-touch trendline · break candle CLOSED ${bullish ? "above" : "below"} the line`,
        weight: 35,
      },
      {
        name: "Fib retracement",
        detail: `0 at swing ${setup.swingPrice?.toFixed(2)} → 1 at break ${setup.fibOne?.toFixed(2)} · entry at ${ENTRY_FIB} · TP at ${setup.targetFib}`,
        weight: 30,
      },
      { name: "Entry", detail: setup.stateDetail, weight: setup.state === "triggered" ? 10 : 0 },
    ],
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskRewardRatio: risk > 0 ? Number((Math.abs(setup.takeProfit - setup.entry) / risk).toFixed(2)) : 0,
    generatedAt: Date.now(),
  };
}
