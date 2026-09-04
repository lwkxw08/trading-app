import { NextRequest, NextResponse } from "next/server";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { detectStochReversalSetup } from "@/lib/strategies/stochReversal";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const tfParam = req.nextUrl.searchParams.get("tf") ?? "1h";
  const tf: Timeframe = (TIMEFRAMES as readonly string[]).includes(tfParam) ? (tfParam as Timeframe) : "1h";

  try {
    const provider = getProviderForSymbol(symbol);
    const candles = await provider.getCandles(symbol, tf, 500);
    if (candles.length < 80) {
      return NextResponse.json({ error: "not enough data" }, { status: 502 });
    }
    const setup = detectStochReversalSetup(candles);
    return NextResponse.json({ symbol: symbol.toUpperCase(), tf, setup });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detection failed" }, { status: 502 });
  }
}
