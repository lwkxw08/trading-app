import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { composeStrategy, isAiConfigured } from "@/lib/ai/analyze";

export const runtime = "edge";

const schema = z.object({
  description: z.string().min(10).max(2000),
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
    const strategy = await composeStrategy(parsed.data.description);
    return NextResponse.json({ strategy });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "composition failed" }, { status: 502 });
  }
}
