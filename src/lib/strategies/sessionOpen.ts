import { atr, ema } from "@/lib/indicators/core";
import type { Candle } from "@/lib/market/types";
import { assetClassForSymbol } from "@/lib/market/symbols";
import type { Direction, Opportunity } from "./types";

export const SESSION_OPEN_STRATEGY_NAME = "Session Open Range";

/**
 * Session open range setup:
 * 1. mark the high/low of the first 60 minutes after the session open
 *    (session depends on the instrument: US equities open, London FX open,
 *    daily UTC open for crypto),
 * 2. once the hour completes, determine the session trend from how the first
 *    hour developed (close vs range midpoint, close vs session open) confirmed
 *    by the longer-term trend (fast vs slow EMA),
 * 3. wait for price to touch the trend-side boundary of the opening range,
 * 4. entry at that boundary, SL just outside the opposite boundary,
 *    TP one full range-span from entry.
 */

export type SessionOpenState =
  | "building_range" // inside the first 60 minutes — range still forming
  | "awaiting_touch" // range + direction set, waiting for the boundary touch
  | "triggered" // boundary tagged — trade levels active
  | "invalidated";

export interface SessionSpec {
  /** IANA timezone the session open is defined in */
  tz: string;
  openHour: number;
  openMinute: number;
  /** session length in hours (range window is always the first 1h) */
  durationHours: number;
  /** skip Saturday/Sunday opens */
  weekdaysOnly: boolean;
  label: string;
}

export function sessionSpecFor(symbol: string): SessionSpec {
  const cls = assetClassForSymbol(symbol);
  if (cls === "crypto") {
    return { tz: "UTC", openHour: 0, openMinute: 0, durationHours: 24, weekdaysOnly: false, label: "Daily UTC open" };
  }
  if (cls === "forex") {
    return { tz: "Europe/London", openHour: 8, openMinute: 0, durationHours: 8.5, weekdaysOnly: true, label: "London open" };
  }
  return { tz: "America/New_York", openHour: 9, openMinute: 30, durationHours: 6.5, weekdaysOnly: true, label: "US market open" };
}

/** Minutes the given timezone is ahead of UTC at the given instant. */
function tzOffsetMinutes(tz: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - utcMs) / 60000);
}

/** Unix-seconds open time of the session whose local calendar day contains `utcMs` (may be in the future). */
function sessionOpenOnDay(spec: SessionSpec, utcMs: number): number {
  const offset = tzOffsetMinutes(spec.tz, utcMs);
  const local = new Date(utcMs + offset * 60000);
  // local calendar date at the instant, with the session's open time
  const naiveUtc = Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    spec.openHour,
    spec.openMinute,
    0,
  );
  // convert local wall-clock back to UTC using the offset at (approximately) that instant
  const openOffset = tzOffsetMinutes(spec.tz, naiveUtc - offset * 60000);
  return Math.floor((naiveUtc - openOffset * 60000) / 1000);
}

function isWeekend(spec: SessionSpec, openSec: number): boolean {
  const day = new Intl.DateTimeFormat("en-US", { timeZone: spec.tz, weekday: "short" }).format(new Date(openSec * 1000));
  return day === "Sat" || day === "Sun";
}

/** Most recent session open at or before `nowSec` (weekday sessions only where applicable). */
export function latestSessionOpen(spec: SessionSpec, nowSec: number): number {
  for (let daysBack = 0; daysBack < 7; daysBack++) {
    const open = sessionOpenOnDay(spec, (nowSec - daysBack * 86400) * 1000);
    if (open > nowSec) continue;
    if (spec.weekdaysOnly && isWeekend(spec, open)) continue;
    return open;
  }
  return sessionOpenOnDay(spec, nowSec * 1000) - 86400; // unreachable fallback
}

/** All session opens inside [fromSec, toSec], oldest first. */
export function sessionOpensInRange(spec: SessionSpec, fromSec: number, toSec: number): number[] {
  const opens: number[] = [];
  for (let t = fromSec; t <= toSec + 86400; t += 86400) {
    const open = sessionOpenOnDay(spec, t * 1000);
    if (open < fromSec || open > toSec) continue;
    if (spec.weekdaysOnly && isWeekend(spec, open)) continue;
    if (opens.length === 0 || open > opens[opens.length - 1]) opens.push(open);
  }
  return opens;
}

export interface SessionDirectionSignal {
  name: string;
  detail: string;
  direction: Direction;
}

export interface SessionOpenSetup {
  kind: "session_open";
  session: string;
  sessionOpen: number; // unix seconds
  sessionEnd: number;
  rangeEnd: number; // sessionOpen + 60min
  rangeHigh: number | null;
  rangeLow: number | null;
  /** session trend once determined */
  direction: Direction | null;
  signals: SessionDirectionSignal[];
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  state: SessionOpenState;
  stateDetail: string;
}

