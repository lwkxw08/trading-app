import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { runBacktest, runBacktestSweep, runWalkForward } from "@/lib/backtest/engine";
import { getExtendedHistory } from "@/lib/market/history";
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
  bars: z.number().int().min(200).max(3000).default(1000),
  feePct: z.number().min(0).max(1).default(0),
  slippagePct: z.number().min(0).max(1).default(0),
  sweep: z.boolean().default(false),
  walkforward: z.boolean().default(false),
  folds: z.number().int().min(2).max(8).default(4),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { symbol, tf, strategyType, custom, minScore, direction, maxHoldBars, bars, feePct, slippagePct, sweep, walkforward, folds } = parsed.data;
  if (strategyType === "custom" && !custom) {
    return NextResponse.json({ error: "custom strategy required when strategyType is custom" }, { status: 400 });
  }
  if ((sweep || walkforward) && strategyType !== "builtin") {
    return NextResponse.json({ error: "sweep and walk-forward only support the built-in strategy" }, { status: 400 });
  }

  try {
    const provider = getProviderForSymbol(symbol);
    const htf = higherTimeframe(tf);
    const [candles, htfCandles] = await Promise.all([
      getExtendedHistory(provider, symbol, tf, bars),
      getExtendedHistory(provider, symbol, htf, Math.min(bars, 1500)),
    ]);
    if (candles.length < 200) return NextResponse.json({ error: "not enough historical data" }, { status: 502 });

    const config = {
      strategyType,
      custom: custom ?? null,
      minScore,
      direction,
      maxHoldBars,
      feePct,
      slippagePct,
    };
    const thresholds = [45, 50, 55, 60, 65, 70, 75, 80];
    if (walkforward) {
      const wf = runWalkForward(symbol.toUpperCase(), tf, candles, htfCandles, htf, config, folds, thresholds);
      return NextResponse.json({ walkforward: wf });
    }
    if (sweep) {
      const points = runBacktestSweep(symbol.toUpperCase(), tf, candles, htfCandles, htf, config, thresholds);
      return NextResponse.json({ sweep: points });
    }
    const result = runBacktest(symbol.toUpperCase(), tf, candles, htfCandles, htf, config);
    return NextResponse.json({ result });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "backtest failed" }, { status: 502 });
  }
}
