import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_CRYPTO_UNIVERSE } from "@/lib/market/binance";
import { availableAssetClasses, getProviderForSymbol } from "@/lib/market/registry";

export const runtime = "edge";

export async function GET(req: NextRequest) {
  const symbolsParam = req.nextUrl.searchParams.get("symbols");
  const symbols = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 30)
    : DEFAULT_CRYPTO_UNIVERSE.map((c) => c.symbol);
  try {
    const tickers = await getProviderForSymbol(symbols[0]).getTickers(symbols);
    return NextResponse.json({ tickers, assetClasses: availableAssetClasses() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "fetch failed" }, { status: 502 });
  }
}
