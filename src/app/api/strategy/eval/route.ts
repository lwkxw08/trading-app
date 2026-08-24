import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { evaluateCustomStrategy } from "@/lib/strategies/custom";
import { customStrategySchema } from "@/lib/strategies/customSchema";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

const schema = z.object({
  symbol: z.string().min(1).max(20),
  tf: z.enum(TIMEFRAMES as unknown as [string, ...string[]]).transform((v) => v as Timeframe),
  strategy: customStrategySchema,
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { symbol, tf, strategy } = parsed.data;

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles] = await Promise.all([
      provider.getCandles(symbol, tf, 500),
      provider.getCandles(symbol, htf, 300),
    ]);
    if (candles.length < 50) return NextResponse.json({ error: "not enough data" }, { status: 502 });

    const analysis = analyze(symbol, tf, candles, htfCandles, htf);
    const evaluations = evaluateCustomStrategy(analysis, strategy);
    return NextResponse.json({ evaluations, lastPrice: analysis.lastPrice });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "evaluation failed" }, { status: 502 });
  }
}
