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
    // Symbols can mix providers (crypto + stocks/forex) — group per provider.
    const groups = new Map<ReturnType<typeof getProviderForSymbol>, string[]>();
    for (const symbol of symbols) {
      const provider = getProviderForSymbol(symbol);
      groups.set(provider, [...(groups.get(provider) ?? []), symbol]);
    }
    const results = await Promise.all([...groups.entries()].map(([provider, syms]) => provider.getTickers(syms)));
    const bySymbol = new Map(results.flat().map((t) => [t.symbol, t]));
    const tickers = symbols.flatMap((s) => (bySymbol.has(s) ? [bySymbol.get(s)!] : []));
    return NextResponse.json({ tickers, assetClasses: availableAssetClasses() });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "fetch failed" }, { status: 502 });
  }
}
