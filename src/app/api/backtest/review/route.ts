import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAiConfigured, reviewBacktest } from "@/lib/ai/analyze";

export const runtime = "edge";

const tradeSchema = z.object({
  direction: z.enum(["long", "short"]),
  rMultiple: z.number(),
  exitReason: z.enum(["take_profit", "stop_loss", "time_exit", "end_of_data"]),
  holdBars: z.number(),
  score: z.number(),
  regime: z.enum(["trending_up", "trending_down", "ranging", "volatile"]).nullable(),
});

const regimeBucketSchema = z.object({
  regime: z.enum(["trending_up", "trending_down", "ranging", "volatile"]),
  trades: z.number(),
  wins: z.number(),
  winRate: z.number().nullable(),
  avgR: z.number().nullable(),
  totalR: z.number(),
  profitFactor: z.number().nullable(),
});

const schema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: z.string().max(5),
  config: z.object({
    strategyType: z.enum(["builtin", "custom"]),
    minScore: z.number(),
    direction: z.enum(["both", "long", "short"]),
    regimes: z.array(z.enum(["trending_up", "trending_down", "ranging", "volatile"])).max(4).nullable().optional(),
    maxHoldBars: z.number(),
    feePct: z.number(),
    slippagePct: z.number(),
    conditions: z.array(z.object({ label: z.string().max(60), weight: z.number() })).max(30).nullable(),
  }),
  metrics: z.object({
    barsTested: z.number(),
    totalTrades: z.number(),
    wins: z.number(),
    losses: z.number(),
    winRate: z.number().nullable(),
    avgR: z.number().nullable(),
    expectancyR: z.number().nullable(),
    totalR: z.number(),
    profitFactor: z.number().nullable(),
    maxDrawdownR: z.number(),
    avgHoldBars: z.number().nullable(),
  }),
  byRegime: z.array(regimeBucketSchema).max(4),
  trades: z.array(tradeSchema).max(120),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }

  const exitReasons: Record<string, { count: number; totalR: number }> = {};
  for (const t of parsed.data.trades) {
    const bucket = (exitReasons[t.exitReason] ??= { count: 0, totalR: 0 });
    bucket.count += 1;
    bucket.totalR += t.rMultiple;
  }

  try {
    const review = await reviewBacktest({ ...parsed.data, exitReasonBreakdown: exitReasons });
    return NextResponse.json({ review });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "AI review failed" }, { status: 502 });
  }
}
