import { NextResponse } from "next/server";
import { generateBriefing, isAiConfigured } from "@/lib/ai/analyze";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import { defaultUniverse, isMarket } from "@/lib/market/universe";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";
import type { Opportunity } from "@/lib/strategies/types";

export const runtime = "edge";

export async function GET(req: Request) {
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "AI not configured: set ANTHROPIC_API_KEY" }, { status: 503 });
  }
  try {
    const params = new URL(req.url).searchParams;
    const marketParam = params.get("market");
    const market = isMarket(marketParam) ? marketParam : "crypto";
    // Non-crypto briefings use 3 symbols: 2 candle credits each + the quote
    // batch stays inside Twelve Data's free-tier 8 credits/min.
    const symbols = defaultUniverse(market).slice(0, market === "crypto" ? 6 : 3);
    const provider = getProviderForSymbol(symbols[0]);
    const tfParam = params.get("tf");
    const tf: Timeframe = TIMEFRAMES.includes(tfParam as Timeframe) ? (tfParam as Timeframe) : "4h";
    const htf = higherTimeframe(tf);
    const [tickers, events] = await Promise.all([provider.getTickers(symbols), getEconomicCalendar()]);

    const results = await Promise.allSettled(
      symbols.map(async (symbol): Promise<Opportunity[]> => {
        const [candles, htfCandles] = await Promise.all([
          provider.getCandles(symbol, tf, 500),
          provider.getCandles(symbol, htf, 300),
        ]);
        return scoreOpportunities(analyze(symbol, tf, candles, htfCandles, htf), events);
      }),
    );
    const opportunities = results
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .sort((a, b) => b.score - a.score);

    const briefing = await generateBriefing(tickers, opportunities, events);
    return NextResponse.json({ briefing });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "briefing failed" }, { status: 502 });
  }
}
