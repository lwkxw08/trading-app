import { NextRequest, NextResponse } from "next/server";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  const tf = (req.nextUrl.searchParams.get("tf") ?? "1h") as Timeframe;
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles, events] = await Promise.all([
      provider.getCandles(symbol, tf, 500),
      provider.getCandles(symbol, htf, 300),
      getEconomicCalendar(),
    ]);
    if (candles.length < 50) return NextResponse.json({ error: "not enough data" }, { status: 502 });

    const analysis = analyze(symbol, tf, candles, htfCandles, htf);
    const opportunities = scoreOpportunities(analysis, events);

    // Strip the raw candle array from the analysis payload (client fetches
    // klines separately for charting).
    const { candles: _candles, ...rest } = analysis;
    return NextResponse.json({ analysis: rest, opportunities });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "analysis failed" }, { status: 502 });
  }
}
