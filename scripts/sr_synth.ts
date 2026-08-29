import { detectStochReversalSetup, stochReversalOpportunity, stochReversalWatchItem, stochasticK, type StochReversalEntryMode, type StochReversalFilters } from "../src/lib/strategies/stochReversal";
import type { Candle } from "../src/lib/market/types";

// state-machine scenarios run with the quality filters off so the synthetic
// series only has to exercise the pattern/confirmation/entry sequencing
const FILTERS_OFF: StochReversalFilters = { trendFilter: false, divergenceFilter: false, decisiveBreak: false };

// Synthetic double-top scenario, staged:
// uptrend -> peak1 ~110 -> trough ~105 (neckline) -> peak2 ~110.1 (stoch overbought)
// -> drift (awaiting confirmation) -> neckline break close (armed)
// -> neckline retest with stoch OVERSOLD (sell blocked, stays armed)
// -> deeper dip then rally back to the neckline with stoch recovered (triggered)
// -> decline to TP (completed).

function c(i: number, open: number, close: number, high?: number, low?: number): Candle {
  return {
    time: 1_700_000_000 + i * 300,
    open,
    close,
    high: high ?? Math.max(open, close) + 0.1,
    low: low ?? Math.min(open, close) - 0.1,
    volume: 10,
  };
}

function build(): { candles: Candle[]; marks: Record<string, number> } {
  const out: Candle[] = [];
  let i = 0;
  let px = 95;
  // 0-39: slow base 95 -> 100
  for (; i < 40; i++) {
    out.push(c(i, px, px + 0.125));
    px += 0.125;
  }
  // 40-59: rally 100 -> 110 (peak1 at 59 with a distinct wick high 110.5)
  for (; i < 60; i++) {
    out.push(i === 59 ? c(i, px, px + 0.5, px + 1.0) : c(i, px, px + 0.5));
    px += 0.5;
  }
  // 60-69: decline 110 -> 105 (trough at 69 with a distinct wick low 104.5 = neckline)
  for (; i < 70; i++) {
    out.push(i === 69 ? c(i, px, px - 0.5, undefined, px - 1.0) : c(i, px, px - 0.5));
    px -= 0.5;
  }
  // 70-79: rally 105 -> 110 (peak2 at 79, wick high 110.55 — within tolerance of 110.5)
  for (; i < 80; i++) {
    out.push(i === 79 ? c(i, px, px + 0.5, px + 1.05) : c(i, px, px + 0.5));
    px += 0.5;
  }
  // 80-84: drift down (confirms peak2 as swing high) 110 -> 108.5
  for (; i < 85; i++) {
    out.push(c(i, px, px - 0.3));
    px -= 0.3;
  }
  const awaiting = out.length; // truncate here => awaiting_confirmation
  // 85-93: continue drift, stay above neckline
  for (; i < 94; i++) {
    out.push(c(i, px, px - 0.3));
    px -= 0.3;
  }
  // 94: break the neckline (close below 104.5)
  out.push(c(i, px, 104.1));
  px = 104.1;
  i++;
  const armed = out.length; // truncate here => armed
  // 95: retest the neckline (range crosses entry 104.5) — stochastic here is
  // OVERSOLD (price sits at the bottom of the recent 14-bar window), so the
  // gate must block the sell and the setup stays armed
  out.push(c(i, 104.1, 104.4, 104.8, 104.0));
  px = 104.4;
  i++;
  const gated = out.length; // truncate here => armed (gated retest)
  // 96-107: dip to ~98 (stays above TP ~94.85) so the 14-bar stoch window drops
  for (let k = 0; k < 12; k++, i++) {
    out.push(c(i, px, px - 0.55));
    px -= 0.55;
  }
  // 108-111: rally back toward the neckline
  for (let k = 0; k < 4; k++, i++) {
    out.push(c(i, px, px + 1.5));
    px += 1.5;
  }
  // 112: retest the neckline with the stochastic recovered out of oversold
  // (near the top of the recent 14-bar window) => valid entry
  out.push(c(i, px, 104.4, 104.8, px - 0.2));
  px = 104.4;
  i++;
  const triggered = out.length; // truncate here => triggered
  // 113+: decline to TP
  for (let k = 0; k < 20; k++, i++) {
    out.push(c(i, px, px - 0.6));
    px -= 0.6;
  }
  const completed = out.length;
  return { candles: out, marks: { awaiting, armed, gated, triggered, completed } };
}

function mirror(candles: Candle[]): Candle[] {
  const pivot = 210;
  return candles.map((cd) => ({
    time: cd.time,
    open: pivot - cd.open,
    close: pivot - cd.close,
    high: pivot - cd.low,
    low: pivot - cd.high,
    volume: cd.volume,
  }));
}

function show(label: string, candles: Candle[], mode: StochReversalEntryMode = "retest") {
  const s = detectStochReversalSetup(candles, mode, FILTERS_OFF);
  if (!s) {
    console.log(`${label}: null`);
    return;
  }
  console.log(
    `${label}: ${s.pattern ?? "-"} ${s.direction ?? "-"} state=${s.state} conf=${s.confirmation ?? "-"} entryKind=${s.entryKind ?? "-"} stoch=${s.stochAtSecond?.toFixed(1) ?? "-"} entry=${s.entry?.toFixed(2) ?? "-"} sl=${s.stopLoss?.toFixed(2) ?? "-"} tp=${s.takeProfit?.toFixed(2) ?? "-"}`,
  );
  console.log(`   detail: ${s.stateDetail}`);
  const watch = stochReversalWatchItem("TEST", "1h", s);
  const opp = stochReversalOpportunity("TEST", "1h", s);
  console.log(`   watch=${watch ? "yes" : "no"} opp=${opp ? `${opp.direction} score ${opp.score} rr ${opp.riskRewardRatio.toFixed(2)}` : "no"}`);
}

