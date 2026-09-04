import { atr } from "@/lib/indicators/core";
import type { Candle, Timeframe } from "@/lib/market/types";
import { computeVolumeProfile } from "./detectors";
import type { Direction, Opportunity } from "./types";

export const POC_AMD_STRATEGY_NAME = "Volume Profile POC Break & Retest";

/**
 * Volume-profile POC accumulation → manipulation → distribution strategy
 * (any symbol/timeframe, mirrored both directions):
 * 1. Consolidation: a tight range of at least MIN_BOX_BARS candles (height
 *    capped in ATRs). The volume profile over the box gives the POC,
 * 2. Manipulation: price leaves the box in ONE direction — the sweep that
 *    takes liquidity beyond the range boundary. The sweep extreme is
 *    tracked while it runs,
 * 3. Distribution: price comes back and CLOSES through the POC against the
 *    manipulation (a wick through that closes back does not count). For a
 *    BUY the manipulation swept BELOW the box and the distribution closes
 *    back ABOVE the POC; mirrored for a SELL,
 * 4. Entry: the pullback to the POC after the distribution break — a limit
 *    at the POC, filled when price tags it within the max wait,
 * 5. SL just beyond the manipulation sweep extreme with an ATR buffer,
 * 6. TP at a risk multiple of the entry→SL distance (2R default, selectable).
 * Confirmation filters (toggleable): decisive POC break margin, a minimum
 * distribution leg (sweep extreme → break close) in ATRs, and a volume surge
 * on the distribution break candle (skipped on feeds without volume).
 */

export type PocAmdState =
  | "forming" // consolidation box in place — no manipulation sweep yet
  | "manipulated" // price swept one side of the box — waiting for the distribution close through the POC
  | "awaiting_pullback" // POC broken by the distribution — waiting for the pullback tag
  | "triggered" // the POC pullback entry was tagged
  | "completed" // the trade played out after entry (TP or SL reached)
  | "invalidated";

export interface PocAmdSetup {
  kind: "poc_amd";
  /** trade direction: bullish = swept below, distributed up through the POC; bearish mirrored */
  direction: Direction | null;
  /** consolidation box */
  boxStartTime: number;
  boxEndTime: number;
  boxHigh: number;
  boxLow: number;
  poc: number;
  /** manipulation sweep extreme (low for a buy, high for a sell), once it exists */
  sweepPrice: number | null;
  sweepTime: number | null;
  /** the candle that CLOSED through the POC against the manipulation */
  breakTime: number | null;
  breakClose: number | null;
  /** TP risk multiple */
  rrTarget: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  state: PocAmdState;
  stateDetail: string;
}

export const DEFAULT_POC_RR_TARGET = 2;
/** the POC pullback must fill promptly after the distribution break */
export const DEFAULT_POC_MAX_PULLBACK_BARS = 20;
export const DEFAULT_MIN_DIST_LEG_ATR = 1.5;
export const DEFAULT_POC_VOL_SURGE_RATIO = 1.2;

const MIN_BOX_BARS = 15; // a consolidation needs enough bars for the profile to mean something
const MAX_BOX_BARS = 80;
const MAX_BOX_RANGE_ATR = 4; // box height cap: it must be a range, not a trend
const SWEEP_MIN_ATR = 0.25; // the manipulation must poke beyond the boundary by this
const MAX_SWEEP_WAIT_BARS = 10; // the sweep must start soon after price leaves the box
const MAX_DIST_WAIT_BARS = 40; // the distribution close through the POC must arrive within this of the sweep
const POC_BREAK_MARGIN_ATR = 0.15; // decisive break: the close must clear the POC by this
const SL_BUFFER_ATR = 0.25; // "just beyond" the sweep extreme
const MAX_BOX_AGE_BARS = 120; // a completed box is only tradeable while reasonably fresh
const VOL_AVG_BARS = 20;

/** Confirmation checks on the distribution break candle (all on by default). */
export interface PocAmdFilters {
  /** the distribution close must clear the POC by an ATR margin, not squeak through */
  decisivePocBreak: boolean;
  /** the distribution leg (sweep extreme → break close) must span at least `minDistLegAtr` ATRs */
  distributionLeg: boolean;
  minDistLegAtr: number;
  /** the break candle's volume must be at least `volSurgeRatio`× the recent average (skipped when the feed has no volume) */
  volumeSurge: boolean;
  volSurgeRatio: number;
}

