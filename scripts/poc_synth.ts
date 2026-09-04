/**
 * Synthetic scenario checks for the Volume Profile POC Break & Retest detector
 * and its dedicated backtest. Run with: npx tsx scripts/poc_synth.ts
 */
import type { Candle } from "../src/lib/market/types";
import {
  backtestPocAmd,
  detectPocAmdSetup,
  DEFAULT_POC_AMD_FILTERS,
  DEFAULT_POC_RR_TARGET,
} from "../src/lib/strategies/pocAmd";

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
  v?: number;
}

function toCandles(bars: Bar[]): Candle[] {
  return bars.map((b, i) => ({ time: 1_700_000_000 + i * 3600, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v ?? 100 }));
}

/** A tight ranging bar around a level (ATR ~2), volume concentrated at the level. */
function rangeBar(level: number, v = 100): Bar {
  return { o: level, h: level + 1, l: level - 1, c: level, v };
}

/** 35 consolidation bars around 100 — the box; the profile's POC sits ~100. */
function consolidation(): Bar[] {
  return Array.from({ length: 35 }, () => rangeBar(100));
}

// ── 1. Bullish full flow: sweep below → distribution closes above the POC ─
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 }); // manipulation sweep below the range (deep enough to end the box)
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 101, v: 5000 }); // distribution CLOSES above the POC (volume surge)
  const setup = detectPocAmdSetup(toCandles(bars));
  check(
    "bullish: sweep below + close above the POC → awaiting_pullback",
    setup !== null && setup.direction === "bullish" && setup.state === "awaiting_pullback",
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
  if (setup && setup.entry !== null && setup.stopLoss !== null && setup.takeProfit !== null && setup.sweepPrice !== null) {
    check("entry at the POC", Math.abs(setup.entry - setup.poc) < 1e-9, `entry=${setup.entry} poc=${setup.poc}`);
    check("POC near the consolidation's volume node", Math.abs(setup.poc - 100) < 1.5, `poc=${setup.poc}`);
    check("sweep extreme captured", Math.abs(setup.sweepPrice - 89) < 1e-9, `sweep=${setup.sweepPrice}`);
    check("SL just beyond the sweep extreme", setup.stopLoss < setup.sweepPrice);
    const risk = setup.entry - setup.stopLoss;
    check(
      "TP at the default 2R risk multiple",
      setup.rrTarget === DEFAULT_POC_RR_TARGET && Math.abs(setup.takeProfit - (setup.entry + DEFAULT_POC_RR_TARGET * risk)) < 1e-9,
    );

    // pullback tags the POC → triggered
    const withPullback = [...bars, { o: 101, h: 101.5, l: setup.entry - 0.2, c: 100.8, v: 100 }];
    const s2 = detectPocAmdSetup(toCandles(withPullback));
    check("POC pullback tag triggers the entry", s2 !== null && s2.state === "triggered", `state=${s2?.state ?? "null"}`);

    // after the fill, the target completes the trade
    const withTp = [...withPullback, { o: 101, h: setup.takeProfit + 1, l: 100.5, c: setup.takeProfit + 0.5, v: 100 }];
    const s3 = detectPocAmdSetup(toCandles(withTp));
    check("take profit completes the setup", s3 !== null && s3.state === "completed", `state=${s3?.state ?? "null"} detail=${s3?.stateDetail ?? ""}`);

    // backtest round trip on the same bars: one +2R winner
    const bt = backtestPocAmd("SYNTH", "1h", toCandles(withTp));
    check("backtest replays the same flow as one 2R winner", bt.trades.length === 1 && bt.trades[0].exitReason === "tp" && Math.abs(bt.trades[0].rMultiple - 2) < 0.01, `trades=${bt.trades.length} r=${bt.trades[0]?.rMultiple}`);

    // a close back through the POC before the fill invalidates
    const withRevert = [...bars, { o: 101, h: 101.2, l: 96.5, c: 97, v: 100 }];
    const s4 = detectPocAmdSetup(toCandles(withRevert));
    check("close back through the POC before the fill invalidates", s4 !== null && s4.state === "invalidated", `state=${s4?.state ?? "null"}`);

    // stop after the fill completes the trade
    const withSl = [...withPullback, { o: 100.5, h: 100.8, l: setup.stopLoss - 1, c: setup.stopLoss - 0.5, v: 100 }];
    const s5 = detectPocAmdSetup(toCandles(withSl));
    check("stop level after entry completes the setup", s5 !== null && s5.state === "completed", `state=${s5?.state ?? "null"} detail=${s5?.stateDetail ?? ""}`);
  }
}

