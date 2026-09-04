import { assetClassForSymbol } from "@/lib/market/symbols";
import type { JournalTrade } from "@/lib/journal/types";

/**
 * Approximate correlation intelligence for open journal positions. Uses
 * well-known structural relationships (USD legs in forex pairs, crypto's
 * BTC beta, index-ETF overlap) rather than live covariance — advisory only.
 */

export interface CorrelationWarning {
  severity: "high" | "medium";
  group: string;
  symbols: string[];
  message: string;
}

interface Exposure {
  group: string;
  groupLabel: string;
  /** +1 if a long position is long the group driver, -1 if short of it */
  sign: 1 | -1;
}

const INDEX_ETFS = new Set(["SPY", "QQQ", "DIA", "IWM", "VOO", "IVV", "VTI"]);
const QQQ_HEAVY = new Set(["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO"]);
const METALS = new Set(["XAUUSD", "XAGUSD", "GLD", "SLV"]);

function exposuresForSymbol(symbol: string): Exposure[] {
  const s = symbol.toUpperCase().replace("/", "");
  const cls = assetClassForSymbol(s);
  const out: Exposure[] = [];

  if (cls === "crypto") {
    // Alts trade with heavy BTC beta; treat all crypto longs as one risk block.
    out.push({ group: "crypto", groupLabel: "Crypto (BTC beta)", sign: 1 });
    return out;
  }
  if (cls === "forex" && s.length >= 6) {
    const base = s.slice(0, 3);
    const quote = s.slice(3, 6);
    // Long the pair = long base currency, short quote currency.
    out.push({ group: `ccy:${base}`, groupLabel: `${base} exposure`, sign: 1 });
    out.push({ group: `ccy:${quote}`, groupLabel: `${quote} exposure`, sign: -1 });
    return out;
  }
  if (METALS.has(s)) {
    out.push({ group: "metals", groupLabel: "Precious metals", sign: 1 });
    return out;
  }
  if (INDEX_ETFS.has(s) || QQQ_HEAVY.has(s)) {
    out.push({ group: "us-equity-index", groupLabel: "US equity index beta", sign: 1 });
    if (QQQ_HEAVY.has(s) || s === "QQQ") {
      out.push({ group: "us-tech", groupLabel: "US large-cap tech", sign: 1 });
    }
    return out;
  }
  if (cls === "stocks") {
    out.push({ group: "us-equity-index", groupLabel: "US equity index beta", sign: 1 });
  }
  return out;
}

export function findCorrelationWarnings(openTrades: JournalTrade[]): CorrelationWarning[] {
  const buckets = new Map<string, { label: string; entries: { symbol: string; effective: 1 | -1 }[] }>();

  for (const t of openTrades) {
    if (t.status !== "open") continue;
    const dirSign = t.direction === "long" ? 1 : -1;
    for (const exp of exposuresForSymbol(t.symbol)) {
      const effective = (dirSign * exp.sign) as 1 | -1;
      const bucket = buckets.get(exp.group) ?? { label: exp.groupLabel, entries: [] };
      bucket.entries.push({ symbol: t.symbol, effective });
      buckets.set(exp.group, bucket);
    }
  }

  const warnings: CorrelationWarning[] = [];
  for (const bucket of buckets.values()) {
    const sameDir = new Map<1 | -1, string[]>();
    for (const e of bucket.entries) {
      sameDir.set(e.effective, [...(sameDir.get(e.effective) ?? []), e.symbol]);
    }
    for (const [, symbols] of sameDir) {
      const unique = [...new Set(symbols)];
      if (symbols.length >= 2) {
        warnings.push({
          severity: symbols.length >= 3 ? "high" : "medium",
          group: bucket.label,
          symbols: unique,
          message: `${symbols.length} open positions share ${bucket.label} in the same direction (${unique.join(", ")}) — they are likely to win or lose together, so effective risk is concentrated.`,
        });
      }
    }
    // Offsetting exposures within a group partially hedge each other
    if ((sameDir.get(1)?.length ?? 0) > 0 && (sameDir.get(-1)?.length ?? 0) > 0) {
      const longs = [...new Set(sameDir.get(1) ?? [])];
      const shorts = [...new Set(sameDir.get(-1) ?? [])];
      warnings.push({
        severity: "medium",
        group: bucket.label,
        symbols: [...longs, ...shorts],
        message: `Opposing ${bucket.label} positions (${longs.join(", ")} vs ${shorts.join(", ")}) partially offset — combined they may be closer to flat than two independent trades.`,
      });
    }
  }
  return warnings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}
