import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { generateCustomPineScript } from "@/lib/pine/custom";
import { customStrategySchema } from "@/lib/strategies/customSchema";

export const runtime = "edge";

const schema = z.object({ strategy: customStrategySchema });

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  return NextResponse.json({ script: generateCustomPineScript(parsed.data.strategy) });
}
