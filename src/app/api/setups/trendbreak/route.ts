import { NextRequest, NextResponse } from "next/server";
import { getProviderForSymbol } from "@/lib/market/registry";
import { detectTrendBreakSetup } from "@/lib/strategies/trendBreak";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  try {
    const provider = getProviderForSymbol(symbol);
    const [htfCandles, ltfCandles] = await Promise.all([
      provider.getCandles(symbol, "15m", 500),
      provider.getCandles(symbol, "1m", 1000),
    ]);
    if (htfCandles.length < 60 || ltfCandles.length < 60) {
      return NextResponse.json({ error: "not enough data" }, { status: 502 });
    }
    const setup = detectTrendBreakSetup(htfCandles, ltfCandles);
    return NextResponse.json({ symbol: symbol.toUpperCase(), setup });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detection failed" }, { status: 502 });
  }
}
