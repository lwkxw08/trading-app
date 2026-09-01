/**
 * Synthetic scenario checks for the Trendline Break + Fib Retracement detector
 * and its dedicated backtest. Run with: npx tsx scripts/tlf_synth.ts
 */
import type { Candle } from "../src/lib/market/types";
import {
  backtestTrendlineFib,
  detectTrendlineFibSetup,
  DEFAULT_FIB_TARGET,
  DEFAULT_MAX_PULLBACK_BARS,
  DEFAULT_TRENDLINE_FIB_FILTERS,
  ENTRY_FIB,
} from "../src/lib/strategies/trendlineFib";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Bar {
  o: number;
  h: number;
  l: number;
  c: number;
}

function toCandles(bars: Bar[]): Candle[] {
  return bars.map((b, i) => ({ time: 1_700_000_000 + i * 3600, open: b.o, high: b.h, low: b.l, close: b.c, volume: 1000 }));
}

/** Flat noise bar around a level (keeps ATR ~2). */
function noise(level: number): Bar {
  return { o: level, h: level + 1, l: level - 1, c: level };
}

/**
 * Downtrend under a falling resistance line starting at `start`, sloping
 * `slope` per bar (negative). Touch pivots poke up to the line at the given
 * offsets; other bars stay ~4 below it. Lows carve the swing low near the end.
 */
function downtrend(opts: { bars: number; start: number; slope: number; touchAt: number[]; swingLowAt?: number; swingLowDepth?: number }): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < opts.bars; i++) {
    const line = opts.start + opts.slope * i;
    if (opts.touchAt.includes(i)) {
      out.push({ o: line - 5, h: line, l: line - 7, c: line - 4 });
    } else if (opts.swingLowAt === i) {
      const depth = opts.swingLowDepth ?? 10;
      out.push({ o: line - 6.5, h: line - 6, l: line - depth, c: line - 7 });
    } else {
      // alternate closes so the pre-break RSI is not pinned low
      out.push({ o: line - 7, h: line - 6, l: line - 8.5, c: line - 7 + (i % 2) * 1.2 });
    }
  }
  return out;
}

/** Mirror image: uptrend over a rising support line. */
function uptrend(opts: { bars: number; start: number; slope: number; touchAt: number[]; swingHighAt?: number; swingHighHeight?: number }): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < opts.bars; i++) {
    const line = opts.start + opts.slope * i;
    if (opts.touchAt.includes(i)) {
      out.push({ o: line + 5, h: line + 7, l: line, c: line + 4 });
    } else if (opts.swingHighAt === i) {
      const height = opts.swingHighHeight ?? 10;
      out.push({ o: line + 6.5, h: line + height, l: line + 6, c: line + 7 });
    } else {
      out.push({ o: line + 7, h: line + 8.5, l: line + 6, c: line + 7 - (i % 2) * 1.2 });
    }
  }
  return out;
}

// Shared scaffold: 40 warmup noise bars, then a downtrend whose resistance
// falls 0.8/bar with touches at 5, 20, 35 and the swing low at bar 44.
const WARMUP = Array.from({ length: 40 }, () => noise(200));
const DOWN = downtrend({ bars: 46, start: 180, slope: -0.8, touchAt: [5, 20, 35], swingLowAt: 44, swingLowDepth: 12 });
const lineAt = (i: number) => 180 - 0.8 * (i - 40); // resistance value at candle index i (touches start at 40+5)

// ── 1. Bullish break: candle CLOSES above the falling resistance ─────────
{
  const bars = [...WARMUP, ...DOWN];
  const breakIdx = bars.length;
  const lv = lineAt(breakIdx);
  bars.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv + 6 }); // strong green close above the line
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("bullish break detected on candle CLOSE above the line", setup !== null && setup.direction === "bullish" && setup.state === "awaiting_pullback", `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`);
  if (setup && setup.entry !== null && setup.swingPrice !== null && setup.fibOne !== null && setup.takeProfit !== null && setup.stopLoss !== null) {
    const range = setup.fibOne - setup.swingPrice;
    check("touches >= 3", setup.touches >= 3, `touches=${setup.touches}`);
    check("entry at the 0.618 fib", Math.abs(setup.entry - (setup.swingPrice + ENTRY_FIB * range)) < 1e-9);
    check("TP at the 2.618 fib by default", setup.targetFib === DEFAULT_FIB_TARGET && Math.abs(setup.takeProfit - (setup.swingPrice + DEFAULT_FIB_TARGET * range)) < 1e-9);
    check("SL just below the fib 0 swing", setup.stopLoss < setup.swingPrice);

    // pullback to the 0.618 fills the entry
    const withPullback = [...bars];
    const e = setup.entry;
    withPullback.push({ o: lv + 6, h: lv + 6.5, l: e - 0.2, c: e + 0.5 });
    const s2 = detectTrendlineFibSetup(toCandles(withPullback));
    check("0.618 pullback triggers the entry", s2 !== null && s2.state === "triggered", `state=${s2?.state ?? "null"}`);

    // a later close back through the line before the fill invalidates
    const withRevert = [...bars];
    const lv2 = lineAt(withRevert.length);
    withRevert.push({ o: lv + 6, h: lv + 6.5, l: lv2 - 5, c: lv2 - 4 }); // closes back below the extended line
    const s3 = detectTrendlineFibSetup(toCandles(withRevert));
    check(
      "close back through the line before the fill invalidates",
      s3 === null || s3.state === "invalidated" || s3.state === "awaiting_break",
      `state=${s3?.state ?? "null"}`,
    );
  }
}

