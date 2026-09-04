/**
 * Real-data sanity run for the POC AMD backtest. Run with: npx tsx scripts/poc_check.ts
 */
import { backtestPocAmd } from "../src/lib/strategies/pocAmd";
import type { Candle, Timeframe } from "../src/lib/market/types";

async function okx(symbol: string, bars: number): Promise<Candle[]> {
  const inst = symbol.replace("USDT", "-USDT");
  const out: Candle[] = [];
  let after = "";
  while (out.length < bars) {
    const url = `https://www.okx.com/api/v5/market/history-candles?instId=${inst}&bar=1H&limit=100${after ? `&after=${after}` : ""}`;
    const r = await fetch(url);
    const d = (await r.json()) as { data: string[][] };
    if (!d.data || d.data.length === 0) break;
    for (const row of d.data) {
      out.push({ time: Number(row[0]) / 1000, open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) });
    }
    after = d.data[d.data.length - 1][0];
  }
  return out.sort((a, b) => a.time - b.time);
}

async function main() {
  for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
    const candles = await okx(sym, 1500);
    const bt = backtestPocAmd(sym, "1h" as Timeframe, candles);
    console.log(
      `${sym} 1h bars=${bt.bars} boxes=${bt.boxes} breaks=${bt.breaks} filtered=${bt.filtered} noFill=${bt.noFill} trades=${bt.trades.length} winRate=${bt.winRatePct}% totalR=${bt.totalR} PF=${bt.profitFactor} maxDD=${bt.maxDrawdownR}`,
    );
    for (const t of bt.trades.slice(0, 5)) {
      console.log(`  ${t.direction} entry=${t.entry.toFixed(2)} sl=${t.stopLoss.toFixed(2)} tp=${t.takeProfit.toFixed(2)} exit=${t.exitReason} r=${t.rMultiple}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
