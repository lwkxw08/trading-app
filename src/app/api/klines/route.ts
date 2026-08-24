import { NextRequest, NextResponse } from "next/server";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  const tf = (req.nextUrl.searchParams.get("tf") ?? "1h") as Timeframe;
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? 500);
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });
  try {
    const candles = await getProviderForSymbol(symbol).getCandles(symbol, tf, limit);
    return NextResponse.json({ symbol, tf, candles });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "fetch failed" }, { status: 502 });
  }
}
