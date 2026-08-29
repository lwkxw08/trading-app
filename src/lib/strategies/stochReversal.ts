import { atr, sma } from "@/lib/indicators/core";
import type { Candle, Timeframe } from "@/lib/market/types";
import { detectStructureBreaks, detectSwings } from "./detectors";
import type { Direction, Opportunity } from "./types";

export const STOCH_REVERSAL_STRATEGY_NAME = "Stochastic Double Top/Bottom";

/**
 * Stochastic double top/bottom reversal (cross-asset, single candle series):
 * 1. Pattern: two swing highs at (or very near) the same level with a trough
 *    between them — a double top (mirror: double bottom with a peak between),
 * 2. Momentum: the slow stochastic is overbought (>= 80) at the second top
 *    (mirror: oversold <= 20 at the second bottom),
 * 3. Confirmation: price action must show the reversal is in effect — a close
 *    through the neckline (the interim trough/peak), a CHoCH against the
 *    prior move, or an engulfing reversal candle right at the second extreme
 *    while the stochastic is still there — before the setup is actionable,
 * 4. Levels: sell the neckline retest — or, in breakout mode, the close of the
 *    confirmation bar itself so vertical moves that never retest aren't missed
 *    (skipped when that close already reached the measured-move target) — SL
 *    just beyond the pattern extreme with an ATR buffer, TP at the measured
 *    move (pattern height projected from the neckline), extended to a minimum
 *    R multiple from the actual entry when the pattern is shallow.
 */

/** How the confirmed setup is entered: the neckline retest, the confirmation-bar
 * close (breakout), or the breakout when it offers enough R falling back to the
 * retest otherwise. Outside retest mode, an engulfing reversal candle at the
 * second extreme is an additional early trigger entered at its close. */
export type StochReversalEntryMode = "retest" | "breakout" | "both";

export type StochReversalState =
  | "awaiting_pattern" // no qualifying double top/bottom with a stochastic extreme yet
  | "awaiting_confirmation" // pattern formed — waiting for price action to confirm the reversal
  | "armed" // reversal confirmed, entry at the neckline retest, not tagged yet
  | "triggered" // entry level tagged after confirmation
  | "completed" // the trade played out after entry (TP or SL reached)
  | "invalidated";

export interface StochReversalSetup {
  kind: "stoch_reversal";
  /** trade direction: bearish = double top short, bullish = double bottom long */
  direction: Direction | null;
  pattern: "double_top" | "double_bottom" | null;
  firstExtreme: number | null;
  secondExtreme: number | null;
  firstExtremeTime: number | null;
  secondExtremeTime: number | null;
  /** the interim trough (double top) / peak (double bottom) */
  neckline: number | null;
  /** slow stochastic %K at the second top/bottom */
  stochAtSecond: number | null;
  /** what confirmed the reversal, once it has */
  confirmation: "neckline_break" | "choch" | "engulfing" | null;
  confirmationTime: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  /** how the entry was (or will be) taken once confirmed */
  entryKind: "retest" | "breakout" | "engulfing" | null;
  state: StochReversalState;
  stateDetail: string;
}

const STOCH_PERIOD = 14;
const STOCH_SMOOTH = 3;
const OVERBOUGHT = 80;
const OVERSOLD = 20;
const TOP_TOLERANCE_ATR = 0.75; // max distance between the two extremes
const MIN_HEIGHT_ATR = 1; // min pattern height (extreme to neckline)
const MAX_PATTERN_AGE_BARS = 120; // second extreme must be this recent
const MAX_EXTREME_GAP_BARS = 80; // max bars between the two extremes
const STOCH_WINDOW_BARS = 2; // stochastic extreme within +/- this of the second top/bottom
const STOP_BUFFER_ATR = 0.5; // "some room" above/below the pattern extreme
const MIN_RR = 1.5; // ensure a sensible R/R: at least this R when the measured move is nearer
const TREND_LOOKBACK_BARS = 40; // window before the first extreme measured for the prior leg
const MIN_TREND_LEG_ATR = 3; // the move into the first extreme must span at least this
const BREAK_MARGIN_ATR = 0.15; // decisive neckline break: the close must clear it by this
const BREAKOUT_MAX_CONSUMED = 0.5; // breakout entry skipped when the confirmation close already covered this fraction of the measured move
const ENGULF_WINDOW_BARS = 10; // an engulfing reversal candle counts as a trigger only this close to the second extreme

