import { NextRequest, NextResponse } from "next/server";
import { getExtendedHistory } from "@/lib/market/history";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

/**
 * Extended candle history (trading timeframe + its higher timeframe) for
 * client-side backtesting. Pure I/O — the simulation itself runs in the
 * browser, which keeps long backtests off the serverless CPU budget.
 */
export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  const tf = (req.nextUrl.searchParams.get("tf") ?? "1h") as Timeframe;
  const bars = Math.min(3000, Math.max(200, Number(req.nextUrl.searchParams.get("bars") ?? 1000)));
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });
  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles] = await Promise.all([
      getExtendedHistory(provider, symbol, tf, bars),
      getExtendedHistory(provider, symbol, htf, Math.min(bars, 1500)),
    ]);
    if (candles.length < 200) return NextResponse.json({ error: "not enough historical data" }, { status: 502 });
    return NextResponse.json({ symbol: symbol.toUpperCase(), tf, htf, candles, htfCandles });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "fetch failed" }, { status: 502 });
  }
}
