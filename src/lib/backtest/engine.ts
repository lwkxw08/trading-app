import type { Candle, Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { evaluateCustomStrategy, type CustomStrategy } from "@/lib/strategies/custom";
import { analyze } from "@/lib/strategies/engine";
import type { Opportunity } from "@/lib/strategies/types";

/**
 * Bar-by-bar historical replay: at each bar the deterministic engine only
 * sees candles up to that bar (no lookahead), signals open a simulated trade
 * at the bar close using the same entry/SL/TP logic as the live app, and the
 * trade is walked forward against subsequent highs/lows.
 */

export interface BacktestConfig {
  strategyType: "builtin" | "custom";
  custom: CustomStrategy | null;
  minScore: number; // signal threshold for the built-in confluence score
  direction: "both" | "long" | "short";
  maxHoldBars: number;
  /** Taker fee per side as % of notional (e.g. 0.1 for Binance spot). */
  feePct: number;
  /** Slippage per market-order fill as % of price (entry and stop/time exits; targets fill as limits). */
  slippagePct: number;
}

export interface BacktestTrade {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitTime: number;
  exitPrice: number;
  exitReason: "take_profit" | "stop_loss" | "time_exit" | "end_of_data";
  rMultiple: number;
  returnPct: number;
  score: number;
  holdBars: number;
}

export interface BacktestResult {
  symbol: string;
  timeframe: Timeframe;
  barsTested: number;
  firstBarTime: number;
  lastBarTime: number;
  trades: BacktestTrade[];
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  expectancyR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
  avgHoldBars: number | null;
  equityCurve: { time: number; r: number }[]; // cumulative R after each closed trade
}

const WINDOW = 300; // engine sees at most this many bars at each step
const MIN_HISTORY = 60; // bars required before the first evaluation

interface OpenPosition {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  score: number;
  entryIndex: number;
}

function signalAt(
  symbol: string,
  tf: Timeframe,
  window: Candle[],
  htfWindow: Candle[] | undefined,
  htf: Timeframe | undefined,
  config: BacktestConfig,
  minScore: number,
): Opportunity | null {
  const a = analyze(symbol, tf, window, htfWindow && htfWindow.length >= 50 ? htfWindow : undefined, htf);
  let candidates: Opportunity[];
  if (config.strategyType === "custom" && config.custom) {
    candidates = evaluateCustomStrategy(a, config.custom)
      .filter((e) => e.opportunity !== null)
      .map((e) => e.opportunity as Opportunity);
  } else {
    // No historical macro calendar — backtests score on technicals only.
    candidates = scoreOpportunities(a).filter((o) => o.score >= minScore);
  }
  if (config.direction !== "both") candidates = candidates.filter((o) => o.direction === config.direction);
  return candidates[0] ?? null;
}

function closeTrade(
  pos: OpenPosition,
  rawExitPrice: number,
  exitTime: number,
  exitReason: BacktestTrade["exitReason"],
  exitIndex: number,
  config: BacktestConfig,
): BacktestTrade {
  const sign = pos.direction === "long" ? 1 : -1;
  // Market-like exits (stop/time/end of data) slip against the trader; targets fill as limits.
  const exitPrice =
    exitReason === "take_profit" ? rawExitPrice : rawExitPrice * (1 - (sign * config.slippagePct) / 100);
  const fees = ((pos.entryPrice + exitPrice) * config.feePct) / 100;
  const pnl = sign * (exitPrice - pos.entryPrice) - fees;
  const risk = Math.abs(pos.entryPrice - pos.stopLoss);
  return {
    direction: pos.direction,
    entryTime: pos.entryTime,
    entryPrice: pos.entryPrice,
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    exitTime,
    exitPrice,
    exitReason,
    rMultiple: risk > 0 ? pnl / risk : 0,
    returnPct: (100 * pnl) / pos.entryPrice,
    score: pos.score,
    holdBars: exitIndex - pos.entryIndex,
  };
}

function simulate(
  candles: Candle[],
  config: BacktestConfig,
  minScore: number,
  getSignal: (i: number) => Opportunity | null,
): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  let pos: OpenPosition | null = null;

  const start = Math.min(MIN_HISTORY, candles.length);
  for (let i = start; i < candles.length; i++) {
    const bar = candles[i];

    if (pos) {
      const hitStop = pos.direction === "long" ? bar.low <= pos.stopLoss : bar.high >= pos.stopLoss;
      const hitTarget = pos.direction === "long" ? bar.high >= pos.takeProfit : bar.low <= pos.takeProfit;
      if (hitStop) {
        // Conservative: when a bar touches both stop and target, count the stop.
        trades.push(closeTrade(pos, pos.stopLoss, bar.time, "stop_loss", i, config));
        pos = null;
      } else if (hitTarget) {
        trades.push(closeTrade(pos, pos.takeProfit, bar.time, "take_profit", i, config));
        pos = null;
      } else if (i - pos.entryIndex >= config.maxHoldBars) {
        trades.push(closeTrade(pos, bar.close, bar.time, "time_exit", i, config));
        pos = null;
      }
      continue;
    }

    const signal = getSignal(i);
    if (signal && signal.score >= minScore) {
      const sign = signal.direction === "long" ? 1 : -1;
      pos = {
        direction: signal.direction,
        entryTime: bar.time,
        entryPrice: bar.close * (1 + (sign * config.slippagePct) / 100),
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        score: signal.score,
        entryIndex: i,
      };
    }
  }

  if (pos) {
    const lastBar = candles[candles.length - 1];
    trades.push(closeTrade(pos, lastBar.close, lastBar.time, "end_of_data", candles.length - 1, config));
  }
  return trades;
}

