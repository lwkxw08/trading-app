import { NextRequest, NextResponse } from "next/server";
import { isAiConfigured, suggestStopAdvice } from "@/lib/ai/analyze";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { suggestStopCandidates } from "@/lib/risk/stops";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as {
    symbol?: string;
    tf?: string;
    direction?: string;
    entry?: number;
    takeProfit?: number;
  };
  const symbol = body.symbol;
  const tf = (body.tf ?? "1h") as Timeframe;
  const direction = body.direction === "short" ? "short" : "long";
  const entry = Number(body.entry);
  const takeProfit = Number(body.takeProfit);
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(takeProfit) || takeProfit <= 0) {
    return NextResponse.json({ error: "entry and takeProfit must be positive numbers" }, { status: 400 });
  }

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles] = await Promise.all([
      provider.getCandles(symbol, tf, 500),
      provider.getCandles(symbol, htf, 300),
    ]);
    const analysis = analyze(symbol, tf, candles, htfCandles, htf);
    const candidates = suggestStopCandidates(analysis, direction, entry);
    if (candidates.length === 0) {
      return NextResponse.json({ candidates, advice: null, error: "No valid stop candidates for this entry" }, { status: 200 });
    }
    if (!isAiConfigured()) {
      return NextResponse.json({ candidates, advice: null, error: "AI not configured: set ANTHROPIC_API_KEY" }, { status: 200 });
    }
    const advice = await suggestStopAdvice(analysis, { direction, entry, takeProfit }, candidates);
    return NextResponse.json({ candidates, advice });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Stop suggestion failed" }, { status: 502 });
  }
}
