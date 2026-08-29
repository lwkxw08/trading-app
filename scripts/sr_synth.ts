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
