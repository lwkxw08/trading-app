import { NextRequest, NextResponse } from "next/server";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import { defaultUniverse, isMarket } from "@/lib/market/universe";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";
import type { Opportunity } from "@/lib/strategies/types";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const tf = (req.nextUrl.searchParams.get("tf") ?? "4h") as Timeframe;
  const symbolsParam = req.nextUrl.searchParams.get("symbols");
  const marketParam = req.nextUrl.searchParams.get("market");
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });

  const symbols = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20)
    : defaultUniverse(isMarket(marketParam) ? marketParam : "crypto");

  const events = await getEconomicCalendar();
  const htf = higherTimeframe(tf);

  const results = await Promise.allSettled(
    symbols.map(async (symbol): Promise<Opportunity[]> => {
      const provider = getProviderForSymbol(symbol);
      const [candles, htfCandles] = await Promise.all([
        provider.getCandles(symbol, tf, 500),
        provider.getCandles(symbol, htf, 300),
      ]);
      if (candles.length < 50) return [];
      return scoreOpportunities(analyze(symbol, tf, candles, htfCandles, htf), events);
    }),
  );

  const opportunities = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => b.score - a.score);
  const errors = results.filter((r) => r.status === "rejected").length;

  return NextResponse.json({ tf, scanned: symbols.length, errors, opportunities });
}
