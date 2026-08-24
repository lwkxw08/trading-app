import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generatePineScript } from "@/lib/pine/templates";

export const runtime = "edge";

const schema = z.object({
  kind: z.enum(["ema_cross", "rsi_reversal", "fvg_signals", "macd_momentum"]),
  name: z.string().min(1).max(60),
  fastLength: z.number().int().min(2).max(500).optional(),
  slowLength: z.number().int().min(3).max(500).optional(),
  rsiLength: z.number().int().min(2).max(100).optional(),
  rsiOversold: z.number().int().min(1).max(50).optional(),
  rsiOverbought: z.number().int().min(50).max(99).optional(),
  riskPercent: z.number().min(0.1).max(10).optional(),
  atrStopMultiplier: z.number().min(0.5).max(10).optional(),
  rewardMultiple: z.number().min(0.5).max(10).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  return NextResponse.json({ script: generatePineScript(parsed.data) });
}