/** Quality filters that cut range-bound/chop patterns (all on by default). */
export interface StochReversalFilters {
  /** the pattern must cap a genuine prior trend leg into the first extreme */
  trendFilter: boolean;
  /** the stochastic must diverge at the second extreme (weaker momentum than the first) */
  divergenceFilter: boolean;
  /** the confirming close must clear the neckline by a margin, not squeak through */
  decisiveBreak: boolean;
}

export const DEFAULT_STOCH_REVERSAL_FILTERS: StochReversalFilters = {
  trendFilter: true,
  divergenceFilter: true,
  decisiveBreak: true,
};

/** The move into the first extreme: for a double top, the rise from the lowest
 * low of the preceding window to the first peak (mirror for bottoms). */
function priorLegOk(candles: Candle[], first: { price: number; index: number }, bearish: boolean, atrHere: number): boolean {
  const from = Math.max(0, first.index - TREND_LOOKBACK_BARS);
  let opposite = bearish ? Infinity : -Infinity;
  for (let j = from; j <= first.index; j++) {
    opposite = bearish ? Math.min(opposite, candles[j].low) : Math.max(opposite, candles[j].high);
  }
  const leg = bearish ? first.price - opposite : opposite - first.price;
  return leg >= MIN_TREND_LEG_ATR * atrHere;
}

/** A reversal candle whose body engulfs the previous bar's opposite-coloured body. */
function isEngulfing(prev: Candle, cur: Candle, bearish: boolean): boolean {
  return bearish
    ? cur.close < cur.open && prev.close > prev.open && cur.open >= prev.close && cur.close <= prev.open
    : cur.close > cur.open && prev.close < prev.open && cur.open <= prev.close && cur.close >= prev.open;
}

/** Slow stochastic %K: raw %K smoothed with an SMA. */
export function stochasticK(candles: Candle[], period = STOCH_PERIOD, smooth = STOCH_SMOOTH): (number | null)[] {
  const raw: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    raw[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  const firstIdx = raw.findIndex((v) => v !== null);
  if (firstIdx < 0) return raw;
  const smoothed = sma(raw.slice(firstIdx) as number[], smooth);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = 0; i < smoothed.length; i++) out[firstIdx + i] = smoothed[i];
  return out;
}

function base(state: StochReversalState, stateDetail: string, partial?: Partial<StochReversalSetup>): StochReversalSetup {
  return {
    kind: "stoch_reversal",
    direction: null,
    pattern: null,
    firstExtreme: null,
    secondExtreme: null,
    firstExtremeTime: null,
    secondExtremeTime: null,
    neckline: null,
    stochAtSecond: null,
    confirmation: null,
    confirmationTime: null,
    entry: null,
    stopLoss: null,
    takeProfit: null,
    entryKind: null,
    state,
    stateDetail,
    ...partial,
  };
}

interface PatternCandidate {
  pattern: "double_top" | "double_bottom";
  direction: Direction;
  first: { price: number; index: number; time: number };
  second: { price: number; index: number; time: number };
  neckline: number;
  stochAtSecond: number;
}

function stochNearIndex(stoch: (number | null)[], index: number, wantHigh: boolean): number | null {
  let best: number | null = null;
  for (let i = Math.max(0, index - STOCH_WINDOW_BARS); i <= Math.min(stoch.length - 1, index + STOCH_WINDOW_BARS); i++) {
    const v = stoch[i];
    if (v === null) continue;
    if (best === null || (wantHigh ? v > best : v < best)) best = v;
  }
  return best;
}

