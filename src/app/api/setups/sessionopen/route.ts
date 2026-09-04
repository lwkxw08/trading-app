import { NextRequest, NextResponse } from "next/server";
import { getProviderForSymbol } from "@/lib/market/registry";
import { detectSessionOpenSetup } from "@/lib/strategies/sessionOpen";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  try {
    const provider = getProviderForSymbol(symbol);
    const candles = await provider.getCandles(symbol, "5m", 1000);
    if (candles.length < 30) {
      return NextResponse.json({ error: "not enough data" }, { status: 502 });
    }
    const setup = detectSessionOpenSetup(symbol, candles);
    return NextResponse.json({ symbol: symbol.toUpperCase(), setup });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detection failed" }, { status: 502 });
  }
}
