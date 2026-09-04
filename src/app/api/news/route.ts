import { NextRequest, NextResponse } from "next/server";
import { getHeadlines } from "@/lib/news/provider";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
  const headlines = await getHeadlines(symbol.toUpperCase());
  return NextResponse.json({ headlines });
}