export function detectStochReversalSetup(
  candles: Candle[],
  entryMode: StochReversalEntryMode = "both",
  filters: StochReversalFilters = DEFAULT_STOCH_REVERSAL_FILTERS,
): StochReversalSetup | null {
  if (candles.length < 80) return null;

  const atr14 = atr(candles, 14);
  const lastIdx = candles.length - 1;
  const price = candles[lastIdx].close;
  const atrNow = atr14[lastIdx] ?? price * 0.01;
  const stoch = stochasticK(candles);
  const swings = detectSwings(candles);

  // find the most recent qualifying double top / double bottom
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  const candidates: PatternCandidate[] = [];

  for (let b = highs.length - 1; b >= 1; b--) {
    const second = highs[b];
    if (lastIdx - second.index > MAX_PATTERN_AGE_BARS) break;
    for (let a = b - 1; a >= 0; a--) {
      const first = highs[a];
      if (second.index - first.index > MAX_EXTREME_GAP_BARS) break;
      if (Math.abs(second.price - first.price) > TOP_TOLERANCE_ATR * atrNow) continue;
      const between = lows.filter((l) => l.index > first.index && l.index < second.index);
      if (between.length === 0) continue;
      const neckline = Math.min(...between.map((l) => l.price));
      if (Math.max(first.price, second.price) - neckline < MIN_HEIGHT_ATR * atrNow) continue;
      const st = stochNearIndex(stoch, second.index, true);
      if (st === null || st < OVERBOUGHT) continue;
      if (filters.divergenceFilter) {
        const stFirst = stochNearIndex(stoch, first.index, true);
        if (stFirst !== null && st >= stFirst) continue;
      }
      if (filters.trendFilter && !priorLegOk(candles, first, true, atrNow)) continue;
      candidates.push({
        pattern: "double_top",
        direction: "bearish",
        first: { price: first.price, index: first.index, time: first.time },
        second: { price: second.price, index: second.index, time: second.time },
        neckline,
        stochAtSecond: st,
      });
      break;
    }
    if (candidates.length > 0 && candidates[candidates.length - 1].pattern === "double_top") break;
  }

  for (let b = lows.length - 1; b >= 1; b--) {
    const second = lows[b];
    if (lastIdx - second.index > MAX_PATTERN_AGE_BARS) break;
    for (let a = b - 1; a >= 0; a--) {
      const first = lows[a];
      if (second.index - first.index > MAX_EXTREME_GAP_BARS) break;
      if (Math.abs(second.price - first.price) > TOP_TOLERANCE_ATR * atrNow) continue;
      const between = highs.filter((h) => h.index > first.index && h.index < second.index);
      if (between.length === 0) continue;
      const neckline = Math.max(...between.map((h) => h.price));
      if (neckline - Math.min(first.price, second.price) < MIN_HEIGHT_ATR * atrNow) continue;
      const st = stochNearIndex(stoch, second.index, false);
      if (st === null || st > OVERSOLD) continue;
      if (filters.divergenceFilter) {
        const stFirst = stochNearIndex(stoch, first.index, false);
        if (stFirst !== null && st <= stFirst) continue;
      }
      if (filters.trendFilter && !priorLegOk(candles, first, false, atrNow)) continue;
      candidates.push({
        pattern: "double_bottom",
        direction: "bullish",
        first: { price: first.price, index: first.index, time: first.time },
        second: { price: second.price, index: second.index, time: second.time },
        neckline,
        stochAtSecond: st,
      });
      break;
    }
    if (candidates.length > 0 && candidates[candidates.length - 1].pattern === "double_bottom") break;
  }

  const cand = candidates.sort((a, b) => b.second.index - a.second.index)[0];
  if (!cand) {
    return base(
      "awaiting_pattern",
      "No double top/bottom with a stochastic extreme (80+/20-) at the second peak/trough yet",
    );
  }

  const bearish = cand.pattern === "double_top";
  const patternInfo: Partial<StochReversalSetup> = {
    direction: cand.direction,
    pattern: cand.pattern,
    firstExtreme: cand.first.price,
    secondExtreme: cand.second.price,
    firstExtremeTime: cand.first.time,
    secondExtremeTime: cand.second.time,
    neckline: cand.neckline,
    stochAtSecond: cand.stochAtSecond,
  };

  // levels
  const patternExtreme = bearish ? Math.max(cand.first.price, cand.second.price) : Math.min(cand.first.price, cand.second.price);
  const stopLoss = bearish ? patternExtreme + STOP_BUFFER_ATR * atrNow : patternExtreme - STOP_BUFFER_ATR * atrNow;
  const entry = cand.neckline;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return base("invalidated", "Degenerate risk distance", patternInfo);
  const height = Math.abs(patternExtreme - cand.neckline);
  const measured = bearish ? entry - height : entry + height;
  const minTarget = bearish ? entry - MIN_RR * risk : entry + MIN_RR * risk;
  const takeProfit = bearish ? Math.min(measured, minTarget) : Math.max(measured, minTarget);
  const spentLevel = bearish
    ? entry - BREAKOUT_MAX_CONSUMED * (entry - measured)
    : entry + BREAKOUT_MAX_CONSUMED * (measured - entry);

  // engulfing trigger (outside retest mode): an engulfing reversal candle right
  // at the second extreme, with the stochastic still there, confirms the
  // reversal early — entered at that candle's close, well before the neckline
  // break would confirm
  if (entryMode !== "retest") {
    const lastE = Math.min(candles.length - 1, cand.second.index + ENGULF_WINDOW_BARS);
    for (let i = cand.second.index + 1; i <= lastE; i++) {
      const cc = candles[i];
      if (bearish ? cc.close > stopLoss : cc.close < stopLoss) break; // died before triggering — the main loop reports it
      if (!isEngulfing(candles[i - 1], cc, bearish)) continue;
      const kE = stoch[i];
      const kP = stoch[i - 1];
      const atExtreme =
        (kE !== null && (bearish ? kE >= OVERBOUGHT : kE <= OVERSOLD)) ||
        (kP !== null && (bearish ? kP >= OVERBOUGHT : kP <= OVERSOLD));
      if (!atExtreme) continue;
      const eClose = cc.close;
      const eRisk = Math.abs(eClose - stopLoss);
      const eSpent = bearish ? eClose <= spentLevel : eClose >= spentLevel;
      if (eSpent || eRisk <= 0) break;
      const eTp = bearish ? Math.min(measured, eClose - MIN_RR * eRisk) : Math.max(measured, eClose + MIN_RR * eRisk);
      let state: StochReversalState = "triggered";
      let stateDetail = `Entered at the close of the ${bearish ? "bearish" : "bullish"} engulfing candle at the second ${bearish ? "top" : "bottom"} (engulfing trigger)`;
      for (let j = i + 1; j < candles.length; j++) {
        const c2 = candles[j];
        if (bearish ? c2.low <= eTp : c2.high >= eTp) {
          state = "completed";
          stateDetail = "Setup played out — take profit was reached";
          break;
        }
        if (bearish ? c2.high >= stopLoss : c2.low <= stopLoss) {
          state = "completed";
          stateDetail = "Setup played out — stop level was reached after entry";
          break;
        }
      }
      return base(state, stateDetail, {
        ...patternInfo,
        confirmation: "engulfing",
        confirmationTime: cc.time,
        entry: eClose,
        stopLoss,
        takeProfit: eTp,
        entryKind: "engulfing",
      });
    }
  }

  // reversal confirmation after the second extreme: a close through the
  // neckline, or a CHoCH in the reversal direction
  const breaks = detectStructureBreaks(candles, swings);
  const choch = breaks.find((br) => br.type === "choch" && br.direction === cand.direction && br.index > cand.second.index);
  const breakMargin = filters.decisiveBreak ? BREAK_MARGIN_ATR * atrNow : 0;
  let confIndex = -1;
  let confirmation: "neckline_break" | "choch" | null = null;
  for (let i = cand.second.index + 1; i < candles.length; i++) {
    const c = candles[i];
    // pattern dies if price closes beyond the stop level before confirming
    if (bearish ? c.close > stopLoss : c.close < stopLoss) {
      return base(
        "invalidated",
        `Price closed ${bearish ? "above" : "below"} the double ${bearish ? "top" : "bottom"} before the reversal confirmed`,
        patternInfo,
      );
    }
    if (bearish ? c.close < cand.neckline - breakMargin : c.close > cand.neckline + breakMargin) {
      confIndex = i;
      confirmation = "neckline_break";
      break;
    }
    if (choch && choch.index === i) {
      confIndex = i;
      confirmation = "choch";
      break;
    }
  }

  if (confIndex < 0) {
    return base(
      "awaiting_confirmation",
      `Double ${bearish ? "top" : "bottom"} in place (stoch ${cand.stochAtSecond.toFixed(0)}) — waiting for price action to confirm the reversal (neckline ${bearish ? "break down" : "break up"} or CHoCH)`,
      patternInfo,
    );
  }

  // breakout entry: take the confirmation-bar close itself — the TP is then
  // recomputed from that entry (measured move, or the minimum R when nearer)
  // and the entry is skipped when the move is already spent (the confirmation
  // close consumed too much of the measured move — late confirmations leave a
  // TP that can't realistically be reached) or the stochastic sits at the
  // wrong extreme on the confirmation bar
  const confClose = candles[confIndex].close;
  const ranTooFar = bearish ? confClose <= spentLevel : confClose >= spentLevel;
  const breakoutRisk = Math.abs(confClose - stopLoss);
  const confK = stoch[confIndex];
  const wrongSide = confK !== null && (bearish ? confK <= OVERSOLD : confK >= OVERBOUGHT);
  const useBreakout = entryMode !== "retest" && !ranTooFar && !wrongSide && breakoutRisk > 0;
  const breakoutTp = bearish
    ? Math.min(measured, confClose - MIN_RR * breakoutRisk)
    : Math.max(measured, confClose + MIN_RR * breakoutRisk);

  const levels: Partial<StochReversalSetup> = {
    ...patternInfo,
    confirmation,
    confirmationTime: candles[confIndex].time,
    entry: useBreakout ? confClose : entry,
    stopLoss,
    takeProfit: useBreakout ? breakoutTp : takeProfit,
    entryKind: useBreakout ? "breakout" : "retest",
  };

  if (useBreakout) {
    let state: StochReversalState = "triggered";
    let stateDetail = `Entered at the ${confirmation === "choch" ? "CHoCH" : "neckline break"} close (breakout entry)`;
    for (let i = confIndex + 1; i < candles.length; i++) {
      const c = candles[i];
      if (bearish ? c.low <= breakoutTp : c.high >= breakoutTp) {
        state = "completed";
        stateDetail = "Setup played out — take profit was reached";
        break;
      }
      if (bearish ? c.high >= stopLoss : c.low <= stopLoss) {
        state = "completed";
        stateDetail = "Setup played out — stop level was reached after entry";
        break;
      }
    }
    return base(state, stateDetail, levels);
  }

  if (entryMode === "breakout") {
    return base(
      "invalidated",
      wrongSide
        ? `Breakout entry skipped — the stochastic was ${bearish ? "oversold at the breakdown (a sell is blocked)" : "overbought at the breakout (a buy is blocked)"}`
        : "Confirmation came too late — the close had already consumed too much of the measured move, so the breakout entry was skipped",
      levels,
    );
  }

  // walk price action after confirmation: neckline retest triggers, stop-side
  // close invalidates, TP/SL hit after entry completes the setup
  let state: StochReversalState = "armed";
  let stateDetail = `Reversal confirmed (${confirmation === "choch" ? "CHoCH" : "neckline break"}) — ${bearish ? "sell" : "buy"} the neckline retest with the stochastic ${bearish ? "overbought (80+)" : "oversold (20-)"}`;
  for (let i = confIndex + 1; i < candles.length; i++) {
    const c = candles[i];
    const k = stoch[i];
    // a sell only fires with the stochastic overbought, a buy only with it oversold
    const stochGateOk = k !== null && (bearish ? k >= OVERBOUGHT : k <= OVERSOLD);
    if (state === "armed") {
      if (bearish ? c.close > stopLoss : c.close < stopLoss) {
        state = "invalidated";
        stateDetail = "Price closed beyond the stop level before entry";
        break;
      }
      if (c.low <= entry && c.high >= entry) {
        if (stochGateOk) {
          state = "triggered";
          stateDetail = "Neckline retest tagged the entry with the stochastic at the extreme";
          continue;
        }
        stateDetail = `Neckline retest reached, but the stochastic is not ${bearish ? "overbought (80+) — a sell is blocked" : "oversold (20-) — a buy is blocked"}; waiting for a valid retest`;
      }
      if (bearish ? c.low <= takeProfit : c.high >= takeProfit) {
        state = "invalidated";
        stateDetail = "Price ran to the target without a stochastic-qualified retest — entry missed";
        break;
      }
    } else if (state === "triggered") {
      if (bearish ? c.low <= takeProfit : c.high >= takeProfit) {
        state = "completed";
        stateDetail = "Setup played out — take profit was reached";
        break;
      }
      if (bearish ? c.high >= stopLoss : c.low <= stopLoss) {
        state = "completed";
        stateDetail = "Setup played out — stop level was reached after entry";
        break;
      }
    }
  }

  return base(state, stateDetail, levels);
}

