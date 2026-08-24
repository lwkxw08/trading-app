export type PineStrategyKind = "ema_cross" | "rsi_reversal" | "fvg_signals" | "macd_momentum";

export interface PineConfig {
  kind: PineStrategyKind;
  name: string;
  // strategy params
  fastLength?: number;
  slowLength?: number;
  rsiLength?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  // risk params baked into the indicator
  riskPercent?: number;
  atrStopMultiplier?: number;
  rewardMultiple?: number;
}

export const PINE_TEMPLATES: { kind: PineStrategyKind; label: string; description: string }[] = [
  { kind: "ema_cross", label: "EMA Crossover", description: "Buy/sell when fast EMA crosses slow EMA, with trend filter" },
  { kind: "rsi_reversal", label: "RSI Reversal", description: "Buy oversold / sell overbought RSI turns" },
  { kind: "fvg_signals", label: "Fair Value Gap Signals", description: "Marks FVG zones and signals on retests" },
  { kind: "macd_momentum", label: "MACD Momentum", description: "Signals on MACD histogram flips aligned with trend" },
];

/**
 * Generates a complete, compile-ready Pine Script v6 indicator with buy/sell
 * signals, alerts, and an on-chart position-size / SL / TP table. The risk
 * block is shared across all templates so numbers match the web app's risk
 * engine (ATR-based stop, R-multiple target).
 */
export function generatePineScript(cfg: PineConfig): string {
  const riskPercent = cfg.riskPercent ?? 1;
  const atrMult = cfg.atrStopMultiplier ?? 1.5;
  const rewardMult = cfg.rewardMultiple ?? 2;

  return `//@version=6
indicator("${sanitize(cfg.name)}", overlay=true)

// ── Inputs ─────────────────────────────────────────────────────────────
accountSize = input.float(10000, "Account size", minval=1)
riskPct     = input.float(${riskPercent}, "Risk % per trade", minval=0.1, maxval=10, step=0.1)
atrMult     = input.float(${atrMult}, "ATR stop multiplier", minval=0.5, step=0.25)
rewardMult  = input.float(${rewardMult}, "Reward multiple (R)", minval=0.5, step=0.5)
${inputsFor(cfg)}
// ── Signal logic ───────────────────────────────────────────────────────
${signalLogicFor(cfg)}
// ── Risk engine: entry / stop / target / size ──────────────────────────
atrValue = ta.atr(14)
longStop    = close - atrMult * atrValue
longTarget  = close + rewardMult * atrMult * atrValue
shortStop   = close + atrMult * atrValue
shortTarget = close - rewardMult * atrMult * atrValue
riskAmount  = accountSize * riskPct / 100
posSize     = atrValue > 0 ? riskAmount / (atrMult * atrValue) : 0.0

// ── Plots ──────────────────────────────────────────────────────────────
plotshape(buySignal,  title="Buy",  style=shape.triangleup,   location=location.belowbar, color=color.new(color.green, 0), size=size.small, text="BUY")
plotshape(sellSignal, title="Sell", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0),   size=size.small, text="SELL")

var line stopLine = na
var line tgtLine  = na
if buySignal or sellSignal
    line.delete(stopLine)
    line.delete(tgtLine)
    stopPrice = buySignal ? longStop : shortStop
    tgtPrice  = buySignal ? longTarget : shortTarget
    stopLine := line.new(bar_index, stopPrice, bar_index + 20, stopPrice, color=color.red,   style=line.style_dashed, width=1)
    tgtLine  := line.new(bar_index, tgtPrice,  bar_index + 20, tgtPrice,  color=color.green, style=line.style_dashed, width=1)

// ── Position size table ────────────────────────────────────────────────
var table info = table.new(position.top_right, 2, 5, border_width=1)
if barstate.islast
    table.cell(info, 0, 0, "Risk/trade",  text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 0, str.tostring(riskAmount, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 1, "Size (units)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 1, str.tostring(posSize, "#.####"), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 2, "Long SL / TP",  text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 2, str.tostring(longStop, format.mintick) + " / " + str.tostring(longTarget, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 3, "Short SL / TP", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 3, str.tostring(shortStop, format.mintick) + " / " + str.tostring(shortTarget, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))

// ── Alerts ─────────────────────────────────────────────────────────────
alertcondition(buySignal,  title="Buy signal",  message="${sanitize(cfg.name)}: BUY {{ticker}} @ {{close}}")
alertcondition(sellSignal, title="Sell signal", message="${sanitize(cfg.name)}: SELL {{ticker}} @ {{close}}")
`;
}

