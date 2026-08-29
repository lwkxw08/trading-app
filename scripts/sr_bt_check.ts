import { backtestStochReversal, DEFAULT_STOCH_REVERSAL_FILTERS, type StochReversalEntryMode, type StochReversalFilters } from "../src/lib/strategies/stochReversal";
import { generatePineScript } from "../src/lib/pine/templates";
import type { Candle, Timeframe } from "../src/lib/market/types";

async function fetchKlines(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const r = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${tf === "1h" ? "60m" : tf}&limit=${limit}`);
  const rows = (await r.json()) as [number, string, string, string, string, string][];
  if (!Array.isArray(rows)) throw new Error(`klines fetch failed: ${JSON.stringify(rows).slice(0, 200)}`);
  return rows.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

async function main() {
  // Pine generation checks
  const pine = generatePineScript({ kind: "stoch_reversal", name: "Stoch DT/DB Test", riskPercent: 1, rewardMultiple: 1.5 });
  const mustContain = [
    "//@version=6",
    "ta.stoch(close, high, low, stochLen)",
    "obLevel",
    "osLevel",
    "pivotLen",
    "neckLow",
    "neckHigh",
    "alertcondition(buySignal",
    "alertcondition(sellSignal",
    "alertcondition(patternFormed",
    "alertcondition(confirmed",
    "posSize",
    "table.new",
    "plotshape(buySignal",
    "plotshape(sellSignal",
    "[v10]",
    "divTolerance",
    "stochWindow",
    "wrongSide",
    "maxConsumed",
    "spentLevel",
    "entryMode",
    "\"retest\", \"breakout\", \"both\"",
    "strictGate",
    "useTrendLeg",
    "useDivergence",
    "breakMarginAtr",
    "measured",
    "ranTooFar",
    "useEngulf",
    "engulfWindow",
    "bullEngulf",
    "bearEngulf",
    "kAtExtreme",
  ];
  const missing = mustContain.filter((s) => !pine.includes(s));
  console.log("pine length:", pine.length, "missing tokens:", missing.length ? missing : "none");
  if (missing.length) process.exit(1);
  // rough indentation sanity: no tabs, consistent 4-space blocks
  if (pine.includes("\t")) throw new Error("pine contains tabs");

  for (const [sym, tf, bars] of [
    ["BTCUSDT", "1h", 1500],
    ["ETHUSDT", "1h", 1500],
    ["SOLUSDT", "15m", 1000],
    ["BTCUSDT", "4h", 1000],
  ] as [string, Timeframe, number][]) {
    const candles = await fetchKlines(sym, tf, Math.min(1000, bars));
    const looseFilters: StochReversalFilters = { trendFilter: false, divergenceFilter: false, decisiveBreak: false };
    for (const [mode, filters, label] of [
      ["both", DEFAULT_STOCH_REVERSAL_FILTERS, "both+filters"],
      ["retest", DEFAULT_STOCH_REVERSAL_FILTERS, "retest+filters"],
      ["breakout", DEFAULT_STOCH_REVERSAL_FILTERS, "breakout+filters"],
      ["both", looseFilters, "both, filters off"],
    ] as [StochReversalEntryMode, StochReversalFilters, string][]) {
      const bt = backtestStochReversal(sym, tf, candles, mode, filters);
      console.log(
        `${sym} ${tf} [${label}]: bars=${bt.bars} patterns=${bt.patterns} trades=${bt.trades.length} unconfirmed=${bt.unconfirmed} missed=${bt.missed} open=${bt.openAtEnd} win%=${bt.winRatePct} totalR=${bt.totalR} avgR=${bt.avgR} PF=${bt.profitFactor} maxDD=${bt.maxDrawdownR}`,
      );
      for (const t of bt.trades) {
        // invariants
        const risk = Math.abs(t.entry - t.stopLoss);
        const reward = Math.abs(t.takeProfit - t.entry);
        if (reward / risk < 1.49) throw new Error("RR below minimum");
        if (t.entryTime >= t.exitTime) throw new Error("exit not after entry");
        if (t.confirmationTime > t.entryTime) throw new Error("entry before confirmation");
        if (t.secondExtremeTime >= t.confirmationTime) throw new Error("confirmation before pattern");
        if (mode === "retest" && t.entryKind !== "retest") throw new Error("retest mode produced a non-retest entry");
        if (mode === "breakout" && t.entryKind === "retest") throw new Error("breakout mode produced a retest entry");
        if (t.entryKind === "breakout" && t.entryTime !== t.confirmationTime) throw new Error("breakout entry not at confirmation bar");
        if (t.entryKind === "engulfing" && t.confirmation !== "engulfing") throw new Error("engulfing entry without engulfing confirmation");
        if (t.entryKind === "engulfing" && t.entryTime < t.confirmationTime) throw new Error("engulfing entry before the engulfing bar");
      }
      // equity curve monotonic bookkeeping
      if (bt.equityR.length !== bt.trades.length) throw new Error("equity length mismatch");
    }
  }
  console.log("all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