const RANGE_SECONDS = 3600;
const EMA_FAST = 50;
const EMA_SLOW = 200;

interface RangeLevels {
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

function rangeLevels(direction: Direction, rangeHigh: number, rangeLow: number, buffer: number): RangeLevels {
  const span = rangeHigh - rangeLow;
  if (direction === "bullish") {
    return { entry: rangeHigh, stopLoss: rangeLow - buffer, takeProfit: rangeHigh + span };
  }
  return { entry: rangeLow, stopLoss: rangeHigh + buffer, takeProfit: rangeLow - span };
}

/**
 * Evaluate the session-open range setup on intraday candles (5m recommended).
 * `nowSec` defaults to the close time of the last candle.
 */
export function detectSessionOpenSetup(symbol: string, candles: Candle[], nowSec?: number): SessionOpenSetup | null {
  if (candles.length < 30) return null;
  const spec = sessionSpecFor(symbol);
  const barSec = candles.length > 1 ? candles[1].time - candles[0].time : 300;
  const now = nowSec ?? candles[candles.length - 1].time + barSec;
  const sessionOpen = latestSessionOpen(spec, now);
  const sessionEnd = sessionOpen + Math.round(spec.durationHours * 3600);
  const rangeEnd = sessionOpen + RANGE_SECONDS;

  const base: Omit<SessionOpenSetup, "state" | "stateDetail"> = {
    kind: "session_open",
    session: spec.label,
    sessionOpen,
    sessionEnd,
    rangeEnd,
    rangeHigh: null,
    rangeLow: null,
    direction: null,
    signals: [],
    entry: null,
    stopLoss: null,
    takeProfit: null,
  };

  if (now >= sessionEnd) {
    return { ...base, state: "invalidated", stateDetail: "Session has ended — next setup forms at the next open" };
  }

  // candles inside the opening hour (bar open times in [sessionOpen, rangeEnd))
  const hourCandles = candles.filter((c) => c.time >= sessionOpen && c.time < rangeEnd);
  if (hourCandles.length === 0) {
    return { ...base, state: "building_range", stateDetail: `Waiting for the first candles after the ${spec.label.toLowerCase()}` };
  }

  const rangeHigh = Math.max(...hourCandles.map((c) => c.high));
  const rangeLow = Math.min(...hourCandles.map((c) => c.low));
  base.rangeHigh = rangeHigh;
  base.rangeLow = rangeLow;

  if (now < rangeEnd) {
    return {
      ...base,
      state: "building_range",
      stateDetail: `Opening hour in progress — range so far ${rangeLow} → ${rangeHigh}`,
    };
  }

  const span = rangeHigh - rangeLow;
  if (span <= 0) {
    return { ...base, state: "invalidated", stateDetail: "Opening hour produced no usable range" };
  }

  // ---- direction: first-hour development + longer-term trend confirmation ----
  const hourOpen = hourCandles[0].open;
  const hourClose = hourCandles[hourCandles.length - 1].close;
  const mid = (rangeHigh + rangeLow) / 2;

  const posSignal: Direction = hourClose > mid ? "bullish" : "bearish";
  const devSignal: Direction = hourClose > hourOpen ? "bullish" : "bearish";

  const hourEndIdx = candles.findIndex((c) => c.time >= rangeEnd);
  const trendIdx = hourEndIdx > 0 ? hourEndIdx - 1 : candles.length - 1;
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, EMA_FAST)[trendIdx];
  const slow = ema(closes, EMA_SLOW)[trendIdx];
  const trendSignal: Direction | null = fast !== null && slow !== null ? (fast > slow ? "bullish" : "bearish") : null;

  base.signals = [
    {
      name: "First-hour close in range",
      detail: `Closed in the ${posSignal === "bullish" ? "upper" : "lower"} half of the opening range`,
      direction: posSignal,
    },
    {
      name: "First-hour development",
      detail: `Hour closed ${devSignal === "bullish" ? "above" : "below"} the session open`,
      direction: devSignal,
    },
    ...(trendSignal !== null
      ? [
          {
            name: "Longer-term trend",
            detail: `EMA${EMA_FAST} ${trendSignal === "bullish" ? "above" : "below"} EMA${EMA_SLOW}`,
            direction: trendSignal,
          },
        ]
      : []),
  ];

  if (posSignal !== devSignal) {
    return { ...base, state: "invalidated", stateDetail: "First-hour signals conflict — no clear session trend" };
  }
  if (trendSignal !== null && trendSignal !== posSignal) {
    return { ...base, state: "invalidated", stateDetail: "First-hour bias conflicts with the longer-term trend" };
  }

