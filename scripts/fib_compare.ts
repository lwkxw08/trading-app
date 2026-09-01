/**
 * Head-to-head comparison: Trendline Break + Fib Retracement (reversal fib,
 * entry at the 0.618 pullback after a 3-touch trendline break) vs the classic
 * trend-CONTINUATION fib (impulse leg -> pull back into the 61.8% retracement
 * -> rejection candle -> continue with the trend, SL beyond the next fib
 * level 0.786, TP back at the swing extreme or the 1.272 extension).
 * Run with: npx tsx scripts/fib_compare.ts
 */
import { atr, ema } from "../src/lib/indicators/core";
import type { Candle, Timeframe } from "../src/lib/market/types";
import { detectSwings } from "../src/lib/strategies/detectors";
import { backtestTrendlineFib } from "../src/lib/strategies/trendlineFib";

const SWING_LOOKBACK = 5;
const MIN_LEG_ATR = 3;
const ZONE_TOL_ATR = 0.1;
const SL_BUFFER_ATR = 0.25;
const ENTRY_EXPIRY_BARS = 80;

interface ContTrade {
  direction: "bullish" | "bearish";
  entryTime: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  exitReason: "tp" | "sl" | "open";
  rMultiple: number;
}

interface ContResult {
  legs: number;
  noFill: number;
  trades: ContTrade[];
  wins: number;
  losses: number;
  winRatePct: number;
  totalR: number;
  avgR: number;
  profitFactor: number;
  maxDrawdownR: number;
}

/**
 * Classic continuation-fib backtest. `tpMode` "swing" targets the impulse
 * extreme (fib 0); "ext1272" targets the 1.272 extension of the leg.
 */
function backtestFibContinuation(candles: Candle[], tpMode: "swing" | "ext1272", trendFilter = false): ContResult {
  const n = candles.length;
  const atr14 = atr(candles, 14);
  const closes = candles.map((c) => c.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const swings = detectSwings(candles, SWING_LOOKBACK);

  const trades: ContTrade[] = [];
  let legs = 0;
  let noFill = 0;
  const takenLegKeys = new Set<string>();

  for (let s = 1; s < swings.length; s++) {
    const a = swings[s - 1];
    const b = swings[s];
    let bullish: boolean;
    if (a.type === "low" && b.type === "high" && b.price > a.price) bullish = true;
    else if (a.type === "high" && b.type === "low" && b.price < a.price) bullish = false;
    else continue;

    const extreme = b.price; // fib 0 (impulse end)
    const base = a.price; // fib 1 (impulse start)
    const range = Math.abs(extreme - base);
    const atrHere = atr14[b.index] ?? null;
    if (atrHere === null || range < MIN_LEG_ATR * atrHere) continue;

    if (trendFilter) {
      const e50 = ema50[b.index];
      const e200 = ema200[b.index];
      if (e50 === null || e200 === null) continue;
      if (bullish ? !(e50 > e200 && candles[b.index].close > e200) : !(e50 < e200 && candles[b.index].close < e200)) continue;
    }

    const key = `${a.index}-${b.index}`;
    if (takenLegKeys.has(key)) continue;
    takenLegKeys.add(key);
    legs++;

    const fib618 = bullish ? extreme - 0.618 * range : extreme + 0.618 * range;
    const fib786 = bullish ? extreme - 0.786 * range : extreme + 0.786 * range;
    const startIdx = b.index + SWING_LOOKBACK + 1; // pivot only confirmable here
    if (startIdx >= n) continue;

    let entryIdx = -1;
    let filled = false;
    for (let i = startIdx; i < n && i < startIdx + ENTRY_EXPIRY_BARS; i++) {
      const c = candles[i];
      // deeper retracement: close beyond the next fib level invalidates
      if (bullish ? c.close < fib786 : c.close > fib786) break;
      // ran off without pulling back far enough
      if (bullish ? c.close > extreme : c.close < extreme) break;
      const tol = ZONE_TOL_ATR * (atr14[i] ?? atrHere);
      const tagged = bullish ? c.low <= fib618 + tol : c.high >= fib618 - tol;
      const rejection = bullish
        ? c.close > c.open && c.close > fib618
        : c.close < c.open && c.close < fib618;
      if (tagged && rejection) {
        entryIdx = i;
        filled = true;
        break;
      }
    }
    if (!filled) {
      noFill++;
      continue;
    }

    const entryBar = candles[entryIdx];
    const entry = entryBar.close;
    const buf = SL_BUFFER_ATR * (atr14[entryIdx] ?? atrHere);
    const stopLoss = bullish ? fib786 - buf : fib786 + buf;
    const takeProfit =
      tpMode === "swing"
        ? extreme
        : bullish
          ? extreme + 0.272 * range
          : extreme - 0.272 * range;
    const risk = Math.abs(entry - stopLoss);
    if (risk <= 0 || (bullish ? takeProfit <= entry : takeProfit >= entry)) {
      noFill++;
      continue;
    }

    let exitReason: "tp" | "sl" | "open" = "open";
    let exitPrice = entry;
    for (let i = entryIdx + 1; i < n; i++) {
      const c = candles[i];
      const hitSl = bullish ? c.low <= stopLoss : c.high >= stopLoss;
      const hitTp = bullish ? c.high >= takeProfit : c.low <= takeProfit;
      if (hitSl) {
        // conservative: a bar spanning both counts as a stop
        exitReason = "sl";
        exitPrice = stopLoss;
        break;
      }
      if (hitTp) {
        exitReason = "tp";
        exitPrice = takeProfit;
        break;
      }
    }
    if (exitReason === "open") continue;

    const r = (bullish ? exitPrice - entry : entry - exitPrice) / risk;
    trades.push({
      direction: bullish ? "bullish" : "bearish",
      entryTime: entryBar.time,
      entry,
      stopLoss,
      takeProfit,
      exitReason,
      rMultiple: r,
    });
  }

  const wins = trades.filter((t) => t.rMultiple > 0).length;
  const losses = trades.length - wins;
  const totalR = trades.reduce((s2, t) => s2 + t.rMultiple, 0);
  const grossWin = trades.filter((t) => t.rMultiple > 0).reduce((s2, t) => s2 + t.rMultiple, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.rMultiple <= 0).reduce((s2, t) => s2 + t.rMultiple, 0));
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.rMultiple;
    peak = Math.max(peak, equity);
    maxDd = Math.max(maxDd, peak - equity);
  }
  return {
    legs,
    noFill,
    trades,
    wins,
    losses,
    winRatePct: trades.length ? (100 * wins) / trades.length : 0,
    totalR,
    avgR: trades.length ? totalR / trades.length : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    maxDrawdownR: maxDd,
  };
}