export const DEFAULT_POC_AMD_FILTERS: PocAmdFilters = {
  decisivePocBreak: true,
  distributionLeg: true,
  minDistLegAtr: DEFAULT_MIN_DIST_LEG_ATR,
  volumeSurge: true,
  volSurgeRatio: DEFAULT_POC_VOL_SURGE_RATIO,
};

interface Box {
  startIdx: number;
  endIdx: number; // last bar INSIDE the box
  high: number;
  low: number;
  poc: number;
}

function atrAt(atr14: (number | null)[], candles: Candle[], i: number): number {
  return atr14[i] ?? candles[i].close * 0.01;
}

/**
 * Non-overlapping consolidation boxes, greedy left-to-right: grow a window
 * while its total range stays within MAX_BOX_RANGE_ATR ATRs; keep it if it
 * reaches MIN_BOX_BARS. The POC comes from the volume profile over the box.
 */
export function findConsolidationBoxes(candles: Candle[], atr14: (number | null)[]): Box[] {
  const boxes: Box[] = [];
  const n = candles.length;
  let i = 0;
  while (i <= n - MIN_BOX_BARS) {
    let hi = candles[i].high;
    let lo = candles[i].low;
    let j = i;
    while (j + 1 < n && j - i + 1 < MAX_BOX_BARS) {
      const nh = Math.max(hi, candles[j + 1].high);
      const nl = Math.min(lo, candles[j + 1].low);
      if (nh - nl > MAX_BOX_RANGE_ATR * atrAt(atr14, candles, j + 1)) break;
      hi = nh;
      lo = nl;
      j++;
    }
    if (j - i + 1 >= MIN_BOX_BARS) {
      const profile = computeVolumeProfile(candles.slice(i, j + 1));
      boxes.push({ startIdx: i, endIdx: j, high: hi, low: lo, poc: profile.poc });
      i = j + 1;
    } else {
      i++;
    }
  }
  return boxes;
}

interface AmdEvent {
  direction: Direction; // bullish = swept below → distribute up
  sweepIdx: number;
  sweepPrice: number;
  breakIdx: number; // distribution candle that closed through the POC
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rejected: string | null;
}

/**
 * Resolve the manipulation sweep and the distribution POC break for a box.
 * Returns the event (possibly filter-rejected), "pending" when the sequence
 * is still in progress at the end of the series, or null when the box never
 * produced a valid sequence.
 */