  const direction = posSignal;
  base.direction = direction;

  const atrArr = atr(candles, 14);
  const atrNow = atrArr[trendIdx] ?? 0;
  const buffer = Math.max(0.1 * atrNow, 0.05 * span);
  const levels = rangeLevels(direction, rangeHigh, rangeLow, buffer);
  base.entry = levels.entry;
  base.stopLoss = levels.stopLoss;
  base.takeProfit = levels.takeProfit;

  // walk price after the opening hour: boundary touch triggers; a stop-side
  // violation before the touch invalidates
  const isLong = direction === "bullish";
  let state: SessionOpenState = "awaiting_touch";
  let stateDetail = `Waiting for price to touch the range ${isLong ? "high" : "low"} (${levels.entry})`;
  for (const c of candles) {
    if (c.time < rangeEnd || c.time >= sessionEnd) continue;
    const hitStop = isLong ? c.low <= levels.stopLoss : c.high >= levels.stopLoss;
    const touched = isLong ? c.high >= levels.entry : c.low <= levels.entry;
    if (state === "awaiting_touch") {
      if (hitStop && !touched) {
        state = "invalidated";
        stateDetail = "Price broke the opposite boundary before the entry touch";
        break;
      }
      if (touched) {
        state = "triggered";
        stateDetail = `Price tagged the range ${isLong ? "high" : "low"} — entry level touched`;
      }
    }
  }

  return { ...base, state, stateDetail };
}

/** A forming session-open setup — range building or direction not yet actionable. */
export interface SessionOpenWatch {
  symbol: string;
  session: string;
  state: SessionOpenState;
  stateDetail: string;
  rangeHigh: number | null;
  rangeLow: number | null;
  generatedAt: number;
}

export function sessionOpenWatchItem(symbol: string, setup: SessionOpenSetup): SessionOpenWatch | null {
  if (setup.state !== "building_range") return null;
  return {
    symbol,
    session: setup.session,
    state: setup.state,
    stateDetail: setup.stateDetail,
    rangeHigh: setup.rangeHigh,
    rangeLow: setup.rangeLow,
    generatedAt: Date.now(),
  };
}

export interface SessionOpenTrade {
  sessionOpen: number;
  direction: Direction;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  entryTime: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "tp" | "sl" | "session_end";
  rMultiple: number;
}

