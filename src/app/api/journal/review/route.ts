import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAiConfigured, reviewJournal } from "@/lib/ai/analyze";

export const runtime = "edge";

const factorSchema = z.object({
  name: z.string().max(60),
  weight: z.number(),
  detail: z.string().max(200).optional(),
});

const tradeSchema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: z.string().max(8),
  direction: z.enum(["long", "short"]),
  status: z.enum(["open", "closed"]),
  entryPrice: z.number().positive(),
  entryTime: z.number(),
  size: z.number().positive().nullable(),
  stopLoss: z.number().positive().nullable(),
  takeProfit: z.number().positive().nullable(),
  strategyName: z.string().max(60),
  notes: z.string().max(1000),
  snapshot: z
    .object({
      trendDirection: z.string().max(20),
      htfDirection: z.string().max(20).optional(),
      rsi14: z.number().nullable(),
      confluenceScore: z.number().nullable(),
      factors: z.array(factorSchema).max(20),
    })
    .nullable(),
  exitPrice: z.number().positive().nullable(),
  exitTime: z.number().nullable(),
  exitNotes: z.string().max(1000),
  rMultiple: z.number().nullable(),
});

const schema = z.object({
  trades: z.array(tradeSchema).min(1).max(200),
  stats: z.unknown(),
});

export async function POST(req: NextRequest) {
  if (!isAiConfigured()) {
    return NextResponse.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 503 });
  }
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  try {
    const review = await reviewJournal(parsed.data);
    return NextResponse.json({ review });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "review failed" }, { status: 502 });
  }
}