const { candles, marks } = build();
const st = stochasticK(candles);
console.log(`stoch at peak2 (idx 79): ${st[79]?.toFixed(1)}`);

console.log("--- double top (bearish) ---");
show("awaiting_confirmation", candles.slice(0, marks.awaiting));
show("armed", candles.slice(0, marks.armed));
show("gated retest (stoch not overbought => sell blocked, still armed)", candles.slice(0, marks.gated));
show("triggered (stoch overbought at retest)", candles.slice(0, marks.triggered));
show("completed", candles.slice(0, marks.completed));

// invalidation pre-entry: after the pattern forms, close above the stop level
const inval = candles.slice(0, marks.awaiting);
let px = inval[inval.length - 1].close;
for (let k = 0; k < 4; k++) {
  inval.push(c(200 + k, px, px + 1.2));
  px += 1.2;
}
show("invalidated (pre-confirmation stop-side close)", inval);

console.log("--- double bottom (bullish, mirrored) ---");
const m = mirror(candles);
show("awaiting_confirmation", m.slice(0, marks.awaiting));
show("armed", m.slice(0, marks.armed));
show("gated retest (stoch not oversold => buy blocked, still armed)", m.slice(0, marks.gated));
show("triggered (stoch oversold at retest)", m.slice(0, marks.triggered));
show("completed", m.slice(0, marks.completed));

console.log("--- breakout entry mode ---");
// in "both"/"breakout" mode the entry is the confirmation-bar close itself: the
// setup goes straight to triggered with the TP recomputed from that entry
show("breakout entry at confirmation close (both)", candles.slice(0, marks.armed), "both");
show("breakout entry at confirmation close (breakout)", candles.slice(0, marks.armed), "breakout");
show("breakout completed after TP", candles.slice(0, marks.completed), "both");
show("breakout entry, mirrored double bottom", m.slice(0, marks.armed), "both");
show("retest-only mode still waits for the retest", candles.slice(0, marks.armed), "retest");

console.log("--- engulfing trigger ---");
// bar 80 becomes a bearish engulfing candle (its body engulfs bar 79's
// 109.5 -> 110 body) right after the second top with the stochastic still
// overbought: outside retest mode that confirms the reversal and enters at
// its close, well before the neckline break
const eng = candles.slice(0, marks.awaiting).map((cd) => ({ ...cd }));
eng[80] = c(80, 110, 109.0);
show("engulfing entry right after the second top (both)", eng, "both");
show("engulfing entry (breakout mode)", eng, "breakout");
show("engulfing ignored in retest mode (still awaiting confirmation)", eng, "retest");
const engDone = [...eng];
let ep = engDone[engDone.length - 1].close;
for (let k = 0; k < 25; k++) {
  engDone.push(c(300 + k, ep, ep - 0.6));
  ep -= 0.6;
}
show("engulfing entry completed at TP", engDone, "both");
show("engulfing entry, mirrored double bottom", mirror(eng), "both");

// a later engulfing candle (5 bars after the second top) where the stochastic has
// already slipped off the extreme: the extreme was tagged at the pattern, so it
// still confirms — only the wrong-side case is blocked
const engLate = candles.slice(0, marks.awaiting).map((cd) => ({ ...cd }));
engLate[83] = c(83, 108.9, 109.3);
engLate[84] = c(84, 109.4, 108.6);
show("late engulfing after the stoch left the extreme (both)", engLate, "both");
show("late engulfing, mirrored double bottom", mirror(engLate), "both");

// an engulfing candle after price has dumped so hard the stochastic sits at the
// OPPOSITE extreme (oversold on a double top): wrong side — must not confirm
const engWrong = candles.slice(0, marks.awaiting).map((cd) => ({ ...cd }));
engWrong[81] = c(81, 109.7, 107);
engWrong[82] = c(82, 107, 105.4);
engWrong[83] = c(83, 105.4, 105.6);
engWrong[84] = c(84, 105.7, 105.2);
show("wrong-side engulfing (stoch dumped to oversold) rejected", engWrong, "both");

// a "double bottom" whose interim bounce is a full rally far above every high
// preceding the first low: the decline into the second touch is a fresh
// downtrend leg, not a W-retest — the neckline-within-structure check must
// reject it even though the level, reversal candle and oversold stoch all match
const wShape: Candle[] = [];
{
  let j = 0;
  // flat range ~100
  for (; j < 30; j++) wShape.push(c(j, 100, 100.2));
  // first low: distinct wick to 99.0
  wShape.push(c(j++, 100.2, 99.8, undefined, 99.0));
  for (; j < 40; j++) wShape.push(c(j, 100, 100.2));
  // huge rally 100 -> 120 — the interim "neckline" ends far above the range
  let p = 100.2;
  for (let k = 0; k < 20; k++, j++) {
    // distinct wick on the last rally bar so the top confirms as a swing high
    wShape.push(k === 19 ? c(j, p, p + 1, p + 2) : c(j, p, p + 1));
    p += 1;
  }
  // drift confirms the rally top as the interim swing high
  for (let k = 0; k < 5; k++, j++) {
    wShape.push(c(j, p, p - 0.4));
    p -= 0.4;
  }
  // fresh downtrend back to the old low's level
  for (let k = 0; k < 14; k++, j++) {
    wShape.push(c(j, p, p - 1.3));
    p -= 1.3;
  }
  // red bar tags the old low, then a bullish reversal candle with stoch oversold
  wShape.push(c(j++, p, p - 0.8, undefined, 98.9));
  p -= 0.8;
  wShape.push(c(j++, p, p + 1.0));
}
show("fresh downtrend re-tagging an old low (no W-shape) rejected", wShape, "both");
