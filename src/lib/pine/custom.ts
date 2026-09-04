import type { CustomStrategy } from "@/lib/strategies/custom";
import { CONDITION_LIBRARY } from "@/lib/strategies/custom";

/**
 * Generates a Pine Script v6 indicator for a user-composed custom strategy.
 * Each supported condition becomes a boolean series with the user's weight;
 * a signal fires when the weighted score crosses the strategy's minimum.
 * Conditions with no sound Pine equivalent (volume profile, order blocks)
 * are skipped and listed in the header comment.
 */
export function generateCustomPineScript(strategy: CustomStrategy): string {
  const supported = strategy.conditions.filter((c) => CONDITION_LIBRARY.find((m) => m.id === c.id)?.pineSupported);
  const skipped = strategy.conditions.filter((c) => !CONDITION_LIBRARY.find((m) => m.id === c.id)?.pineSupported);
  const totalWeight = supported.reduce((s, c) => s + Math.max(0, c.weight), 0);

  const blocks: string[] = [];
  const longTerms: string[] = [];
  const shortTerms: string[] = [];

  for (const cond of supported) {
    const w = Math.max(0, cond.weight);
    switch (cond.id) {
      case "fvg_retest":
        blocks.push(`// Fair Value Gap retest (weight ${w})
atrGap = ta.atr(14)
bullGap = low > high[2] and (low - high[2]) >= 0.15 * atrGap
bearGap = high < low[2] and (low[2] - high) >= 0.15 * atrGap
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
fvgLong  = not na(bullGapTop) and low <= bullGapTop and close > bullGapBot
fvgShort = not na(bearGapBot) and high >= bearGapBot and close < bearGapTop`);
        longTerms.push(`(fvgLong ? ${w} : 0)`);
        shortTerms.push(`(fvgShort ? ${w} : 0)`);
        break;
      case "liquidity_sweep":
        blocks.push(`// Liquidity sweep (weight ${w})
pivLow  = ta.pivotlow(low, 5, 5)
pivHigh = ta.pivothigh(high, 5, 5)
var float lastPivLow = na
var float lastPivHigh = na
if not na(pivLow)
    lastPivLow := pivLow
if not na(pivHigh)
    lastPivHigh := pivHigh
sweepLong  = not na(lastPivLow) and low < lastPivLow and close > lastPivLow
sweepShort = not na(lastPivHigh) and high > lastPivHigh and close < lastPivHigh`);
        longTerms.push(`(sweepLong ? ${w} : 0)`);
        shortTerms.push(`(sweepShort ? ${w} : 0)`);
        break;
      case "bos":
      case "choch":
        if (!blocks.some((b) => b.startsWith("// Market structure"))) {
          blocks.push(`// Market structure: BOS / CHoCH (weight ${w})
msPivLow  = ta.pivotlow(low, 5, 5)
msPivHigh = ta.pivothigh(high, 5, 5)
var float msLastLow = na
var float msLastHigh = na
var int structBias = 0 // 1 bullish, -1 bearish
if not na(msPivLow)
    msLastLow := msPivLow
if not na(msPivHigh)
    msLastHigh := msPivHigh
brokeUp   = not na(msLastHigh) and ta.crossover(close, msLastHigh)
brokeDown = not na(msLastLow) and ta.crossunder(close, msLastLow)
bosLong    = brokeUp and structBias >= 0
chochLong  = brokeUp and structBias < 0
bosShort   = brokeDown and structBias <= 0
chochShort = brokeDown and structBias > 0
if brokeUp
    structBias := 1
    msLastHigh := na
if brokeDown
    structBias := -1
    msLastLow := na`);
        }
        if (cond.id === "bos") {
          longTerms.push(`(bosLong ? ${w} : 0)`);
          shortTerms.push(`(bosShort ? ${w} : 0)`);
        } else {
          longTerms.push(`(chochLong ? ${w} : 0)`);
          shortTerms.push(`(chochShort ? ${w} : 0)`);
        }
        break;
      case "anchored_vwap":
        blocks.push(`// Anchored VWAP from last confirmed pivot low/high (weight ${w})
avPivLow  = ta.pivotlow(low, 5, 5)
avPivHigh = ta.pivothigh(high, 5, 5)
var float avCumPvLong = 0.0
var float avCumVLong = 0.0
var float avCumPvShort = 0.0
var float avCumVShort = 0.0
typical = hlc3
if not na(avPivLow)
    avCumPvLong := 0.0
    avCumVLong := 0.0
if not na(avPivHigh)
    avCumPvShort := 0.0
    avCumVShort := 0.0
avCumPvLong += typical * volume
avCumVLong += volume
avCumPvShort += typical * volume
avCumVShort += volume
avwapLong  = avCumVLong > 0 ? avCumPvLong / avCumVLong : typical
avwapShort = avCumVShort > 0 ? avCumPvShort / avCumVShort : typical
plot(avwapLong, "AVWAP (swing low)", color=color.new(color.purple, 40))
vwapCondLong  = close > avwapLong
vwapCondShort = close < avwapShort`);
        longTerms.push(`(vwapCondLong ? ${w} : 0)`);
        shortTerms.push(`(vwapCondShort ? ${w} : 0)`);
        break;
      case "session_level":
        blocks.push(`// Session level reaction: prior Asia/London/NY highs and lows, UTC (weight ${w})
sessAtr = ta.atr(14)
inAsia   = hour(time, "UTC") >= 0 and hour(time, "UTC") < 8
inLondon = hour(time, "UTC") >= 7 and hour(time, "UTC") < 16
inNY     = hour(time, "UTC") >= 13 and hour(time, "UTC") < 21
var float asiaH = na
var float asiaL = na
var float lonH = na
var float lonL = na
var float nyH = na
var float nyL = na
if inAsia and not inAsia[1]
    asiaH := high
    asiaL := low
else if inAsia
    asiaH := math.max(asiaH, high)
    asiaL := math.min(asiaL, low)
if inLondon and not inLondon[1]
    lonH := high
    lonL := low
else if inLondon
    lonH := math.max(lonH, high)
    lonL := math.min(lonL, low)
if inNY and not inNY[1]
    nyH := high
    nyL := low
else if inNY
    nyH := math.max(nyH, high)
    nyL := math.min(nyL, low)
nearLevel(lvl) => not na(lvl) and math.abs(close - lvl) <= 0.5 * sessAtr
sessLong  = nearLevel(asiaL) or nearLevel(lonL) or nearLevel(nyL)
sessShort = nearLevel(asiaH) or nearLevel(lonH) or nearLevel(nyH)`);
        longTerms.push(`(sessLong ? ${w} : 0)`);
        shortTerms.push(`(sessShort ? ${w} : 0)`);
        break;
      case "trend_alignment":
        blocks.push(`// Trend alignment via EMA20/50 (weight ${w})
trendFast = ta.ema(close, 20)
trendSlow = ta.ema(close, 50)
trendLong  = close > trendFast and trendFast > trendSlow
trendShort = close < trendFast and trendFast < trendSlow`);
        longTerms.push(`(trendLong ? ${w} : 0)`);
        shortTerms.push(`(trendShort ? ${w} : 0)`);
        break;
      case "htf_alignment":
        blocks.push(`// Higher-timeframe trend alignment (weight ${w})
htfTf = input.timeframe("240", "Higher timeframe")
[htfFast, htfSlow, htfClose] = request.security(syminfo.tickerid, htfTf, [ta.ema(close, 20), ta.ema(close, 50), close], lookahead=barmerge.lookahead_off)
htfLong  = htfClose > htfFast and htfFast > htfSlow
htfShort = htfClose < htfFast and htfFast < htfSlow`);
        longTerms.push(`(htfLong ? ${w} : 0)`);
        shortTerms.push(`(htfShort ? ${w} : 0)`);
        break;
      case "rsi_extreme":
        blocks.push(`// RSI extreme (weight ${w})
rsiVal = ta.rsi(close, 14)
rsiLong  = rsiVal < 35
rsiShort = rsiVal > 65`);
        longTerms.push(`(rsiLong ? ${w} : 0)`);
        shortTerms.push(`(rsiShort ? ${w} : 0)`);
        break;
      case "macd_momentum":
        blocks.push(`// MACD momentum (weight ${w})
[macdLine, macdSig, macdHist] = ta.macd(close, 12, 26, 9)
macdLong  = macdHist > 0
macdShort = macdHist < 0`);
        longTerms.push(`(macdLong ? ${w} : 0)`);
        shortTerms.push(`(macdShort ? ${w} : 0)`);
        break;
    }
  }

  const skippedNote = skipped.length > 0
    ? `// Note: not representable in Pine and excluded from this indicator:\n${skipped.map((c) => `//   - ${CONDITION_LIBRARY.find((m) => m.id === c.id)?.label ?? c.id}`).join("\n")}\n`
    : "";

  return `//@version=6
indicator("${sanitize(strategy.name)}", overlay=true)
// Custom strategy generated by TradeIntel — weighted confluence of:
${supported.map((c) => `//   - ${CONDITION_LIBRARY.find((m) => m.id === c.id)?.label ?? c.id} (weight ${c.weight})`).join("\n")}
${skippedNote}
// ── Inputs ─────────────────────────────────────────────────────────────
accountSize = input.float(10000, "Account size", minval=1)
riskPct     = input.float(1, "Risk % per trade", minval=0.1, maxval=10, step=0.1)
atrMult     = input.float(1.5, "ATR stop multiplier", minval=0.5, step=0.25)
rewardMult  = input.float(2, "Reward multiple (R)", minval=0.5, step=0.5)
minScore    = input.float(${strategy.minScore}, "Min score % to signal", minval=0, maxval=100)

// ── Conditions ─────────────────────────────────────────────────────────
${blocks.join("\n\n")}

// ── Weighted scoring ───────────────────────────────────────────────────
totalWeight = ${totalWeight}.0
longScore  = 100.0 * (${longTerms.length > 0 ? longTerms.join(" + ") : "0"}) / totalWeight
shortScore = 100.0 * (${shortTerms.length > 0 ? shortTerms.join(" + ") : "0"}) / totalWeight
longOk  = longScore >= minScore
shortOk = shortScore >= minScore
buySignal  = longOk and not longOk[1]
sellSignal = shortOk and not shortOk[1]

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

var table info = table.new(position.top_right, 2, 4, border_width=1)
if barstate.islast
    table.cell(info, 0, 0, "Long score",  text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 0, str.tostring(longScore, "#.#") + "%", text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 1, "Short score", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 1, str.tostring(shortScore, "#.#") + "%", text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 2, "Risk/trade",  text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 2, str.tostring(riskAmount, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 3, "Size (units)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 3, str.tostring(posSize, "#.####"), text_color=color.white, bgcolor=color.new(color.gray, 60))

// ── Alerts ─────────────────────────────────────────────────────────────
alertcondition(buySignal,  title="Buy signal",  message="${sanitize(strategy.name)}: BUY {{ticker}} @ {{close}}")
alertcondition(sellSignal, title="Sell signal", message="${sanitize(strategy.name)}: SELL {{ticker}} @ {{close}}")
`;
}

function sanitize(name: string): string {
  return name.replace(/["\\\n\r]/g, "").slice(0, 60);
}