// ── 2. Wick through, close back on the trend side: NOT a break ───────────
{
  const bars = [...WARMUP, ...DOWN];
  const lv = lineAt(bars.length);
  bars.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv - 3 }); // wick pokes above, closes back below
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("wick through the line with a close back does NOT arm the setup", setup === null || setup.state === "awaiting_break", `state=${setup?.state ?? "null"}`);
}

// ── 3. Marginal close through the line is rejected with decisive-break on ─
{
  const bars = [...WARMUP, ...DOWN];
  const lv = lineAt(bars.length);
  bars.push({ o: lv - 1, h: lv + 0.2, l: lv - 1.5, c: lv + 0.05 }); // squeaks through by 0.05 (< 0.15 ATR)
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("marginal close through the line does not arm a trade (decisive on)", setup === null || (setup.state !== "awaiting_pullback" && setup.state !== "triggered"), `state=${setup?.state ?? "null"}`);
  const setupOff = detectTrendlineFibSetup(toCandles(bars), DEFAULT_FIB_TARGET, { ...DEFAULT_TRENDLINE_FIB_FILTERS, decisiveBreak: false, strongBreakCandle: false, momentumFilter: false });
  check("same close arms with all filters off", setupOff !== null && setupOff.state === "awaiting_pullback", `state=${setupOff?.state ?? "null"}`);
}

// ── 4. Weak break candle rejected by the strong-candle filter ─────────────
{
  const bars = [...WARMUP, ...DOWN];
  const lv = lineAt(bars.length);
  bars.push({ o: lv + 2.4, h: lv + 12, l: lv - 8, c: lv + 3 }); // closes clearly above but tiny body vs range
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("weak break candle rejected (strong-candle filter)", setup === null || setup.state === "invalidated", `state=${setup?.state ?? "null"}`);
}

// ── 5. Mirrored bearish break of a rising support ─────────────────────────
{
  const up = uptrend({ bars: 46, start: 200, slope: 0.8, touchAt: [5, 20, 35], swingHighAt: 44, swingHighHeight: 12 });
  const bars = [...WARMUP, ...up];
  const lv = 200 + 0.8 * (bars.length - 40);
  bars.push({ o: lv + 6, h: lv + 6.5, l: lv - 7, c: lv - 6 }); // strong red close below the support
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("bearish break of a rising support detected", setup !== null && setup.direction === "bearish" && setup.state === "awaiting_pullback", `state=${setup?.state ?? "null"}`);
  if (setup && setup.entry !== null && setup.swingPrice !== null && setup.fibOne !== null && setup.takeProfit !== null && setup.stopLoss !== null) {
    const range = setup.swingPrice - setup.fibOne;
    check("bearish entry at the 0.618 below", Math.abs(setup.entry - (setup.swingPrice - ENTRY_FIB * range)) < 1e-9);
    check("bearish SL just above the fib 0 swing high", setup.stopLoss > setup.swingPrice);
    check("bearish TP below the entry", setup.takeProfit < setup.entry);
  }
}

// ── 6. Fewer than 3 touches: no setup ─────────────────────────────────────
{
  const two = downtrend({ bars: 46, start: 180, slope: -0.8, touchAt: [5, 35], swingLowAt: 44, swingLowDepth: 12 });
  const bars = [...WARMUP, ...two];
  const lv = lineAt(bars.length);
  bars.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv + 6 });
  const setup = detectTrendlineFibSetup(toCandles(bars));
  check("a 2-touch line does not qualify", setup === null || (setup.state !== "awaiting_pullback" && setup.state !== "triggered"), `state=${setup?.state ?? "null"}`);
}

