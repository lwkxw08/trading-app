import { NextRequest, NextResponse } from "next/server";
import { generateAnalysis, isAiConfigured } from "@/lib/ai/analyze";
import { sanitizePatternMemory } from "@/lib/ai/memory";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getHeadlines } from "@/lib/news/provider";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "AI not configured: set ANTHROPIC_API_KEY" }, { status: 503 });
  }
  const body = (await req.json()) as { symbol?: string; tf?: string; memory?: unknown };
  const symbol = body.symbol;
  const tf = (body.tf ?? "1h") as Timeframe;
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles, events, headlines] = await Promise.all([
      provider.getCandles(symbol, tf, 500),
      provider.getCandles(symbol, htf, 300),
      getEconomicCalendar(),
      getHeadlines(symbol),
    ]);
    const analysis = analyze(symbol, tf, candles, htfCandles, htf);
    const opportunities = scoreOpportunities(analysis, events);
    const memory = sanitizePatternMemory(body.memory);
    const ai = await generateAnalysis(analysis, opportunities, events, memory, headlines);
    return NextResponse.json({ ai });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI analysis failed" }, { status: 502 });
  }
}
