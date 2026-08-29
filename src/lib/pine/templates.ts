export type PineStrategyKind = "ema_cross" | "rsi_reversal" | "fvg_signals" | "macd_momentum" | "trend_break" | "stoch_reversal";

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
  {
    kind: "trend_break",
    label: "15m Trend Break → 1m FVG",
    description: "Run on a 1m chart: 15m trend break + CHoCH, then 1m CHoCH → FVG midpoint entry, swing SL, 3R TP",
  },
  {
    kind: "stoch_reversal",
    label: "Stochastic Double Top/Bottom",
    description: "Double top/bottom with stochastic 80+/20-, neckline-break confirmation, retest entry, SL beyond the extreme, measured-move TP",
  },
];

/**
 * Generates a complete, compile-ready Pine Script v6 indicator with buy/sell
 * signals, alerts, and an on-chart position-size / SL / TP table. The risk
 * block is shared across all templates so numbers match the web app's risk
 * engine (ATR-based stop, R-multiple target).
 */
export function generatePineScript(cfg: PineConfig): string {
  if (cfg.kind === "trend_break") return trendBreakPineScript(cfg);
  if (cfg.kind === "stoch_reversal") return stochReversalPineScript(cfg);
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

/**
 * Dedicated multi-timeframe indicator mirroring the app's "15m Trend Break →
 * 1m FVG" detector: the 15m context (≥2 BoS run, trendline through the higher
 * lows / lower highs, trendline break + CHoCH) arms a 1m state machine (first
 * CHoCH → first FVG in its direction → midpoint pullback entry) with the SL
 * beyond the recent 1m swing and the TP at an R-multiple of risk.
 * Run it on a 1m chart; the 15m leg is pulled via request.security.
 */
function trendBreakPineScript(cfg: PineConfig): string {
  const riskPercent = cfg.riskPercent ?? 1;
  const rewardMult = cfg.rewardMultiple ?? 3;

  return `//@version=6
indicator("${sanitize(cfg.name)}", overlay=true, max_lines_count=500, max_boxes_count=500)

// Run this indicator on a 1m chart. The 15m context confirms on the close of
// each 15m bar (no lookahead), then the 1m leg looks for the first CHoCH, the
// first FVG in its direction, and signals on the pullback to the FVG midpoint.

// ── Inputs ─────────────────────────────────────────────────────────────
accountSize = input.float(10000, "Account size", minval=1)
riskPct     = input.float(${riskPercent}, "Risk % per trade", minval=0.1, maxval=10, step=0.1)
rewardMult  = input.float(${rewardMult}, "Reward multiple (R)", minval=0.5, step=0.5)
htfTf       = input.timeframe("15", "Context timeframe")
minBos      = input.int(2, "Min BoS in the prior 15m trend", minval=1)
minGapAtr   = input.float(0.15, "Min FVG size (ATR ratio)", minval=0.0, step=0.05)
slBufAtr    = input.float(0.1, "SL buffer beyond swing (ATR ratio)", minval=0.0, step=0.05)

// ── Structure tracking: swings, BoS/CHoCH, trendline break ─────────────
// Returns [chochDir, setupDir]: chochDir = ±1 on the bar a CHoCH confirms,
// setupDir = ±1 on the bar the full context confirms (≥minBos BoS run, then
// a close through the trendline and a CHoCH in the new direction).
structureCtx() =>
    ph = ta.pivothigh(high, 5, 5)
    pl = ta.pivotlow(low, 5, 5)
    // structure levels (consumed when broken)
    var float lastHigh = na
    var float lastLow  = na
    // trendline anchors (kept across breaks)
    var float tlLow1  = na
    var float tlLow2  = na
    var int   tlLow1Bar = na
    var int   tlLow2Bar = na
    var float tlHigh1 = na
    var float tlHigh2 = na
    var int   tlHigh1Bar = na
    var int   tlHigh2Bar = na
    if not na(ph)
        lastHigh := ph
        tlHigh1 := tlHigh2
        tlHigh1Bar := tlHigh2Bar
        tlHigh2 := ph
        tlHigh2Bar := bar_index - 5
    if not na(pl)
        lastLow := pl
        tlLow1 := tlLow2
        tlLow1Bar := tlLow2Bar
        tlLow2 := pl
        tlLow2Bar := bar_index - 5
    // trendline through the last two ascending lows / descending highs
    float bullTl = na
    if not na(tlLow1) and not na(tlLow2) and tlLow2 > tlLow1
        bullTl := tlLow2 + (tlLow2 - tlLow1) / (tlLow2Bar - tlLow1Bar) * (bar_index - tlLow2Bar)
    float bearTl = na
    if not na(tlHigh1) and not na(tlHigh2) and tlHigh2 < tlHigh1
        bearTl := tlHigh2 + (tlHigh2 - tlHigh1) / (tlHigh2Bar - tlHigh1Bar) * (bar_index - tlHigh2Bar)
    // BoS / CHoCH bookkeeping
    var int trend = 0
    var int bosCount = 0
    var bool pendingBear = false
    var bool pendingBull = false
    int chochDir = 0
    // a close through the trendline against an established run arms the setup
    if trend == 1 and bosCount >= minBos and not na(bullTl) and close < bullTl
        pendingBear := true
    if trend == -1 and bosCount >= minBos and not na(bearTl) and close > bearTl
        pendingBull := true
    if not na(lastHigh) and close > lastHigh
        if trend == -1
            chochDir := 1
            bosCount := 0
        else
            bosCount := bosCount + 1
        trend := 1
        lastHigh := na
    if not na(lastLow) and close < lastLow
        if trend == 1
            chochDir := -1
            bosCount := 0
        else
            bosCount := bosCount + 1
        trend := -1
        lastLow := na
    int setupDir = 0
    if chochDir == -1 and pendingBear
        setupDir := -1
    if chochDir == 1 and pendingBull
        setupDir := 1
    if chochDir != 0
        pendingBear := false
        pendingBull := false
    [chochDir, setupDir]

// 15m context leg (confirms on 15m close)
[htfChoch, htfSetupDir] = request.security(syminfo.tickerid, htfTf, structureCtx(), gaps=barmerge.gaps_off, lookahead=barmerge.lookahead_off)

// 1m execution leg
[ltfChoch, ltfSetupDir] = structureCtx()

atr1 = ta.atr(14)
pl1 = ta.pivotlow(low, 5, 5)
ph1 = ta.pivothigh(high, 5, 5)
var float lastSwingLow = na
var float lastSwingHigh = na
if not na(pl1)
    lastSwingLow := pl1
if not na(ph1)
    lastSwingHigh := ph1
lowest20 = ta.lowest(low, 20)
highest20 = ta.highest(high, 20)

// ── Setup state machine ────────────────────────────────────────────────
// 0 idle · 1 awaiting 1m CHoCH · 2 awaiting FVG · 3 awaiting pullback · 4 triggered
var int state = 0
var int dir = 0
var float entry = na
var float sl = na
var float tp = na
var float fvgTop = na
var float fvgBot = na

newSetup = htfSetupDir != 0 and htfSetupDir[1] == 0
if newSetup
    state := 1
    dir := htfSetupDir
    entry := na
    sl := na
    tp := na
    fvgTop := na
    fvgBot := na

if state == 1 and ltfChoch == dir
    state := 2

bullFvg = low > high[2] and (low - high[2]) >= minGapAtr * atr1
bearFvg = high < low[2] and (low[2] - high) >= minGapAtr * atr1
if state == 2 and ((dir == 1 and bullFvg) or (dir == -1 and bearFvg))
    fvgTop := dir == 1 ? low : low[2]
    fvgBot := dir == 1 ? high[2] : high
    entry := (fvgTop + fvgBot) / 2
    float swingBase = dir == 1 ? (na(lastSwingLow) ? lowest20 : lastSwingLow) : (na(lastSwingHigh) ? highest20 : lastSwingHigh)
    sl := dir == 1 ? swingBase - slBufAtr * atr1 : swingBase + slBufAtr * atr1
    tp := entry + dir * rewardMult * math.abs(entry - sl)
    state := 3
    box.new(bar_index - 1, fvgTop, bar_index + 40, fvgBot, bgcolor=color.new(dir == 1 ? color.green : color.red, 85), border_color=color.new(dir == 1 ? color.green : color.red, 60))
    line.new(bar_index, entry, bar_index + 40, entry, color=color.new(color.blue, 0), style=line.style_dashed, width=1)
    line.new(bar_index, sl, bar_index + 40, sl, color=color.new(color.red, 0), style=line.style_dashed, width=1)
    line.new(bar_index, tp, bar_index + 40, tp, color=color.new(color.green, 0), style=line.style_dashed, width=1)

// invalidation first (matches the app): SL side violated or close through the FVG
bool invalidated = false
if state == 3
    invalidated := dir == 1 ? (low <= sl or close < fvgBot) : (high >= sl or close > fvgTop)

buySignal  = state == 3 and not invalidated and dir == 1 and low <= entry
sellSignal = state == 3 and not invalidated and dir == -1 and high >= entry
if state == 3 and invalidated
    state := 0
if buySignal or sellSignal
    state := 4

// ── Position size ──────────────────────────────────────────────────────
riskAmount = accountSize * riskPct / 100
riskDist   = nz(math.abs(entry - sl))
posSize    = riskDist > 0 ? riskAmount / riskDist : 0.0

// ── Plots ──────────────────────────────────────────────────────────────
plotshape(buySignal,  title="Buy",  style=shape.triangleup,   location=location.belowbar, color=color.new(color.green, 0), size=size.small, text="BUY")
plotshape(sellSignal, title="Sell", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0),   size=size.small, text="SELL")
bgcolor(state == 1 ? color.new(color.yellow, 92) : state == 2 ? color.new(color.orange, 92) : state == 3 ? color.new(color.blue, 92) : na, title="Setup state")

var table info = table.new(position.top_right, 2, 5, border_width=1)
if barstate.islast
    stateTxt = state == 0 ? "idle" : state == 1 ? "awaiting 1m CHoCH" : state == 2 ? "awaiting FVG" : state == 3 ? "awaiting pullback" : "triggered"
    table.cell(info, 0, 0, "Setup state", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 0, stateTxt, text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 1, "Entry (FVG mid)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 1, na(entry) ? "—" : str.tostring(entry, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 2, "SL / TP", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 2, na(sl) ? "—" : str.tostring(sl, format.mintick) + " / " + str.tostring(tp, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 3, "Risk/trade", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 3, str.tostring(riskAmount, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 4, "Size (units)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 4, str.tostring(posSize, "#.####"), text_color=color.white, bgcolor=color.new(color.gray, 60))

// ── Alerts ─────────────────────────────────────────────────────────────
alertcondition(buySignal,  title="Buy signal",  message="${sanitize(cfg.name)}: BUY {{ticker}} @ {{close}} (FVG midpoint pullback)")
alertcondition(sellSignal, title="Sell signal", message="${sanitize(cfg.name)}: SELL {{ticker}} @ {{close}} (FVG midpoint pullback)")
alertcondition(newSetup, title="Setup armed", message="${sanitize(cfg.name)}: 15m trend break confirmed on {{ticker}} — watching the 1m")
`;
}

/**
 * Dedicated indicator mirroring the app's "Stochastic Double Top/Bottom"
 * detector: two swing highs at (or very near) the same level with the slow
 * stochastic overbought (>= 80) at the second one (mirror: double bottom with
 * <= 20), a close through the neckline confirming the reversal, then the
 * sell/buy signal on the neckline retest — SL beyond the pattern extreme with
 * an ATR buffer, TP at the measured move extended to a minimum R multiple.
 * Works on any symbol/timeframe; pivots confirm pivotLen bars later (no repaint).
 */
const STOCH_REVERSAL_PINE_BUILD = "v9";

function stochReversalPineScript(cfg: PineConfig): string {
  const riskPercent = cfg.riskPercent ?? 1;
  const minRR = cfg.rewardMultiple ?? 1.5;

  return `//@version=6
indicator("${sanitize(cfg.name)} [${STOCH_REVERSAL_PINE_BUILD}]", overlay=true, max_lines_count=500)

// TradeIntel template build ${STOCH_REVERSAL_PINE_BUILD} — the build tag in the chart legend
// identifies which generated version is running.
// Double top/bottom + stochastic extreme reversal. Pattern pivots confirm
// pivotLen bars after the extreme (no repaint); the reversal must confirm
// with a close through the neckline before the retest entry can signal.

// ── Inputs ─────────────────────────────────────────────────────────────
accountSize = input.float(10000, "Account size", minval=1)
riskPct     = input.float(${riskPercent}, "Risk % per trade", minval=0.1, maxval=10, step=0.1)
stochLen    = input.int(14, "Stochastic %K length", minval=2)
stochSmooth = input.int(3, "Stochastic smoothing", minval=1)
obLevel     = input.float(80, "Overbought (double top)", minval=50, maxval=100)
osLevel     = input.float(20, "Oversold (double bottom)", minval=0, maxval=50)
pivotLen    = input.int(5, "Pivot lookback", minval=2)
tolAtr      = input.float(0.75, "Max distance between the two extremes (ATR)", minval=0.1, step=0.05)
minHeightAtr = input.float(1.0, "Min pattern height (ATR)", minval=0.1, step=0.1)
maxGapBars  = input.int(80, "Max bars between the two extremes", minval=5)
bufAtr      = input.float(0.5, "SL buffer beyond the extreme (ATR)", minval=0.0, step=0.1)
minRR       = input.float(${minRR}, "Minimum reward multiple (R)", minval=0.5, step=0.25)
maxAgeBars  = input.int(120, "Cancel unfilled setups after (bars)", minval=10)
strictGate  = input.bool(true, "Strict stochastic at retest entry (SELL needs 80+, BUY needs 20- on the signal bar)")
entryMode   = input.string("both", "Entry mode", options=["retest", "breakout", "both"], tooltip="retest: enter on the neckline retest (stochastic-gated). breakout: enter at the close of the confirmation bar so vertical moves that never retest aren't missed — skipped when that close already consumed too much of the measured move (see max-consumed input) or the stochastic sits at the wrong extreme on that bar (no BUY while overbought, no SELL while oversold). both: breakout when viable, otherwise the retest. Outside retest mode an engulfing reversal candle at the second extreme is an additional early trigger (see below).")
useTrendLeg = input.bool(true, "Require a prior trend leg into the pattern", tooltip="The move into the first extreme must span at least the leg size below — filters range-bound double tops/bottoms that have nothing to reverse.")
trendLegAtr = input.float(3.0, "Min prior leg into the first extreme (ATR)", minval=0.5, step=0.5)
trendLookback = input.int(40, "Prior leg lookback (bars)", minval=10)
useDivergence = input.bool(true, "Require stochastic divergence at the second extreme", tooltip="The stochastic at the second top must not be clearly stronger than at the first top (mirror for bottoms) — the standard double-top quality filter, judged with the tolerance below so near-equal readings still qualify.")
divTolerance = input.float(5.0, "Divergence tolerance (stochastic points)", minval=0.0, step=1.0, tooltip="The second extreme only fails the divergence filter when its stochastic exceeds the first extreme's by more than this — 0 restores the strict lower-than/higher-than rule.")
breakMarginAtr = input.float(0.15, "Decisive neckline break margin (ATR)", minval=0.0, step=0.05, tooltip="The confirming close must clear the neckline by this margin — marginal squeaks through the neckline in chop are where most fakeouts come from. Set 0 to disable.")
maxConsumed = input.float(0.5, "Max move consumed at breakout entry", minval=0.1, maxval=1.0, step=0.05, tooltip="A breakout entry is skipped when the confirmation close has already covered more than this fraction of the measured move past the neckline — late confirmations leave a target that can't realistically be reached.")
useEngulf   = input.bool(true, "Engulfing candle trigger at the second extreme", tooltip="An engulfing reversal candle right at the second top/bottom — where the stochastic tagged the extreme and hasn't swung to the opposite one — confirms the reversal early: entered at the close of the bar where both the candle and the pattern are known, well before the neckline break would confirm. Only active outside retest entry mode.")
engulfWindow = input.int(10, "Max bars after the second extreme for the engulfing trigger", minval=1)

// ── Stochastic + pivots ────────────────────────────────────────────────
stochK = ta.sma(ta.stoch(close, high, low, stochLen), stochSmooth)
atrValue = ta.atr(14)
ph = ta.pivothigh(high, pivotLen, pivotLen)
pl = ta.pivotlow(low, pivotLen, pivotLen)
// stochastic near the pivot bar (a small window around the extreme)
kNearHigh = math.max(nz(stochK[pivotLen - 1], 0), math.max(nz(stochK[pivotLen], 0), nz(stochK[pivotLen + 1], 0)))
kNearLow  = math.min(nz(stochK[pivotLen - 1], 100), math.min(nz(stochK[pivotLen], 100), nz(stochK[pivotLen + 1], 100)))
// engulfing reversal candle o bars back: a body engulfing the previous bar's opposite-coloured body
bullEngulf(int o) => close[o] > open[o] and close[o + 1] < open[o + 1] and open[o] <= close[o + 1] and close[o] >= open[o + 1]
bearEngulf(int o) => close[o] < open[o] and close[o + 1] > open[o + 1] and open[o] >= close[o + 1] and close[o] <= open[o + 1]
// the stochastic tagged the pattern's extreme at some point between the second
// extreme (extOff bars back, with the same window used to qualify it) and the
// engulfing bar o bars back — and is not at the opposite extreme on that bar
kAtExtreme(int o, int extOff, int d) =>
    wrongSideNow = d == -1 ? nz(stochK[o], 100) <= osLevel : nz(stochK[o], 0) >= obLevel
    ok = false
    for j = o to extOff + 2
        ok := ok or (d == -1 ? nz(stochK[j], 0) >= obLevel : nz(stochK[j], 100) <= osLevel)
    ok and not wrongSideNow
// prior leg into a just-confirmed pivot: the range of the lookback window ending at the extreme bar
legLowIntoPivot  = ta.lowest(low, trendLookback)[pivotLen]
legHighIntoPivot = ta.highest(high, trendLookback)[pivotLen]

// ── Pattern tracking ───────────────────────────────────────────────────
// previous swing high/low (potential first extreme) + the interim neckline
var float topA = na
var int   topABar = na
var float topAK = na    // stochastic at the first top (for divergence)
var float topALeg = na  // size of the move into the first top (for the trend filter)
var float neckLow = na
var float botA = na
var int   botABar = na
var float botAK = na
var float botALeg = na
var float neckHigh = na

// setup state: 0 idle · 1 pattern formed, awaiting confirmation · 2 armed (confirmed, awaiting retest) · 3 in trade
var int state = 0
var int dir = 0 // -1 short (double top), +1 long (double bottom)
var int patternBar = na
var float entry = na
var float sl = na
var float tp = na
var float measured = na // pure measured-move target (pattern height from the neckline)

bool patternFormed = false

// a newer qualifying pattern supersedes any unfilled setup (only an open trade is protected)
if not na(ph)
    if state != 3 and not na(topA) and not na(neckLow) and (bar_index - pivotLen - topABar) <= maxGapBars and math.abs(ph - topA) <= tolAtr * atrValue and math.max(ph, topA) - neckLow >= minHeightAtr * atrValue and kNearHigh >= obLevel and (not useDivergence or kNearHigh < topAK + divTolerance) and (not useTrendLeg or topALeg >= trendLegAtr * atrValue)
        dir := -1
        entry := neckLow
        patternHigh = math.max(ph, topA)
        sl := patternHigh + bufAtr * atrValue
        riskDist0 = sl - entry
        height = patternHigh - neckLow
        measured := entry - height
        tp := math.min(measured, entry - minRR * riskDist0)
        state := 1
        patternBar := bar_index
        patternFormed := true
    topA := ph
    topABar := bar_index - pivotLen
    topAK := kNearHigh
    topALeg := ph - legLowIntoPivot
    neckLow := na

if not na(pl)
    if state != 3 and not na(botA) and not na(neckHigh) and (bar_index - pivotLen - botABar) <= maxGapBars and math.abs(pl - botA) <= tolAtr * atrValue and neckHigh - math.min(pl, botA) >= minHeightAtr * atrValue and kNearLow <= osLevel and (not useDivergence or kNearLow > botAK - divTolerance) and (not useTrendLeg or botALeg >= trendLegAtr * atrValue)
        dir := 1
        entry := neckHigh
        patternLow = math.min(pl, botA)
        sl := patternLow - bufAtr * atrValue
        riskDist0 = entry - sl
        height = neckHigh - patternLow
        measured := entry + height
        tp := math.max(measured, entry + minRR * riskDist0)
        state := 1
        patternBar := bar_index
        patternFormed := true
    botA := pl
    botABar := bar_index - pivotLen
    botAK := kNearLow
    botALeg := legHighIntoPivot - pl
    neckHigh := na

// track the interim neckline between the two extremes
if not na(pl) and not na(topA)
    neckLow := na(neckLow) ? pl : math.min(neckLow, pl)
if not na(ph) and not na(botA)
    neckHigh := na(neckHigh) ? ph : math.max(neckHigh, ph)

// ── State machine: confirmation → retest entry → TP/SL ─────────────────
bool confirmed = false
bool buySignal = false
bool sellSignal = false

// stale unfilled setups expire: the retest must come while the pattern is still fresh
if (state == 1 or state == 2) and (bar_index - patternBar) > maxAgeBars
    state := 0

// engulfing trigger: an engulfing reversal candle at the second extreme (whose
// stochastic tagged the pattern's extreme) confirms the reversal early — entered at the current
// close (the first bar where both the candle and the pattern are known); on the
// pattern-formation bar the pivotLen bars since the extreme are checked too
if useEngulf and entryMode != "retest" and state == 1 and (bar_index - (patternBar - pivotLen)) <= engulfWindow
    extremeOff = bar_index - (patternBar - pivotLen)
    engulfSeen = false
    if patternFormed
        for o = 0 to pivotLen - 1
            if (dir == -1 ? bearEngulf(o) : bullEngulf(o)) and kAtExtreme(o, extremeOff, dir)
                engulfSeen := true
    else
        engulfSeen := (dir == -1 ? bearEngulf(0) : bullEngulf(0)) and kAtExtreme(0, extremeOff, dir)
    if engulfSeen
        spentLevelE = dir == -1 ? entry - maxConsumed * (entry - measured) : entry + maxConsumed * (measured - entry)
        engSpent = dir == -1 ? close <= spentLevelE : close >= spentLevelE
        engRisk = math.abs(close - sl)
        stillValid = dir == -1 ? close < sl : close > sl
        if not engSpent and engRisk > 0 and stillValid
            entry := close
            tp := dir == -1 ? math.min(measured, close - minRR * engRisk) : math.max(measured, close + minRR * engRisk)
            confirmed := true
            sellSignal := dir == -1
            buySignal := dir == 1
            state := 3

if state == 1
    if dir == -1 ? close > sl : close < sl
        state := 0 // died beyond the stop level before confirming
    else if dir == -1 ? close < entry - breakMarginAtr * atrValue : close > entry + breakMarginAtr * atrValue
        confirmed := true
        // breakout entry: take the confirmation close itself (no retest needed);
        // the TP is recomputed from that entry — measured move, or the minimum R
        // when nearer — and skipped when the close already consumed too much of
        // the measured move (late confirmation — the move is spent) or the
        // stochastic sits at the wrong extreme on the confirmation bar
        spentLevel = dir == -1 ? entry - maxConsumed * (entry - measured) : entry + maxConsumed * (measured - entry)
        ranTooFar = dir == -1 ? close <= spentLevel : close >= spentLevel
        breakoutRisk = math.abs(close - sl)
        wrongSide = dir == -1 ? stochK <= osLevel : stochK >= obLevel
        if entryMode != "retest" and not ranTooFar and not wrongSide and breakoutRisk > 0
            entry := close
            tp := dir == -1 ? math.min(measured, close - minRR * breakoutRisk) : math.max(measured, close + minRR * breakoutRisk)
            sellSignal := dir == -1
            buySignal := dir == 1
            state := 3
        else if entryMode == "breakout"
            state := 0 // move already spent at confirmation — breakout entry skipped
        else
            state := 2

// gate at the signal bar: a SELL only fires with the stochastic overbought and a
// BUY only with it oversold; unticking strict mode relaxes this to only blocking
// the opposite extreme (no sells while oversold, no buys while overbought)
stochGateOk = strictGate ? (dir == -1 ? stochK >= obLevel : stochK <= osLevel) : (dir == -1 ? stochK > osLevel : stochK < obLevel)

if state == 2 and not confirmed // retest entry: don't act on the confirmation bar itself
    if dir == -1 ? close > sl : close < sl
        state := 0 // closed beyond the stop before entry
    else if high >= entry and low <= entry and stochGateOk
        sellSignal := dir == -1
        buySignal := dir == 1
        state := 3
    else if dir == -1 ? low <= tp : high >= tp
        state := 0 // ran to the target without retesting — entry missed

if state == 3 and not (buySignal or sellSignal)
    if dir == -1 ? high >= sl : low <= sl
        state := 0 // stopped out
    else if dir == -1 ? low <= tp : high >= tp
        state := 0 // take profit reached

if patternFormed or confirmed
    line.new(bar_index, entry, bar_index + 30, entry, color=color.new(color.blue, 0), style=line.style_dashed, width=1)
    line.new(bar_index, sl, bar_index + 30, sl, color=color.new(color.red, 0), style=line.style_dashed, width=1)
    line.new(bar_index, tp, bar_index + 30, tp, color=color.new(color.green, 0), style=line.style_dashed, width=1)

// ── Position size ──────────────────────────────────────────────────────
riskAmount = accountSize * riskPct / 100
riskDist   = nz(math.abs(entry - sl))
posSize    = riskDist > 0 ? riskAmount / riskDist : 0.0

// ── Plots ──────────────────────────────────────────────────────────────
// the gate is judged on this line (smoothed %K) — compare it, not a separately
// configured stochastic pane, when checking why a signal did or didn't fire
plot(stochK, "Slow stochastic %K", color=color.new(color.purple, 0), display=display.data_window)
plotshape(buySignal,  title="Buy",  style=shape.triangleup,   location=location.belowbar, color=color.new(color.green, 0), size=size.small, text="BUY")
plotshape(sellSignal, title="Sell", style=shape.triangledown, location=location.abovebar, color=color.new(color.red, 0),   size=size.small, text="SELL")
bgcolor(state == 1 ? color.new(color.yellow, 92) : state == 2 ? color.new(color.blue, 92) : state == 3 ? color.new(color.teal, 92) : na, title="Setup state")

var table info = table.new(position.top_right, 2, 5, border_width=1)
if barstate.islast
    stateTxt = state == 0 ? "idle" : state == 1 ? (dir == -1 ? "double top — awaiting confirmation" : "double bottom — awaiting confirmation") : state == 2 ? "armed — awaiting neckline retest" : "in trade"
    table.cell(info, 0, 0, "Setup state (${STOCH_REVERSAL_PINE_BUILD})", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 0, stateTxt, text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 1, "Entry (neckline)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 1, na(entry) ? "—" : str.tostring(entry, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 2, "SL / TP", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 2, na(sl) ? "—" : str.tostring(sl, format.mintick) + " / " + str.tostring(tp, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 3, "Risk/trade", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 3, str.tostring(riskAmount, format.mintick), text_color=color.white, bgcolor=color.new(color.gray, 60))
    table.cell(info, 0, 4, "Size (units)", text_color=color.white, bgcolor=color.new(color.gray, 40))
    table.cell(info, 1, 4, str.tostring(posSize, "#.####"), text_color=color.white, bgcolor=color.new(color.gray, 60))

// ── Alerts ─────────────────────────────────────────────────────────────
alertcondition(patternFormed, title="Pattern formed", message="${sanitize(cfg.name)}: double top/bottom with a stochastic extreme on {{ticker}} — awaiting reversal confirmation")
alertcondition(confirmed, title="Reversal confirmed", message="${sanitize(cfg.name)}: reversal confirmed on {{ticker}} — watching for the neckline retest")
alertcondition(buySignal,  title="Buy signal",  message="${sanitize(cfg.name)}: BUY {{ticker}} @ {{close}} (double bottom entry — retest, breakout or engulfing trigger)")
alertcondition(sellSignal, title="Sell signal", message="${sanitize(cfg.name)}: SELL {{ticker}} @ {{close}} (double top entry — retest, breakout or engulfing trigger)")
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
    case "trend_break":
    case "stoch_reversal":
      return ""; // generated by a dedicated script builder
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
    case "trend_break":
    case "stoch_reversal":
      return ""; // generated by a dedicated script builder
  }
}

function sanitize(name: string): string {
  return name.replace(/["\\\n\r]/g, "").slice(0, 60);
}