// ── 7. Alternate target fib levels scale the TP ───────────────────────────
{
  const bars = [...WARMUP, ...DOWN];
  const lv = lineAt(bars.length);
  bars.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv + 6 });
  const candles = toCandles(bars);
  for (const target of [1.618, 3.618, 4.236]) {
    const setup = detectTrendlineFibSetup(candles, target);
    if (setup && setup.takeProfit !== null && setup.swingPrice !== null && setup.fibOne !== null) {
      const range = setup.fibOne - setup.swingPrice;
      check(`target fib ${target} places the TP at swing + ${target}×range`, Math.abs(setup.takeProfit - (setup.swingPrice + target * range)) < 1e-9);
    } else {
      check(`target fib ${target} still produces a setup`, false, `state=${setup?.state ?? "null"}`);
    }
  }
}

// ── 8. Max pullback wait: late 0.618 fills are invalidated ──────────────
{
  const base = [...WARMUP, ...DOWN];
  const lv = lineAt(base.length);
  base.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv + 6 }); // break
  const armed = detectTrendlineFibSetup(toCandles(base));
  if (armed && armed.entry !== null) {
    const e = armed.entry;
    // hover bars: stay above the falling line and above the entry, no fill
    const hover = (): Bar => ({ o: lv + 5, h: lv + 6.5, l: e + 1, c: lv + 5 });
    const fill = (): Bar => ({ o: lv + 5, h: lv + 5.5, l: e - 0.2, c: e + 0.5 });

    const quick = [...base, hover(), hover(), fill()];
    const sQuick = detectTrendlineFibSetup(toCandles(quick));
    check("pullback filling within 3 candles triggers", sQuick !== null && sQuick.state === "triggered", `state=${sQuick?.state ?? "null"}`);

    const slow = [...base];
    for (let k = 0; k < 11; k++) slow.push(hover());
    slow.push(fill());
    const sSlow = detectTrendlineFibSetup(toCandles(slow));
    check("pullback filling on candle 12 still triggers (default 15)", sSlow !== null && sSlow.state === "triggered", `state=${sSlow?.state ?? "null"}`);

    const late = [...base];
    for (let k = 0; k < DEFAULT_MAX_PULLBACK_BARS + 1; k++) late.push(hover());
    late.push(fill());
    const sLate = detectTrendlineFibSetup(toCandles(late));
    check(
      `pullback after ${DEFAULT_MAX_PULLBACK_BARS} candles is invalidated`,
      sLate !== null && sLate.state === "invalidated" && sLate.stateDetail.includes("Pullback took too long"),
      `state=${sLate?.state ?? "null"} detail=${sLate?.stateDetail ?? ""}`,
    );

    const sCustom = detectTrendlineFibSetup(toCandles(late), DEFAULT_FIB_TARGET, DEFAULT_TRENDLINE_FIB_FILTERS, 30);
    check("raising the max wait to 30 accepts the same late fill", sCustom !== null && sCustom.state === "triggered", `state=${sCustom?.state ?? "null"}`);

    const btLate = backtestTrendlineFib("TEST", "1h", toCandles(late));
    check("backtest skips the late-pullback trade as no-fill", btLate.trades.length === 0 && btLate.noFill >= 1, `trades=${btLate.trades.length} noFill=${btLate.noFill}`);
  } else {
    check("max-pullback scaffold arms", false, `state=${armed?.state ?? "null"}`);
  }
}

// ── 9. Backtest: full round trip in both directions ──────────────────────
{
  const bars = [...WARMUP, ...DOWN];
  const breakIdx = bars.length;
  const lv = lineAt(breakIdx);
  bars.push({ o: lv - 6, h: lv + 7, l: lv - 6.5, c: lv + 6 }); // break
  // pullback to the 0.618, then a rally through the 2.618
  const swing = Math.min(...bars.slice(40).map((b) => b.l));
  const fibOne = lv + 7;
  const range = fibOne - swing;
  const entry = swing + ENTRY_FIB * range;
  const tp = swing + DEFAULT_FIB_TARGET * range;
  bars.push({ o: lv + 6, h: lv + 6.5, l: entry - 0.2, c: entry + 0.5 }); // fill
  for (let p = entry; p < tp + 2; p += range * 0.4) {
    bars.push({ o: p, h: p + range * 0.5, l: p - 0.5, c: p + range * 0.4 });
  }
  const bt = backtestTrendlineFib("TEST", "1h", toCandles(bars));
  check("backtest takes the bullish trade", bt.trades.length === 1, `trades=${bt.trades.length} breaks=${bt.breaks} filtered=${bt.filtered} noFill=${bt.noFill}`);
  if (bt.trades.length === 1) {
    const t = bt.trades[0];
    check("backtest trade is long and exits at the TP", t.direction === "bullish" && t.exitReason === "tp", `${t.direction} ${t.exitReason}`);
    check("backtest R is positive", t.rMultiple > 0, `r=${t.rMultiple}`);
  }
}

console.log(failures === 0 ? "\nAll trendline-fib synthetic checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
