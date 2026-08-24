import { NextResponse } from "next/server";
import { generateBriefing, isAiConfigured } from "@/lib/ai/analyze";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { DEFAULT_CRYPTO_UNIVERSE } from "@/lib/market/binance";
import { getProviderForSymbol } from "@/lib/market/registry";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";
import type { Opportunity } from "@/lib/strategies/types";

export const runtime = "edge";

export async function GET() {
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "AI not configured: set ANTHROPIC_API_KEY" }, { status: 503 });
  }
  try {
    const symbols = DEFAULT_CRYPTO_UNIVERSE.slice(0, 6).map((c) => c.symbol);
    const provider = getProviderForSymbol(symbols[0]);
    const tf = "4h" as const;
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