async function fetchMexc(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const interval = tf === "1h" ? "60m" : tf === "15m" ? "15m" : tf;
  const r = await fetch(`https://api.mexc.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const rows = (await r.json()) as [number, string, string, string, string, string][];
  if (!Array.isArray(rows)) throw new Error(`mexc fetch failed: ${JSON.stringify(rows).slice(0, 150)}`);
  return rows.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }));
}

async function fetchTwelve(symbol: string, tf: string, limit: number): Promise<Candle[]> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) throw new Error("TWELVEDATA_API_KEY not set");
  const interval = tf === "1h" ? "1h" : tf === "15m" ? "15min" : "5min";
  const r = await fetch(
    `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${limit}&apikey=${key}`,
  );
  const d = (await r.json()) as { values?: { datetime: string; open: string; high: string; low: string; close: string }[]; message?: string };
  if (!d.values) throw new Error(`twelvedata fetch failed: ${d.message ?? "no values"}`);
  return d.values
    .map((v) => ({
      time: Math.floor(Date.parse(v.datetime.replace(" ", "T") + "Z") / 1000),
      open: Number(v.open),
      high: Number(v.high),
      low: Number(v.low),
      close: Number(v.close),
      volume: 0,
    }))
    .sort((x, y) => x.time - y.time);
}

function fmt(x: number): string {
  return Number.isFinite(x) ? x.toFixed(2) : "inf";
}

async function main() {
  const targets: { symbol: string; tf: Timeframe; source: "mexc" | "twelve"; bars: number }[] = [
    { symbol: "BTCUSDT", tf: "1h", source: "mexc", bars: 1000 },
    { symbol: "ETHUSDT", tf: "1h", source: "mexc", bars: 1000 },
    { symbol: "BTCUSDT", tf: "15m", source: "mexc", bars: 1000 },
    { symbol: "GBP/JPY", tf: "1h", source: "twelve", bars: 3000 },
    { symbol: "GBP/JPY", tf: "15m", source: "twelve", bars: 3000 },
    { symbol: "GBP/JPY", tf: "5m", source: "twelve", bars: 3000 },
    { symbol: "EUR/USD", tf: "1h", source: "twelve", bars: 3000 },
  ];

  const rows: string[] = [];
  rows.push(
    ["market", "strategy", "trades", "win%", "totalR", "avgR", "PF", "maxDD-R", "no-fill"].join("\t"),
  );

  for (const t of targets) {
    let candles: Candle[];
    try {
      candles = t.source === "mexc" ? await fetchMexc(t.symbol, t.tf, t.bars) : await fetchTwelve(t.symbol, t.tf, t.bars);
    } catch (e) {
      console.error(`skip ${t.symbol} ${t.tf}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (candles.length < 300) {
      console.error(`skip ${t.symbol} ${t.tf}: only ${candles.length} bars`);
      continue;
    }
    const label = `${t.symbol} ${t.tf} (${candles.length} bars)`;

    const tlf = backtestTrendlineFib(t.symbol, t.tf, candles);
    rows.push(
      [label, "trendline-break fib (2.618)", tlf.trades.length, fmt(tlf.winRatePct), fmt(tlf.totalR), fmt(tlf.avgR), fmt(tlf.profitFactor), fmt(tlf.maxDrawdownR), tlf.noFill].join("\t"),
    );

    const contSwing = backtestFibContinuation(candles, "swing");
    rows.push(
      [label, "continuation fib (TP=swing)", contSwing.trades.length, fmt(contSwing.winRatePct), fmt(contSwing.totalR), fmt(contSwing.avgR), fmt(contSwing.profitFactor), fmt(contSwing.maxDrawdownR), contSwing.noFill].join("\t"),
    );

    const contExt = backtestFibContinuation(candles, "ext1272");
    rows.push(
      [label, "continuation fib (TP=1.272 ext)", contExt.trades.length, fmt(contExt.winRatePct), fmt(contExt.totalR), fmt(contExt.avgR), fmt(contExt.profitFactor), fmt(contExt.maxDrawdownR), contExt.noFill].join("\t"),
    );

    const contTrend = backtestFibContinuation(candles, "swing", true);
    rows.push(
      [label, "continuation fib (trend-filtered)", contTrend.trades.length, fmt(contTrend.winRatePct), fmt(contTrend.totalR), fmt(contTrend.avgR), fmt(contTrend.profitFactor), fmt(contTrend.maxDrawdownR), contTrend.noFill].join("\t"),
    );

    // small pause to respect Twelve Data rate limits
    if (t.source === "twelve") await new Promise((res) => setTimeout(res, 8000));
  }

  console.log(rows.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
