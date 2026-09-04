import { NextRequest, NextResponse } from "next/server";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { DEFAULT_POC_AMD_FILTERS, DEFAULT_POC_MAX_PULLBACK_BARS, DEFAULT_POC_RR_TARGET, detectPocAmdSetup } from "@/lib/strategies/pocAmd";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const tfParam = req.nextUrl.searchParams.get("tf") ?? "1h";
  const tf: Timeframe = (TIMEFRAMES as readonly string[]).includes(tfParam) ? (tfParam as Timeframe) : "1h";
  const rrParam = Number(req.nextUrl.searchParams.get("rr"));
  const rrTarget = Number.isFinite(rrParam) && rrParam > 0 ? rrParam : DEFAULT_POC_RR_TARGET;
  const maxWaitParam = Number(req.nextUrl.searchParams.get("maxwait"));
  const maxPullbackBars = Number.isInteger(maxWaitParam) && maxWaitParam >= 2 ? maxWaitParam : DEFAULT_POC_MAX_PULLBACK_BARS;

  try {
    const provider = getProviderForSymbol(symbol);
    const candles = await provider.getCandles(symbol, tf, 500);
    if (candles.length < 60) {
      return NextResponse.json({ error: "not enough data" }, { status: 502 });
    }
    const setup = detectPocAmdSetup(candles, rrTarget, DEFAULT_POC_AMD_FILTERS, maxPullbackBars);
    return NextResponse.json({ symbol: symbol.toUpperCase(), tf, setup });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "detection failed" }, { status: 502 });
  }
}
