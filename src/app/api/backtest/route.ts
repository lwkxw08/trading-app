import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runBacktest } from "@/lib/backtest/engine";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { higherTimeframe } from "@/lib/strategies/engine";
import { customStrategySchema } from "@/lib/strategies/customSchema";

export const runtime = "edge";

const schema = z.object({
  symbol: z.string().min(1).max(20),
  tf: z.enum(TIMEFRAMES as unknown as [string, ...string[]]).transform((v) => v as Timeframe),
  strategyType: z.enum(["builtin", "custom"]),
  custom: customStrategySchema.nullable().optional(),
  minScore: z.number().min(0).max(100).default(55),
  direction: z.enum(["both", "long", "short"]).default("both"),
  maxHoldBars: z.number().int().min(5).max(500).default(100),
  bars: z.number().int().min(200).max(1000).default(1000),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { symbol, tf, strategyType, custom, minScore, direction, maxHoldBars, bars } = parsed.data;
  if (strategyType === "custom" && !custom) {
    return NextResponse.json({ error: "custom strategy required when strategyType is custom" }, { status: 400 });
  }

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles] = await Promise.all([
      provider.getCandles(symbol, tf, bars),
      provider.getCandles(symbol, htf, 1000),
    ]);
    if (candles.length < 200) return NextResponse.json({ error: "not enough historical data" }, { status: 502 });

    const result = runBacktest(symbol.toUpperCase(), tf, candles, htfCandles, htf, {
      strategyType,
      custom: custom ?? null,
      minScore,
      direction,
      maxHoldBars,
    });
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "backtest failed" }, { status: 502 });
  }
}