export interface SessionOpenBacktest {
  symbol: string;
  session: string;
  sessions: number;
  noDirection: number;
  noTouch: number;
  trades: SessionOpenTrade[];
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
 * Replay the session-open range strategy over historical intraday candles
 * (5m recommended). Each session is evaluated exactly as live detection would:
 * opening-hour range, direction at hour end (no look-ahead — EMAs use only
 * prior data), boundary-touch entry, SL just outside the opposite boundary,
 * TP one range-span away, session-end close if neither is hit.
 */
export function backtestSessionOpen(symbol: string, candles: Candle[]): SessionOpenBacktest {
  const spec = sessionSpecFor(symbol);
  const closes = candles.map((c) => c.close);
  const fastArr = ema(closes, EMA_FAST);
  const slowArr = ema(closes, EMA_SLOW);
  const atrArr = atr(candles, 14);

  const first = candles[0]?.time ?? 0;
  const lastTime = candles[candles.length - 1]?.time ?? 0;
  const opens = sessionOpensInRange(spec, first, lastTime);

  const trades: SessionOpenTrade[] = [];
  let sessions = 0;
  let noDirection = 0;
  let noTouch = 0;

  for (const sessionOpen of opens) {
    const sessionEnd = sessionOpen + Math.round(spec.durationHours * 3600);
    const rangeEnd = sessionOpen + RANGE_SECONDS;
    if (sessionEnd > lastTime) continue; // only fully-elapsed sessions

    const hourCandles = candles.filter((c) => c.time >= sessionOpen && c.time < rangeEnd);
    if (hourCandles.length < 3) continue;
    sessions++;

    const rangeHigh = Math.max(...hourCandles.map((c) => c.high));
    const rangeLow = Math.min(...hourCandles.map((c) => c.low));
    const span = rangeHigh - rangeLow;
    if (span <= 0) {
      noDirection++;
      continue;
    }

    const hourOpen = hourCandles[0].open;
    const hourClose = hourCandles[hourCandles.length - 1].close;
    const mid = (rangeHigh + rangeLow) / 2;
    const posSignal: Direction = hourClose > mid ? "bullish" : "bearish";
    const devSignal: Direction = hourClose > hourOpen ? "bullish" : "bearish";
    const hourEndIdx = candles.findIndex((c) => c.time >= rangeEnd);
    const trendIdx = hourEndIdx > 0 ? hourEndIdx - 1 : -1;
    const fast = trendIdx >= 0 ? fastArr[trendIdx] : null;
    const slow = trendIdx >= 0 ? slowArr[trendIdx] : null;
    const trendSignal: Direction | null = fast !== null && slow !== null ? (fast > slow ? "bullish" : "bearish") : null;

    if (posSignal !== devSignal || (trendSignal !== null && trendSignal !== posSignal)) {
      noDirection++;
      continue;
    }
    const direction = posSignal;
    const isLong = direction === "bullish";
    const atrNow = (trendIdx >= 0 ? atrArr[trendIdx] : null) ?? 0;
    const buffer = Math.max(0.1 * atrNow, 0.05 * span);
    const levels = rangeLevels(direction, rangeHigh, rangeLow, buffer);
    const risk = Math.abs(levels.entry - levels.stopLoss);
    if (risk <= 0) {
      noDirection++;
      continue;
    }

    // walk the session after the opening hour
    let entered = false;
    let entryTime = 0;
    let invalid = false;
    let trade: SessionOpenTrade | null = null;
    let lastSessionCandle: Candle | null = null;
    for (const c of candles) {
      if (c.time < rangeEnd || c.time >= sessionEnd) continue;
      lastSessionCandle = c;
      const hitStop = isLong ? c.low <= levels.stopLoss : c.high >= levels.stopLoss;
      const touched = isLong ? c.high >= levels.entry : c.low <= levels.entry;
      const hitTp = isLong ? c.high >= levels.takeProfit : c.low <= levels.takeProfit;
      if (!entered) {
        if (hitStop && !touched) {
          invalid = true;
          break;
        }
        if (touched) {
          entered = true;
          entryTime = c.time;
        } else continue;
      }
      if (entered) {
        // conservative: a bar that spans both SL and TP counts as a stop
        if (hitStop) {
          trade = {
            sessionOpen,
            direction,
            entry: levels.entry,
            stopLoss: levels.stopLoss,
            takeProfit: levels.takeProfit,
            entryTime,
            exitTime: c.time,
            exitPrice: levels.stopLoss,
            exitReason: "sl",
            rMultiple: -1,
          };
          break;
        }
        if (hitTp) {
          trade = {
            sessionOpen,
            direction,
            entry: levels.entry,
            stopLoss: levels.stopLoss,
            takeProfit: levels.takeProfit,
            entryTime,
            exitTime: c.time,
            exitPrice: levels.takeProfit,
            exitReason: "tp",
            rMultiple: span / risk,
          };
          break;
        }
      }
    }
    if (invalid) {
      noDirection++;
      continue;
    }
    if (!entered) {
      noTouch++;
      continue;
    }
    if (!trade && lastSessionCandle) {
      // session ended in-trade: exit at the last session close
      const exitPrice = lastSessionCandle.close;
      const pnl = isLong ? exitPrice - levels.entry : levels.entry - exitPrice;
      trade = {
        sessionOpen,
        direction,
        entry: levels.entry,
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        entryTime,
        exitTime: lastSessionCandle.time,
        exitPrice,
        exitReason: "session_end",
        rMultiple: pnl / risk,
      };
    }
    if (trade) trades.push(trade);
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
    session: spec.label,
    sessions,
    noDirection,
    noTouch,
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

/** Scanner shape for an actionable (range + direction set) session-open setup. */
export function sessionOpenOpportunity(symbol: string, setup: SessionOpenSetup): Opportunity | null {
  if (setup.entry === null || setup.stopLoss === null || setup.takeProfit === null || setup.direction === null) return null;
  if (setup.state !== "awaiting_touch" && setup.state !== "triggered") return null;
  const risk = Math.abs(setup.entry - setup.stopLoss);
  const reward = Math.abs(setup.takeProfit - setup.entry);
  return {
    symbol,
    timeframe: "5m",
    direction: setup.direction === "bullish" ? "long" : "short",
    score: setup.state === "triggered" ? 85 : 70,
    factors: [
      {
        name: "Opening range",
        detail: `${setup.session}: first-hour range ${setup.rangeLow} → ${setup.rangeHigh}`,
        weight: 35,
      },
      ...setup.signals.map((s) => ({ name: s.name, detail: s.detail, weight: 10 })),
      { name: "Boundary touch", detail: setup.stateDetail, weight: setup.state === "triggered" ? 25 : 10 },
    ],
    entry: setup.entry,
    stopLoss: setup.stopLoss,
    takeProfit: setup.takeProfit,
    riskRewardRatio: risk > 0 ? Number((reward / risk).toFixed(2)) : 1,
    generatedAt: Date.now(),
  };
}
