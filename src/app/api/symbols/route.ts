import { NextRequest, NextResponse } from "next/server";
import { isForexSymbol } from "@/lib/market/symbols";

export const runtime = "edge";

// Symbol search: crypto pairs from the exchange's traded list (cached per
// isolate), stocks/ETFs/forex via Twelve Data's symbol_search when a key is
// configured. Powers the type-ahead in symbol inputs.

export interface SymbolSuggestion {
  symbol: string;
  name: string;
  assetClass: "crypto" | "stocks" | "forex";
}

const BINANCE_HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];
const MEXC_HOST = "https://api.mexc.com";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

let cryptoCache: { symbols: string[]; at: number } | null = null;

async function fetchCryptoSymbols(): Promise<string[]> {
  if (cryptoCache && Date.now() - cryptoCache.at < CACHE_TTL_MS) return cryptoCache.symbols;
  for (const host of [...BINANCE_HOSTS, MEXC_HOST]) {
    try {
      const res = await fetch(`${host}/api/v3/ticker/price`, { next: { revalidate: 3600 } });
      if (!res.ok) continue;
      const data = (await res.json()) as { symbol: string }[];
      const symbols = data.map((d) => d.symbol).filter((s) => /USDT$|USDC$/.test(s));
      if (symbols.length > 0) {
        cryptoCache = { symbols, at: Date.now() };
        return symbols;
      }
    } catch {
      // try the next host
    }
  }
  return cryptoCache?.symbols ?? [];
}

function rankMatches(symbols: string[], q: string, limit: number): string[] {
  const starts: string[] = [];
  const contains: string[] = [];
  for (const s of symbols) {
    if (s.startsWith(q)) starts.push(s);
    else if (s.includes(q)) contains.push(s);
  }
  starts.sort((a, b) => a.length - b.length || a.localeCompare(b));
  contains.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return [...starts, ...contains].slice(0, limit);
}

interface TdMatch {
  symbol: string;
  instrument_name?: string;
  instrument_type?: string;
  exchange?: string;
}

async function searchTwelveData(q: string, limit: number): Promise<SymbolSuggestion[]> {
  const key = process.env.TWELVEDATA_API_KEY;
  if (!key) return [];
  try {
    const res = await fetch(
      `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(q)}&outputsize=${limit * 2}&apikey=${key}`,
      { next: { revalidate: 3600 } },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: TdMatch[] };
    const out: SymbolSuggestion[] = [];
    const seen = new Set<string>();
    for (const m of data.data ?? []) {
      const raw = m.symbol.toUpperCase();
      const type = (m.instrument_type ?? "").toLowerCase();
      const forex = type.includes("currency") || (raw.includes("/") && isForexSymbol(raw));
      if (type.includes("digital")) continue; // crypto comes from the exchange list
      const symbol = forex ? raw.replace("/", "") : raw;
      if (symbol.includes("/") || seen.has(symbol)) continue;
      seen.add(symbol);
      out.push({
        symbol,
        name: m.instrument_name ? `${m.instrument_name}${m.exchange ? ` · ${m.exchange}` : ""}` : (m.exchange ?? ""),
        assetClass: forex ? "forex" : "stocks",
      });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toUpperCase();
  if (q.length < 2) return NextResponse.json({ suggestions: [] });

  const [crypto, td] = await Promise.all([fetchCryptoSymbols(), searchTwelveData(q, 6)]);
  const cryptoMatches: SymbolSuggestion[] = rankMatches(crypto, q, 8).map((s) => ({
    symbol: s,
    name: "",
    assetClass: "crypto" as const,
  }));

  return NextResponse.json({ suggestions: [...cryptoMatches, ...td].slice(0, 12) });
}