function resolveAmd(
  candles: Candle[],
  atr14: (number | null)[],
  box: Box,
  rrTarget: number,
  filters: PocAmdFilters,
): AmdEvent | { pending: "sweep" | "distribution"; direction: Direction | null; sweepIdx: number; sweepPrice: number } | null {
  const n = candles.length;
  // manipulation: the first poke beyond a boundary after the box
  let dir: Direction | null = null;
  let sweepIdx = -1;
  for (let i = box.endIdx + 1; i < n && i <= box.endIdx + MAX_SWEEP_WAIT_BARS; i++) {
    const a = atrAt(atr14, candles, i);
    if (candles[i].low < box.low - SWEEP_MIN_ATR * a) {
      dir = "bullish"; // swept below → expect distribution up
      sweepIdx = i;
      break;
    }
    if (candles[i].high > box.high + SWEEP_MIN_ATR * a) {
      dir = "bearish";
      sweepIdx = i;
      break;
    }
  }
  if (dir === null) {
    if (n - 1 - box.endIdx < MAX_SWEEP_WAIT_BARS) return { pending: "sweep", direction: null, sweepIdx: -1, sweepPrice: 0 };
    return null;
  }
  const bullish = dir === "bullish";

  // distribution: track the sweep extreme until a candle CLOSES through the
  // POC against the manipulation
  let sweepPrice = bullish ? candles[sweepIdx].low : candles[sweepIdx].high;
  let breakIdx = -1;
  for (let i = sweepIdx; i < n; i++) {
    if (i - sweepIdx > MAX_DIST_WAIT_BARS) return null;
    const c = candles[i];
    if (bullish ? c.low < sweepPrice : c.high > sweepPrice) {
      sweepPrice = bullish ? c.low : c.high;
    }
    const margin = filters.decisivePocBreak ? POC_BREAK_MARGIN_ATR * atrAt(atr14, candles, i) : 0;
    if (bullish ? c.close > box.poc + margin : c.close < box.poc - margin) {
      breakIdx = i;
      break;
    }
  }
  if (breakIdx < 0) {
    if (n - 1 - sweepIdx < MAX_DIST_WAIT_BARS) return { pending: "distribution", direction: dir, sweepIdx, sweepPrice };
    return null;
  }

  // confirmation filters on the distribution break candle
  let rejected: string | null = null;
  const breakCandle = candles[breakIdx];
  const aBreak = atrAt(atr14, candles, breakIdx);
  if (filters.distributionLeg) {
    const legAtr = Math.abs(breakCandle.close - sweepPrice) / aBreak;
    if (legAtr < filters.minDistLegAtr) {
      rejected = `weak distribution — the leg from the sweep spans ${legAtr.toFixed(1)} ATR, below the ${filters.minDistLegAtr} ATR minimum`;
    }
  }
  if (!rejected && filters.volumeSurge && breakCandle.volume > 0) {
    let sum = 0;
    let cnt = 0;
    for (let i = Math.max(0, breakIdx - VOL_AVG_BARS); i < breakIdx; i++) {
      sum += candles[i].volume;
      cnt++;
    }
    const avg = cnt > 0 ? sum / cnt : 0;
    if (avg > 0 && breakCandle.volume < filters.volSurgeRatio * avg) {
      rejected = "no volume surge on the distribution break";
    }
  }

  const entry = box.poc;
  const stopLoss = bullish ? sweepPrice - SL_BUFFER_ATR * aBreak : sweepPrice + SL_BUFFER_ATR * aBreak;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const takeProfit = bullish ? entry + rrTarget * risk : entry - rrTarget * risk;

  return { direction: dir, sweepIdx, sweepPrice, breakIdx, entry, stopLoss, takeProfit, rejected };
}