// ── 2. A wick through the POC does NOT count as the distribution break ────
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 });
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 98.5, v: 5000 }); // wick above the POC, close back below it
  const setup = detectPocAmdSetup(toCandles(bars));
  check(
    "wick-only POC poke keeps the setup in 'manipulated'",
    setup !== null && setup.state === "manipulated" && setup.direction === "bullish",
    `state=${setup?.state ?? "null"}`,
  );
}

// ── 3. Pullback timeout invalidates the unfilled entry ────────────────────
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 });
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 101, v: 5000 });
  const maxWait = 5;
  for (let i = 0; i < maxWait + 2; i++) bars.push({ o: 102, h: 103, l: 101.2, c: 102, v: 100 }); // hovers above the POC, never tags it
  const setup = detectPocAmdSetup(toCandles(bars), DEFAULT_POC_RR_TARGET, DEFAULT_POC_AMD_FILTERS, maxWait);
  check(
    "pullback timeout invalidates the setup",
    setup !== null && setup.state === "invalidated" && setup.stateDetail.includes("too long"),
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
  const relaxed = detectPocAmdSetup(toCandles(bars), DEFAULT_POC_RR_TARGET, DEFAULT_POC_AMD_FILTERS, 30);
  check("raising the max wait keeps it alive", relaxed !== null && relaxed.state === "awaiting_pullback", `state=${relaxed?.state ?? "null"}`);
}

// ── 4. Bearish mirror: sweep above → distribution closes below the POC ────
{
  const bars = consolidation();
  bars.push({ o: 102, h: 111, l: 101, c: 108, v: 100 }); // manipulation sweep above the range
  bars.push({ o: 108, h: 108.5, l: 96.5, c: 97, v: 5000 }); // distribution CLOSES below the POC
  const setup = detectPocAmdSetup(toCandles(bars));
  check(
    "bearish: sweep above + close below the POC → awaiting_pullback (SELL)",
    setup !== null && setup.direction === "bearish" && setup.state === "awaiting_pullback",
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
  if (setup && setup.entry !== null && setup.stopLoss !== null && setup.takeProfit !== null && setup.sweepPrice !== null) {
    check("bearish SL just beyond the sweep high", setup.stopLoss > setup.sweepPrice);
    check("bearish TP below the entry", setup.takeProfit < setup.entry);
    const withPullback = [...bars, { o: 97, h: setup.entry + 0.2, l: 96.8, c: 98, v: 100 }];
    const s2 = detectPocAmdSetup(toCandles(withPullback));
    check("bearish POC pullback tag triggers the SELL", s2 !== null && s2.state === "triggered", `state=${s2?.state ?? "null"}`);
  }
}

// ── 5. A distribution leg below the minimum is filter-rejected ────────────
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 });
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 101, v: 5000 });
  const strict = { ...DEFAULT_POC_AMD_FILTERS, minDistLegAtr: 10 };
  const setup = detectPocAmdSetup(toCandles(bars), DEFAULT_POC_RR_TARGET, strict);
  check(
    "distribution leg below the minimum rejected by the filter",
    setup !== null && setup.state === "invalidated" && setup.stateDetail.includes("weak distribution"),
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
  const relaxed = detectPocAmdSetup(toCandles(bars), DEFAULT_POC_RR_TARGET, DEFAULT_POC_AMD_FILTERS);
  check("the default leg minimum accepts it", relaxed !== null && relaxed.state === "awaiting_pullback", `state=${relaxed?.state ?? "null"} detail=${relaxed?.stateDetail ?? ""}`);
}

// ── 6. No volume surge on the break is filter-rejected ────────────────────
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 });
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 101, v: 100 }); // average volume on the break — no surge
  const setup = detectPocAmdSetup(toCandles(bars));
  check(
    "no volume surge on the break rejected by the filter",
    setup !== null && setup.state === "invalidated" && setup.stateDetail.includes("volume surge"),
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
  const off = { ...DEFAULT_POC_AMD_FILTERS, volumeSurge: false };
  const relaxed = detectPocAmdSetup(toCandles(bars), DEFAULT_POC_RR_TARGET, off);
  check("turning the volume filter off accepts it", relaxed !== null && relaxed.state === "awaiting_pullback", `state=${relaxed?.state ?? "null"}`);
}

// ── 7. A break candle without volume data skips the volume filter ─────────
{
  const bars = consolidation();
  bars.push({ o: 98, h: 99, l: 89, c: 92, v: 100 });
  bars.push({ o: 92, h: 101.5, l: 91.5, c: 101, v: 0 }); // feed without volume on the break candle
  const setup = detectPocAmdSetup(toCandles(bars));
  check(
    "zero-volume break candle skips the volume surge filter",
    setup !== null && setup.state === "awaiting_pullback",
    `state=${setup?.state ?? "null"} detail=${setup?.stateDetail ?? ""}`,
  );
}

console.log(failures === 0 ? "\nAll POC AMD synthetic checks passed" : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
