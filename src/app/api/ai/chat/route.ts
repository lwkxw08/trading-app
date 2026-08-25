import { NextRequest, NextResponse } from "next/server";
import { chatOnAnalysis, isAiConfigured, type ChatTurn } from "@/lib/ai/analyze";
import { sanitizePatternMemory } from "@/lib/ai/memory";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "AI not configured: set ANTHROPIC_API_KEY" }, { status: 503 });
  }
  const body = (await req.json()) as { symbol?: string; tf?: string; messages?: ChatTurn[]; memory?: unknown };
  const symbol = body.symbol;
  const tf = (body.tf ?? "1h") as Timeframe;
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });

  const messages = (body.messages ?? [])
    .filter(
      (m): m is ChatTurn =>
        (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.length > 0,
    )
    .slice(-12);
  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return NextResponse.json({ error: "messages must end with a user question" }, { status: 400 });
  }

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles, events] = await Promise.all([
      provider.getCandles(symbol, tf, 500),
      provider.getCandles(symbol, htf, 300),
      getEconomicCalendar(),
    ]);
    const analysis = analyze(symbol, tf, candles, htfCandles, htf);
    const opportunities = scoreOpportunities(analysis, events);
    const reply = await chatOnAnalysis(analysis, opportunities, events, messages, sanitizePatternMemory(body.memory));
    return NextResponse.json({ reply });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI chat failed" }, { status: 502 });
  }
}