export function detectPocAmdSetup(
  candles: Candle[],
  rrTarget: number = DEFAULT_POC_RR_TARGET,
  filters: PocAmdFilters = DEFAULT_POC_AMD_FILTERS,
  maxPullbackBars: number = DEFAULT_POC_MAX_PULLBACK_BARS,
): PocAmdSetup | null {
  const n = candles.length;
  if (n < MIN_BOX_BARS * 2) return null;
  const atr14 = atr(candles, 14);
  const boxes = findConsolidationBoxes(candles, atr14);
  if (boxes.length === 0) return null;

  // most recent box that is still fresh enough to matter
  for (let b = boxes.length - 1; b >= 0; b--) {
    const box = boxes[b];
    if (n - 1 - box.endIdx > MAX_BOX_AGE_BARS + MAX_DIST_WAIT_BARS) break;

    const base = {
      kind: "poc_amd" as const,
      boxStartTime: candles[box.startIdx].time,
      boxEndTime: candles[box.endIdx].time,
      boxHigh: box.high,
      boxLow: box.low,
      poc: box.poc,
      rrTarget,
    };

    const resolved = resolveAmd(candles, atr14, box, rrTarget, filters);
    if (resolved === null) continue;

    if ("pending" in resolved) {
      if (resolved.pending === "sweep") {
        // box may still be extending or the sweep hasn't happened yet
        return {
          ...base,
          direction: null,
          sweepPrice: null,
          sweepTime: null,
          breakTime: null,
          breakClose: null,
          entry: null,
          stopLoss: null,
          takeProfit: null,
          state: "forming",
          stateDetail: `Consolidation with POC at ${box.poc.toFixed(4)} — waiting for the manipulation sweep beyond the range`,
        };
      }
      const bullish = resolved.direction === "bullish";
      return {
        ...base,
        direction: resolved.direction,
        sweepPrice: resolved.sweepPrice,
        sweepTime: candles[resolved.sweepIdx].time,
        breakTime: null,
        breakClose: null,
        entry: null,
        stopLoss: null,
        takeProfit: null,
        state: "manipulated",
        stateDetail: `Manipulation swept ${bullish ? "below" : "above"} the range — waiting for the distribution to CLOSE ${bullish ? "back above" : "back below"} the POC`,
      };
    }

    const bullish = resolved.direction === "bullish";
    if (resolved.rejected) {
      return {
        ...base,
        direction: resolved.direction,
        sweepPrice: resolved.sweepPrice,
        sweepTime: candles[resolved.sweepIdx].time,
        breakTime: candles[resolved.breakIdx].time,
        breakClose: candles[resolved.breakIdx].close,
        entry: null,
        stopLoss: null,
        takeProfit: null,
        state: "invalidated",
        stateDetail: `POC break rejected — ${resolved.rejected}`,
      };
    }

    // walk price action after the distribution break: the POC tag triggers; a
    // close back through the POC (wrong side), a close beyond the sweep, TP
    // without the pullback, or expiry invalidates
    let state: PocAmdState = "awaiting_pullback";
    let stateDetail = `Distribution closed ${bullish ? "above" : "below"} the POC — waiting for the pullback to tag it`;
    for (let i = resolved.breakIdx + 1; i < n; i++) {
      const c = candles[i];
      if (state === "awaiting_pullback") {
        const margin = POC_BREAK_MARGIN_ATR * atrAt(atr14, candles, i);
        if (bullish ? c.close < box.poc - margin : c.close > box.poc + margin) {
          state = "invalidated";
          stateDetail = "Price closed back through the POC before the pullback entry filled";
          break;
        }
        if (i - resolved.breakIdx > maxPullbackBars) {
          state = "invalidated";
          stateDetail = `Pullback took too long — the POC was not tagged within ${maxPullbackBars} candles of the break`;
          break;
        }
        if (bullish ? c.low <= resolved.entry : c.high >= resolved.entry) {
          state = "triggered";
          stateDetail = "Price pulled back to the POC — entry tagged";
          continue;
        }
        if (bullish ? c.high >= resolved.takeProfit : c.low <= resolved.takeProfit) {
          state = "invalidated";
          stateDetail = "Price ran to the target without the pullback — entry missed";
          break;
        }
      } else if (state === "triggered") {
        if (bullish ? c.low <= resolved.stopLoss : c.high >= resolved.stopLoss) {
          state = "completed";
          stateDetail = "Setup played out — stop level was reached after entry";
          break;
        }
        if (bullish ? c.high >= resolved.takeProfit : c.low <= resolved.takeProfit) {
          state = "completed";
          stateDetail = "Setup played out — take profit was reached";
          break;
        }
      }
    }

    return {
      ...base,
      direction: resolved.direction,
      sweepPrice: resolved.sweepPrice,
      sweepTime: candles[resolved.sweepIdx].time,
      breakTime: candles[resolved.breakIdx].time,
      breakClose: candles[resolved.breakIdx].close,
      entry: resolved.entry,
      stopLoss: resolved.stopLoss,
      takeProfit: resolved.takeProfit,
      state,
      stateDetail,
    };
  }
  return null;
}

export interface PocAmdTrade {
  direction: Direction;
  poc: number;
  boxHigh: number;
  boxLow: number;
  sweepPrice: number;
  breakTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rrTarget: number;
  entryTime: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "tp" | "sl";
  rMultiple: number;
}

