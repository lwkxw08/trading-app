/**
 * Diagnose trendline-fib winners vs losers: replay SOLUSDT/ETHUSDT 1h,
 * dump per-trade context features (break impulse, momentum, volume, trend
 * alignment) to find what separates winning breaks from losing ones.
 * Run with: npx tsx scripts/tlf_winloss.ts
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { atr, ema, rsi } from "../src/lib/indicators/core";
import type { Candle } from "../src/lib/market/types";
import { backtestTrendlineFib, type TrendlineFibTrade } from "../src/lib/strategies/trendlineFib";

async function fetchOkx(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const instId = symbol.replace("USDT", "-USDT");
  const bar = tf === "1h" ? "1H" : tf;
  const all: Candle[] = [];
  let after: string | undefined;
  while (all.length < limit) {
    const url =
      `https://www.okx.com/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100` +
      (after !== undefined ? `&after=${after}` : "");
    const r = await fetch(url);
    const d = (await r.json()) as { code: string; data?: string[][] };
    if (d.code !== "0" || !d.data) throw new Error(`okx fetch failed: ${JSON.stringify(d).slice(0, 150)}`);
    if (d.data.length === 0) break;
    // newest first; only confirmed candles (last field "1")
    const rows = d.data.filter((k) => k[8] === "1");
    const candles = rows.map((k) => ({
      time: Math.floor(Number(k[0]) / 1000),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }));
    all.push(...candles);
    after = d.data[d.data.length - 1][0];
    await new Promise((res) => setTimeout(res, 150));
  }
  return all.sort((x, y) => x.time - y.time);
}

interface Feat {
  symbol: string;
  t: TrendlineFibTrade;
  bodyAtr: number; // anchor candle body in ATRs
  bodyRatio: number; // body / range
  fibRangeAtr: number; // fib 0->1 leg in ATRs (break impulse size)
  rsiAnchor: number;
  volRatio: number; // anchor volume vs 20-bar avg
  runBars: number; // consecutive directional closes ending at anchor
  runAtr: number; // net move of that run in ATRs
  emaAligned: boolean; // ema50 vs ema200 agrees with trade direction
  vsEma200: boolean; // close on trade side of ema200
  fillDelayBars: number; // bars from anchor to entry fill
  riskAtr: number; // entry-SL distance in ATRs
}

function features(symbol: string, candles: Candle[], trades: TrendlineFibTrade[]): Feat[] {
  const atr14 = atr(candles, 14);
  const closes = candles.map((c) => c.close);
  const rsi14 = rsi(closes, 14);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const idxByTime = new Map(candles.map((c, i) => [c.time, i]));
  const out: Feat[] = [];
  for (const t of trades) {
    const a = idxByTime.get(t.breakTime);
    const e = idxByTime.get(t.entryTime);
    if (a === undefined || e === undefined) continue;
    const c = candles[a];
    const atrA = atr14[a] ?? c.close * 0.01;
    const bullish = t.direction === "bullish";
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    let volSum = 0;
    let volN = 0;
    for (let i = Math.max(0, a - 20); i < a; i++) {
      volSum += candles[i].volume;
      volN++;
    }
    let runBars = 0;
    for (let i = a; i >= 0; i--) {
      const d = candles[i].close > candles[i].open;
      if (bullish ? d : !d) runBars++;
      else break;
    }
    const runStart = candles[a - runBars + 1];
    const e50 = ema50[a];
    const e200 = ema200[a];
    out.push({
      symbol,
      t,
      bodyAtr: body / atrA,
      bodyRatio: range > 0 ? body / range : 0,
      fibRangeAtr: Math.abs(t.fibOne - t.swingPrice) / atrA,
      rsiAnchor: rsi14[a] ?? 50,
      volRatio: volN > 0 && volSum > 0 ? c.volume / (volSum / volN) : 1,
      runBars,
      runAtr: Math.abs(c.close - runStart.open) / atrA,
      emaAligned: e50 !== null && e200 !== null && (bullish ? e50 > e200 : e50 < e200),
      vsEma200: e200 !== null && (bullish ? c.close > e200 : c.close < e200),
      fillDelayBars: e - a,
      riskAtr: Math.abs(t.entry - t.stopLoss) / atrA,
    });
  }
  return out;
}

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const all: Feat[] = [];
  for (const symbol of ["SOLUSDT", "ETHUSDT", "BTCUSDT", "XRPUSDT", "LINKUSDT", "ADAUSDT"]) {
    const cache = `/tmp/okx_${symbol}_1h.json`;
    let candles: Candle[];
    if (existsSync(cache)) {
      candles = JSON.parse(readFileSync(cache, "utf8")) as Candle[];
    } else {
      candles = await fetchOkx(symbol, "1h", 3000);
      writeFileSync(cache, JSON.stringify(candles));
    }
    const r = backtestTrendlineFib(symbol, "1h", candles);
    const feats = features(symbol, candles, r.trades);
    all.push(...feats);
    console.log(`\n=== ${symbol} 1h (${candles.length} bars): ${r.trades.length} trades, ${r.wins}W/${r.losses}L, totalR ${r.totalR}`);
    for (const f of feats) {
      const w = f.t.rMultiple > 0 ? "WIN " : "LOSS";
      console.log(
        `${w} ${f.t.direction === "bullish" ? "BUY " : "SELL"} anchor=${fmtTime(f.t.breakTime)} R=${f.t.rMultiple}` +
          ` | bodyATR=${f.bodyAtr.toFixed(2)} bodyRatio=${f.bodyRatio.toFixed(2)} fibRangeATR=${f.fibRangeAtr.toFixed(2)}` +
          ` rsi=${f.rsiAnchor.toFixed(0)} vol=${f.volRatio.toFixed(2)}x run=${f.runBars}b/${f.runAtr.toFixed(2)}ATR` +
          ` ema50v200=${f.emaAligned ? "Y" : "n"} vs200=${f.vsEma200 ? "Y" : "n"} fill+${f.fillDelayBars}b riskATR=${f.riskAtr.toFixed(2)}`,
      );
    }
  }

  const wins = all.filter((f) => f.t.rMultiple > 0);
  const losses = all.filter((f) => f.t.rMultiple <= 0);
  const avg = (xs: Feat[], sel: (f: Feat) => number) => (xs.length ? xs.reduce((s, f) => s + sel(f), 0) / xs.length : 0);
  const pct = (xs: Feat[], sel: (f: Feat) => boolean) => (xs.length ? (100 * xs.filter(sel).length) / xs.length : 0);
  console.log(`\n=== AGGREGATE: ${wins.length} wins vs ${losses.length} losses`);
  const rows: [string, (f: Feat) => number][] = [
    ["bodyAtr", (f) => f.bodyAtr],
    ["bodyRatio", (f) => f.bodyRatio],
    ["fibRangeAtr", (f) => f.fibRangeAtr],
    ["rsiAnchor", (f) => f.rsiAnchor],
    ["volRatio", (f) => f.volRatio],
    ["runBars", (f) => f.runBars],
    ["runAtr", (f) => f.runAtr],
    ["fillDelayBars", (f) => f.fillDelayBars],
    ["riskAtr", (f) => f.riskAtr],
  ];
  for (const [name, sel] of rows) {
    console.log(`${name.padEnd(14)} wins avg=${avg(wins, sel).toFixed(2)}  losses avg=${avg(losses, sel).toFixed(2)}`);
  }
  console.log(`emaAligned     wins=${pct(wins, (f) => f.emaAligned).toFixed(0)}%  losses=${pct(losses, (f) => f.emaAligned).toFixed(0)}%`);
  console.log(`vsEma200       wins=${pct(wins, (f) => f.vsEma200).toFixed(0)}%  losses=${pct(losses, (f) => f.vsEma200).toFixed(0)}%`);

  // candidate filter scan: for each threshold, R kept vs dropped
  console.log("\n=== FILTER CANDIDATES (kept trades R / dropped trades R)");
  const scan = (name: string, keep: (f: Feat) => boolean) => {
    const kept = all.filter(keep);
    const dropped = all.filter((f) => !keep(f));
    const rSum = (xs: Feat[]) => xs.reduce((s, f) => s + f.t.rMultiple, 0);
    console.log(
      `${name.padEnd(30)} keep ${kept.length} trades R=${rSum(kept).toFixed(1)} | drop ${dropped.length} trades R=${rSum(dropped).toFixed(1)}`,
    );
  };
  for (const th of [0.8, 1.0, 1.2, 1.5]) scan(`bodyAtr >= ${th}`, (f) => f.bodyAtr >= th);
  for (const th of [1.5, 2, 2.5, 3]) scan(`fibRangeAtr >= ${th}`, (f) => f.fibRangeAtr >= th);
  for (const th of [55, 60]) scan(`rsi beyond ${th}`, (f) => (f.t.direction === "bullish" ? f.rsiAnchor >= th : f.rsiAnchor <= 100 - th));
  for (const th of [1.2, 1.5, 2]) scan(`volRatio >= ${th}`, (f) => f.volRatio >= th);
  scan("emaAligned", (f) => f.emaAligned);
  scan("vsEma200", (f) => f.vsEma200);
  for (const th of [1, 1.5, 2]) scan(`runAtr >= ${th}`, (f) => f.runAtr >= th);

  console.log("\n=== COMBOS");
  scan("fibRange>=2.5 & vol>=1.2", (f) => f.fibRangeAtr >= 2.5 && f.volRatio >= 1.2);
  scan("fibRange>=2.5 & vol>=1.5", (f) => f.fibRangeAtr >= 2.5 && f.volRatio >= 1.5);
  scan("fibRange>=3 & vol>=1.2", (f) => f.fibRangeAtr >= 3 && f.volRatio >= 1.2);
  scan("fibRange>=2.5 & vsEma200", (f) => f.fibRangeAtr >= 2.5 && f.vsEma200);
  scan("fibRange>=2.5 & vol>=1.2 & vs200", (f) => f.fibRangeAtr >= 2.5 && f.volRatio >= 1.2 && f.vsEma200);
  scan("fibRange>=2 & vol>=1.2", (f) => f.fibRangeAtr >= 2 && f.volRatio >= 1.2);

  const perSymbol = (name: string, keepFn: (f: Feat) => boolean) => {
    console.log(`\n=== PER-SYMBOL: ${name}`);
    for (const sym of [...new Set(all.map((f) => f.symbol))]) {
      const s = all.filter((f) => f.symbol === sym);
      const keep = s.filter(keepFn);
      const drop = s.filter((f) => !keepFn(f));
      const rSum = (xs: Feat[]) => xs.reduce((acc, f) => acc + f.t.rMultiple, 0);
      const w = (xs: Feat[]) => xs.filter((f) => f.t.rMultiple > 0).length;
      console.log(
        `${sym.padEnd(9)} keep ${keep.length} (${w(keep)}W) R=${rSum(keep).toFixed(1)} | drop ${drop.length} (${w(drop)}W) R=${rSum(drop).toFixed(1)}`,
      );
    }
  };
  perSymbol("fibRange>=2.5 & vol>=1.2", (f) => f.fibRangeAtr >= 2.5 && f.volRatio >= 1.2);
  perSymbol("fibRangeAtr >= 2.5", (f) => f.fibRangeAtr >= 2.5);
  perSymbol("fibRangeAtr >= 3", (f) => f.fibRangeAtr >= 3);
  perSymbol("volRatio >= 1.2", (f) => f.volRatio >= 1.2);
  perSymbol("fibRange>=2 & vol>=1.2", (f) => f.fibRangeAtr >= 2 && f.volRatio >= 1.2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