function summarize(symbol: string, tf: Timeframe, candles: Candle[], trades: BacktestTrade[]): BacktestResult {
  const start = Math.min(MIN_HISTORY, candles.length);
  const rs = trades.map((t) => t.rMultiple);
  const wins = trades.filter((t) => t.rMultiple > 0);
  const losses = trades.filter((t) => t.rMultiple <= 0);
  const grossWin = wins.reduce((s, t) => s + t.rMultiple, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.rMultiple, 0));
  const totalR = rs.reduce((s, r) => s + r, 0);

  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  const equityCurve = trades.map((t) => {
    cum += t.rMultiple;
    peak = Math.max(peak, cum);
    maxDd = Math.max(maxDd, peak - cum);
    return { time: t.exitTime, r: Number(cum.toFixed(2)) };
  });

  return {
    symbol,
    timeframe: tf,
    barsTested: Math.max(0, candles.length - start),
    firstBarTime: candles[start]?.time ?? 0,
    lastBarTime: candles[candles.length - 1]?.time ?? 0,
    trades,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (100 * wins.length) / trades.length : null,
    avgR: trades.length > 0 ? totalR / trades.length : null,
    expectancyR: trades.length > 0 ? totalR / trades.length : null,
    totalR: Number(totalR.toFixed(2)),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    maxDrawdownR: Number(maxDd.toFixed(2)),
    avgHoldBars: trades.length > 0 ? trades.reduce((s, t) => s + t.holdBars, 0) / trades.length : null,
    equityCurve,
  };
}

/** Builds a per-bar signal function; must be called with increasing bar indices. */
function makeSignalFn(
  symbol: string,
  tf: Timeframe,
  candles: Candle[],
  htfCandles: Candle[] | undefined,
  htf: Timeframe | undefined,
  config: BacktestConfig,
  minScore: number,
): (i: number) => Opportunity | null {
  let htfEnd = 0;
  return (i: number) => {
    const bar = candles[i];
    const window = candles.slice(Math.max(0, i + 1 - WINDOW), i + 1);
    let htfWindow: Candle[] | undefined;
    if (htfCandles && htfCandles.length > 0) {
      while (htfEnd < htfCandles.length && htfCandles[htfEnd].time <= bar.time) htfEnd++;
      htfWindow = htfCandles.slice(Math.max(0, htfEnd - WINDOW), htfEnd);
    }
    return signalAt(symbol, tf, window, htfWindow, htf, config, minScore);
  };
}

export function runBacktest(
  symbol: string,
  tf: Timeframe,
  candles: Candle[],
  htfCandles: Candle[] | undefined,
  htf: Timeframe | undefined,
  config: BacktestConfig,
): BacktestResult {
  // Custom strategies apply their own minScore inside evaluation.
  const minScore = config.strategyType === "custom" ? 0 : config.minScore;
  const getSignal = makeSignalFn(symbol, tf, candles, htfCandles, htf, config, minScore);
  const trades = simulate(candles, config, minScore, getSignal);
  return summarize(symbol, tf, candles, trades);
}

export interface SweepPoint {
  minScore: number;
  totalTrades: number;
  winRate: number | null;
  expectancyR: number | null;
  totalR: number;
  profitFactor: number | null;
  maxDrawdownR: number;
}

/**
 * Parameter sweep over the built-in confluence min-score threshold. Signals
 * are computed once per bar (at the lowest threshold) and each threshold is
 * then simulated cheaply against the precomputed signals.
 */
export function runBacktestSweep(
  symbol: string,
  tf: Timeframe,
  candles: Candle[],
  htfCandles: Candle[] | undefined,
  htf: Timeframe | undefined,
  config: BacktestConfig,
  thresholds: number[],
): SweepPoint[] {
  const floor = Math.min(...thresholds);
  const getSignal = makeSignalFn(symbol, tf, candles, htfCandles, htf, config, floor);
  const start = Math.min(MIN_HISTORY, candles.length);
  const signals: (Opportunity | null)[] = new Array(candles.length).fill(null);
  for (let i = start; i < candles.length; i++) signals[i] = getSignal(i);

  return thresholds.map((minScore) => {
    const trades = simulate(candles, config, minScore, (i) => signals[i]);
    const r = summarize(symbol, tf, candles, trades);
    return {
      minScore,
      totalTrades: r.totalTrades,
      winRate: r.winRate,
      expectancyR: r.expectancyR,
      totalR: r.totalR,
      profitFactor: r.profitFactor,
      maxDrawdownR: r.maxDrawdownR,
    };
  });
}