export interface PocAmdBacktest {
  symbol: string;
  timeframe: Timeframe;
  bars: number;
  /** consolidation boxes found */
  boxes: number;
  /** completed manipulation→distribution sequences (POC broken back through) */
  breaks: number;
  /** sequences rejected by the confirmation filters */
  filtered: number;
  /** confirmed breaks whose POC pullback never filled */
  noFill: number;
  openAtEnd: number;
  trades: PocAmdTrade[];
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
 * Replay the POC accumulation→manipulation→distribution strategy exactly as
 * live detection resolves it. No look-ahead: each box's profile only uses the
 * bars inside the box, the sweep/distribution/pullback all resolve on later
 * bars. One position at a time; a bar spanning both SL and TP counts as a
 * stop (conservative).
 */
export function backtestPocAmd(
  symbol: string,
  timeframe: Timeframe,
  candles: Candle[],
  rrTarget: number = DEFAULT_POC_RR_TARGET,
  filters: PocAmdFilters = DEFAULT_POC_AMD_FILTERS,
  maxPullbackBars: number = DEFAULT_POC_MAX_PULLBACK_BARS,
): PocAmdBacktest {
  const n = candles.length;
  const atr14 = atr(candles, 14);
  const boxes = findConsolidationBoxes(candles, atr14);

  const trades: PocAmdTrade[] = [];
  let breaks = 0;
  let filtered = 0;
  let noFill = 0;
  let openAtEnd = 0;
  let busyUntil = -1;

  for (const box of boxes) {
    const resolved = resolveAmd(candles, atr14, box, rrTarget, filters);
    if (resolved === null || "pending" in resolved) continue;
    breaks++;
    if (resolved.breakIdx <= busyUntil) continue;
    if (resolved.rejected) {
      filtered++;
      continue;
    }
    const bullish = resolved.direction === "bullish";

    // wait for the POC pullback fill
    let entryIdx = -1;
    for (let i = resolved.breakIdx + 1; i < n; i++) {
      const c = candles[i];
      const margin = POC_BREAK_MARGIN_ATR * atrAt(atr14, candles, i);
      if (bullish ? c.close < box.poc - margin : c.close > box.poc + margin) break;
      if (i - resolved.breakIdx > maxPullbackBars) break;
      if (bullish ? c.low <= resolved.entry : c.high >= resolved.entry) {
        entryIdx = i;
        break;
      }
      if (bullish ? c.high >= resolved.takeProfit : c.low <= resolved.takeProfit) break;
    }
    if (entryIdx < 0) {
      noFill++;
      continue;
    }

    // in trade: SL checked before TP (conservative on bars spanning both)
    let exit: { index: number; price: number; reason: "tp" | "sl" } | null = null;
    for (let i = entryIdx; i < n; i++) {
      const c = candles[i];
      if (bullish ? c.low <= resolved.stopLoss : c.high >= resolved.stopLoss) {
        exit = { index: i, price: resolved.stopLoss, reason: "sl" };
        break;
      }
      if (bullish ? c.high >= resolved.takeProfit : c.low <= resolved.takeProfit) {
        exit = { index: i, price: resolved.takeProfit, reason: "tp" };
        break;
      }
    }
    if (!exit) {
      openAtEnd++;
      busyUntil = n;
      continue;
    }

    const risk = Math.abs(resolved.entry - resolved.stopLoss);
    trades.push({
      direction: resolved.direction,
      poc: box.poc,
      boxHigh: box.high,
      boxLow: box.low,
      sweepPrice: resolved.sweepPrice,
      breakTime: candles[resolved.breakIdx].time,
      entry: resolved.entry,
      stopLoss: resolved.stopLoss,
      takeProfit: resolved.takeProfit,
      rrTarget,
      entryTime: candles[entryIdx].time,
      exitTime: candles[exit.index].time,
      exitPrice: exit.price,
      exitReason: exit.reason,
      rMultiple: exit.reason === "tp" ? Number((Math.abs(resolved.takeProfit - resolved.entry) / risk).toFixed(2)) : -1,
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
    boxes: boxes.length,
    breaks,
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

/** A forming POC setup — not actionable yet, worth watching. */
export interface PocAmdWatch {
  symbol: string;
  timeframe: Timeframe;
  direction: Direction | null;
  poc: number;
  state: PocAmdState;
  stateDetail: string;
  generatedAt: number;
}

export function pocAmdWatchItem(symbol: string, timeframe: Timeframe, setup: PocAmdSetup): PocAmdWatch | null {
  if (setup.state !== "forming" && setup.state !== "manipulated") return null;
  return {
    symbol,
    timeframe,
    direction: setup.direction,
    poc: setup.poc,
    state: setup.state,
    stateDetail: setup.stateDetail,
    generatedAt: Date.now(),
  };
}

/** Scanner shape for an actionable POC setup. */
export function pocAmdOpportunity(symbol: string, timeframe: Timeframe, setup: PocAmdSetup): Opportunity | null {
  if (setup.entry === null || setup.stopLoss === null || setup.takeProfit === null || setup.direction === null) return null;
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
        name: bullish ? "Swept below the range, distributed up" : "Swept above the range, distributed down",
        detail: `POC ${setup.poc.toFixed(4)} · sweep ${setup.sweepPrice?.toFixed(4)} · distribution CLOSED ${bullish ? "above" : "below"} the POC`,
        weight: 35,
      },
      {
        name: "POC pullback entry",
        detail: `Entry at the POC · SL beyond the sweep · TP at ${setup.rrTarget}R`,
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