const SWING_LOOKBACK = 5; // detectSwings default — a swing confirms this many bars after its extreme

export interface StochReversalTrade {
  pattern: "double_top" | "double_bottom";
  direction: Direction;
  secondExtremeTime: number;
  confirmation: "neckline_break" | "choch" | "engulfing";
  confirmationTime: number;
  entryKind: "retest" | "breakout" | "engulfing";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "tp" | "sl";
  rMultiple: number;
}

export interface StochReversalBacktest {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  patterns: number;
  unconfirmed: number;
  missed: number;
  openAtEnd: number;
  trades: StochReversalTrade[];
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
 * Replay the stochastic double top/bottom strategy over a single candle
 * series, exactly as live detection resolves it: qualifying pattern (two
 * near-equal extremes, interim neckline, stochastic 80+/20- at the second),
 * reversal confirmation (neckline close-through, CHoCH, or an engulfing
 * reversal candle at the second extreme), then the entry per the chosen mode:
 * the neckline retest — only taken with the stochastic back at the extreme
 * (80+ for sells, 20- for buys) — and/or the confirmation-bar close (breakout,
 * skipped when the move is spent or the stochastic is at the wrong extreme) —
 * with SL beyond the extreme and the measured-move/min-R target.
 * No look-ahead: a pattern only becomes tradeable once its second swing has
 * confirmed (SWING_LOOKBACK bars later), so entries are never filled before
 * the pattern was knowable. One position at a time; a bar spanning both SL
 * and TP counts as a stop (conservative).
 */
export function backtestStochReversal(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  entryMode: StochReversalEntryMode = "both",
  filters: StochReversalFilters = DEFAULT_STOCH_REVERSAL_FILTERS,
): StochReversalBacktest {
  const n = candles.length;
  const atr14 = atr(candles, 14);
  const stoch = stochasticK(candles);
  const swings = detectSwings(candles, SWING_LOOKBACK);
  const breaks = detectStructureBreaks(candles, swings);
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");

  const candidates: PatternCandidate[] = [];
  for (let b = 1; b < highs.length; b++) {
    const second = highs[b];
    const atrHere = atr14[second.index] ?? candles[second.index].close * 0.01;
    for (let a = b - 1; a >= 0; a--) {
      const first = highs[a];
      if (second.index - first.index > MAX_EXTREME_GAP_BARS) break;
      if (Math.abs(second.price - first.price) > TOP_TOLERANCE_ATR * atrHere) continue;
      const between = lows.filter((l) => l.index > first.index && l.index < second.index);
      if (between.length === 0) continue;
      const neckline = Math.min(...between.map((l) => l.price));
      if (Math.max(first.price, second.price) - neckline < MIN_HEIGHT_ATR * atrHere) continue;
      const st = stochNearIndex(stoch, second.index, true);
      if (st === null || st < OVERBOUGHT) continue;
      if (filters.divergenceFilter) {
        const stFirst = stochNearIndex(stoch, first.index, true);
        if (stFirst !== null && st >= stFirst) continue;
      }
      if (filters.trendFilter && !priorLegOk(candles, first, true, atrHere)) continue;
      candidates.push({
        pattern: "double_top",
        direction: "bearish",
        first: { price: first.price, index: first.index, time: first.time },
        second: { price: second.price, index: second.index, time: second.time },
        neckline,
        stochAtSecond: st,
      });
      break;
    }
  }
  for (let b = 1; b < lows.length; b++) {
    const second = lows[b];
    const atrHere = atr14[second.index] ?? candles[second.index].close * 0.01;
    for (let a = b - 1; a >= 0; a--) {
      const first = lows[a];
      if (second.index - first.index > MAX_EXTREME_GAP_BARS) break;
      if (Math.abs(second.price - first.price) > TOP_TOLERANCE_ATR * atrHere) continue;
      const between = highs.filter((h) => h.index > first.index && h.index < second.index);
      if (between.length === 0) continue;
      const neckline = Math.max(...between.map((h) => h.price));
      if (neckline - Math.min(first.price, second.price) < MIN_HEIGHT_ATR * atrHere) continue;
      const st = stochNearIndex(stoch, second.index, false);
      if (st === null || st > OVERSOLD) continue;
      if (filters.divergenceFilter) {
        const stFirst = stochNearIndex(stoch, first.index, false);
        if (stFirst !== null && st <= stFirst) continue;
      }
      if (filters.trendFilter && !priorLegOk(candles, first, false, atrHere)) continue;
      candidates.push({
        pattern: "double_bottom",
        direction: "bullish",
        first: { price: first.price, index: first.index, time: first.time },
        second: { price: second.price, index: second.index, time: second.time },
        neckline,
        stochAtSecond: st,
      });
      break;
    }
  }
  candidates.sort((x, y) => x.second.index - y.second.index);

  const trades: StochReversalTrade[] = [];
  let unconfirmed = 0;
  let missed = 0;
  let openAtEnd = 0;
  let busyUntil = -1; // index of the last trade's exit — one position at a time

  for (const cand of candidates) {
    if (cand.second.index <= busyUntil) continue;
    const bearish = cand.pattern === "double_top";
    const atrHere = atr14[cand.second.index] ?? candles[cand.second.index].close * 0.01;
    const patternExtreme = bearish ? Math.max(cand.first.price, cand.second.price) : Math.min(cand.first.price, cand.second.price);
    const stopLoss = bearish ? patternExtreme + STOP_BUFFER_ATR * atrHere : patternExtreme - STOP_BUFFER_ATR * atrHere;
    const entry = cand.neckline;
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0) continue;
    const height = Math.abs(patternExtreme - cand.neckline);
    const measured = bearish ? entry - height : entry + height;
    const minTarget = bearish ? entry - MIN_RR * risk : entry + MIN_RR * risk;
    const takeProfit = bearish ? Math.min(measured, minTarget) : Math.max(measured, minTarget);
    const spentLevel = bearish
      ? entry - BREAKOUT_MAX_CONSUMED * (entry - measured)
      : entry + BREAKOUT_MAX_CONSUMED * (measured - entry);
    const detectIdx = cand.second.index + SWING_LOOKBACK; // pattern knowable only once the second swing confirmed
    const choch = breaks.find((br) => br.type === "choch" && br.direction === cand.direction && br.index > cand.second.index);

    let confIdx = -1;
    let confirmation: "neckline_break" | "choch" | "engulfing" | null = null;
    let entryIdx = -1;
    let entryPrice = entry;
    let tpUsed = takeProfit;
    let entryKind: "retest" | "breakout" | "engulfing" = "retest";

    // engulfing trigger (outside retest mode): an engulfing reversal candle at
    // the second extreme with the stochastic still there — entered at the close
    // of the bar where both the candle and the pattern were knowable (the
    // second swing confirms SWING_LOOKBACK bars after the extreme)
    if (entryMode !== "retest") {
      const lastE = Math.min(n - 1, cand.second.index + ENGULF_WINDOW_BARS);
      for (let i = cand.second.index + 1; i <= lastE; i++) {
        if (bearish ? candles[i].close > stopLoss : candles[i].close < stopLoss) break;
        if (!isEngulfing(candles[i - 1], candles[i], bearish)) continue;
        const kE = stoch[i];
        const kP = stoch[i - 1];
        const atExtreme =
          (kE !== null && (bearish ? kE >= OVERBOUGHT : kE <= OVERSOLD)) ||
          (kP !== null && (bearish ? kP >= OVERBOUGHT : kP <= OVERSOLD));
        if (!atExtreme) continue;
        const eIdx = Math.max(i, detectIdx);
        if (eIdx >= n) break;
        let deadE = false;
        for (let j = i; j <= eIdx; j++) {
          if (bearish ? candles[j].close > stopLoss : candles[j].close < stopLoss) {
            deadE = true;
            break;
          }
        }
        if (deadE) break;
        const eClose = candles[eIdx].close;
        const eRisk = Math.abs(eClose - stopLoss);
        const eSpent = bearish ? eClose <= spentLevel : eClose >= spentLevel;
        if (eSpent || eRisk <= 0) break;
        confIdx = i;
        confirmation = "engulfing";
        entryIdx = eIdx;
        entryPrice = eClose;
        tpUsed = bearish ? Math.min(measured, eClose - MIN_RR * eRisk) : Math.max(measured, eClose + MIN_RR * eRisk);
        entryKind = "engulfing";
        break;
      }
    }

    if (confirmation !== "engulfing") {
    // confirmation: close through the neckline or a CHoCH in the reversal direction
    const breakMargin = filters.decisiveBreak ? BREAK_MARGIN_ATR * atrHere : 0;
    let dead = false;
    for (let i = cand.second.index + 1; i < n; i++) {
      const c = candles[i];
      if (bearish ? c.close > stopLoss : c.close < stopLoss) {
        dead = true;
        break;
      }
      if (bearish ? c.close < cand.neckline - breakMargin : c.close > cand.neckline + breakMargin) {
        confIdx = i;
        confirmation = "neckline_break";
        break;
      }
      if (choch && choch.index === i) {
        confIdx = i;
        confirmation = "choch";
        break;
      }
    }
    if (dead || confIdx < 0 || confirmation === null) {
      unconfirmed++;
      continue;
    }

    // breakout entry at the confirmation close: only once the pattern was
    // knowable, skipped when the move is already spent (the confirmation close
    // consumed too much of the measured move) or the stochastic sits at the
    // wrong extreme on the confirmation bar; the TP is recomputed from the
    // actual entry (measured move, or min R when nearer)
    const confClose = candles[confIdx].close;
    const ranTooFar = bearish ? confClose <= spentLevel : confClose >= spentLevel;
    const breakoutRisk = Math.abs(confClose - stopLoss);
    const confK = stoch[confIdx];
    const wrongSide = confK !== null && (bearish ? confK <= OVERSOLD : confK >= OVERBOUGHT);
    const useBreakout = entryMode !== "retest" && confIdx >= detectIdx && !ranTooFar && !wrongSide && breakoutRisk > 0;

    if (useBreakout) {
      entryIdx = confIdx;
      entryPrice = confClose;
      tpUsed = bearish ? Math.min(measured, confClose - MIN_RR * breakoutRisk) : Math.max(measured, confClose + MIN_RR * breakoutRisk);
      entryKind = "breakout";
    } else if (entryMode === "breakout") {
      missed++;
      continue;
    } else {
      // armed: wait for the neckline retest (only once the pattern was knowable)
      let noEntry = false;
      for (let i = confIdx + 1; i < n; i++) {
        const c = candles[i];
        if (bearish ? c.close > stopLoss : c.close < stopLoss) {
          noEntry = true;
          break;
        }
        const k = stoch[i];
        const stochGateOk = k !== null && (bearish ? k >= OVERBOUGHT : k <= OVERSOLD);
        if (c.low <= entry && c.high >= entry && stochGateOk && i >= detectIdx) {
          entryIdx = i;
          break;
        }
        if (bearish ? c.low <= takeProfit : c.high >= takeProfit) {
          noEntry = true;
          break;
        }
      }
      if (noEntry || entryIdx < 0) {
        missed++;
        continue;
      }
    }
    }

    // in trade: SL checked before TP (conservative on bars spanning both)
    let exit: { index: number; price: number; reason: "tp" | "sl" } | null = null;
    for (let i = entryIdx + 1; i < n; i++) {
      const c = candles[i];
      if (bearish ? c.high >= stopLoss : c.low <= stopLoss) {
        exit = { index: i, price: stopLoss, reason: "sl" };
        break;
      }
      if (bearish ? c.low <= tpUsed : c.high >= tpUsed) {
        exit = { index: i, price: tpUsed, reason: "tp" };
        break;
      }
    }
    if (!exit) {
      openAtEnd++;
      continue;
    }

    const tradeRisk = Math.abs(entryPrice - stopLoss);
    trades.push({
      pattern: cand.pattern,
      direction: cand.direction,
      secondExtremeTime: cand.second.time,
      confirmation,
      confirmationTime: candles[confIdx].time,
      entryKind,
      entry: entryPrice,
      stopLoss,
      takeProfit: tpUsed,
      entryTime: candles[entryIdx].time,
      exitTime: candles[exit.index].time,
      exitPrice: exit.price,
      exitReason: exit.reason,
      rMultiple: exit.reason === "tp" ? Number((Math.abs(tpUsed - entryPrice) / tradeRisk).toFixed(2)) : -1,
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
    patterns: candidates.length,
    unconfirmed,
    missed,
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

/** A forming stochastic reversal — not actionable yet, worth watching. */
export interface StochReversalWatch {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction | null;
  pattern: "double_top" | "double_bottom" | null;
  state: StochReversalState;
  stateDetail: string;
  neckline: number | null;
  secondExtreme: number | null;
  stochAtSecond: number | null;
  generatedAt: number;
}

export function stochReversalWatchItem(symbol: string, timeframe: Timeframe, setup: StochReversalSetup): StochReversalWatch | null {
  if (setup.state !== "awaiting_confirmation") return null;
  return {
    symbol,
    timeframe,
    direction: setup.direction,
    pattern: setup.pattern,
    state: setup.state,
    stateDetail: setup.stateDetail,
    neckline: setup.neckline,
    secondExtreme: setup.secondExtreme,
    stochAtSecond: setup.stochAtSecond,
    generatedAt: Date.now(),
  };
}

/** Scanner shape for an actionable stochastic reversal setup. */
export function stochReversalOpportunity(symbol: string, timeframe: Timeframe, setup: StochReversalSetup): Opportunity | null {
  if (setup.direction === null || setup.entry === null || setup.stopLoss === null || setup.takeProfit === null) return null;
  if (setup.state !== "armed" && setup.state !== "triggered") return null;
  const risk = Math.abs(setup.entry - setup.stopLoss);
  const bearish = setup.direction === "bearish";
  return {
    symbol,
    timeframe,
    direction: bearish ? "short" : "long",
    score: setup.state === "triggered" ? 85 : 75,
    factors: [
      {
        name: bearish ? "Double top" : "Double bottom",
        detail: `Second ${bearish ? "top" : "bottom"} at ${setup.secondExtreme?.toFixed(2)} vs first at ${setup.firstExtreme?.toFixed(2)}`,
        weight: 25,
      },
      {
        name: "Stochastic extreme",
        detail: `Slow stochastic ${setup.stochAtSecond?.toFixed(0)} (${bearish ? ">= 80 overbought" : "<= 20 oversold"}) at the second ${bearish ? "top" : "bottom"}`,
        weight: 25,
      },
      {
        name: "Reversal confirmation",
        detail:
          setup.confirmation === "choch"
            ? "CHoCH against the prior move"
            : setup.confirmation === "engulfing"
              ? `Engulfing reversal candle at the second ${setup.pattern === "double_top" ? "top" : "bottom"}`
              : `Close through the neckline ${setup.neckline?.toFixed(2)}`,
        weight: 25,
      },
      { name: "Entry", detail: setup.stateDetail, weight: setup.state === "triggered" ? 10 : 0 },
    ],
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskRewardRatio: risk > 0 ? Math.abs(setup.takeProfit - setup.entry) / risk : 0,
    generatedAt: Date.now(),
  };
}