function inputsFor(cfg: PineConfig): string {
  switch (cfg.kind) {
    case "ema_cross":
      return `fastLen = input.int(${cfg.fastLength ?? 20}, "Fast EMA", minval=2)
slowLen = input.int(${cfg.slowLength ?? 50}, "Slow EMA", minval=3)
`;
    case "rsi_reversal":
      return `rsiLen = input.int(${cfg.rsiLength ?? 14}, "RSI length", minval=2)
osLevel = input.int(${cfg.rsiOversold ?? 30}, "Oversold", minval=1, maxval=50)
obLevel = input.int(${cfg.rsiOverbought ?? 70}, "Overbought", minval=50, maxval=99)
`;
    case "fvg_signals":
      return `minGapAtr = input.float(0.15, "Min gap size (ATR ratio)", minval=0.0, step=0.05)
`;
    case "macd_momentum":
      return `fastLen = input.int(${cfg.fastLength ?? 12}, "MACD fast", minval=2)
slowLen = input.int(${cfg.slowLength ?? 26}, "MACD slow", minval=3)
sigLen  = input.int(9, "MACD signal", minval=2)
trendLen = input.int(200, "Trend EMA", minval=10)
`;
  }
}

function signalLogicFor(cfg: PineConfig): string {
  switch (cfg.kind) {
    case "ema_cross":
      return `fastEma = ta.ema(close, fastLen)
slowEma = ta.ema(close, slowLen)
plot(fastEma, "Fast EMA", color=color.new(color.aqua, 0))
plot(slowEma, "Slow EMA", color=color.new(color.orange, 0))
buySignal  = ta.crossover(fastEma, slowEma)
sellSignal = ta.crossunder(fastEma, slowEma)
`;
    case "rsi_reversal":
      return `rsiVal = ta.rsi(close, rsiLen)
buySignal  = ta.crossover(rsiVal, osLevel)
sellSignal = ta.crossunder(rsiVal, obLevel)
`;
    case "fvg_signals":
      return `atrForGap = ta.atr(14)
bullGap = low > high[2] and (low - high[2]) >= minGapAtr * atrForGap
bearGap = high < low[2] and (low[2] - high) >= minGapAtr * atrForGap
if bullGap
    box.new(bar_index - 1, low, bar_index + 15, high[2], bgcolor=color.new(color.green, 85), border_color=color.new(color.green, 60))
if bearGap
    box.new(bar_index - 1, low[2], bar_index + 15, high, bgcolor=color.new(color.red, 85), border_color=color.new(color.red, 60))
// signal on retest: price returns into the most recent gap zone
var float bullGapTop = na
var float bullGapBot = na
var float bearGapTop = na
var float bearGapBot = na
if bullGap
    bullGapTop := low
    bullGapBot := high[2]
if bearGap
    bearGapTop := low[2]
    bearGapBot := high
buySignal  = not na(bullGapTop) and low <= bullGapTop and close > bullGapBot and close > open
sellSignal = not na(bearGapBot) and high >= bearGapBot and close < bearGapTop and close < open
if buySignal
    bullGapTop := na
if sellSignal
    bearGapBot := na
`;
    case "macd_momentum":
      return `[macdLine, signalLine, hist] = ta.macd(close, fastLen, slowLen, sigLen)
trendEma = ta.ema(close, trendLen)
plot(trendEma, "Trend EMA", color=color.new(color.purple, 0))
buySignal  = ta.crossover(hist, 0) and close > trendEma
sellSignal = ta.crossunder(hist, 0) and close < trendEma
`;
  }
}

function sanitize(name: string): string {
  return name.replace(/["\\\n\r]/g, "").slice(0, 60);
}
