import { assetClassForSymbol } from "@/lib/market/symbols";

/**
 * Keyless news layer: Google News RSS search per symbol. Headlines are
 * context for AI synthesis only — the deterministic engine never uses them.
 * Gracefully returns [] on any failure so analysis never depends on news.
 */

export interface NewsHeadline {
  title: string;
  source: string;
  publishedAt: number; // unix ms
  url: string;
}

const CRYPTO_NAMES: Record<string, string> = {
  BTC: "Bitcoin",
  ETH: "Ethereum",
  SOL: "Solana",
  XRP: "XRP Ripple",
  BNB: "BNB Binance coin",
  DOGE: "Dogecoin",
  ADA: "Cardano",
  AVAX: "Avalanche crypto",
  LINK: "Chainlink",
  DOT: "Polkadot",
  LTC: "Litecoin",
};

function queryForSymbol(symbol: string): string {
  const cls = assetClassForSymbol(symbol);
  if (cls === "crypto") {
    const base = symbol.replace(/(USDT|USDC|BUSD)$/, "");
    return `${CRYPTO_NAMES[base] ?? `${base} crypto`} price`;
  }
  if (cls === "forex") {
    const clean = symbol.replace("/", "");
    return `${clean.slice(0, 3)}/${clean.slice(3, 6)} forex`;
  }
  return `${symbol} stock`;
}

/** Yahoo Finance ticker for its per-symbol RSS feed. */
function yahooTicker(symbol: string): string {
  const cls = assetClassForSymbol(symbol);
  if (cls === "crypto") return `${symbol.replace(/(USDT|USDC|BUSD)$/, "")}-USD`;
  if (cls === "forex") return `${symbol.replace("/", "")}=X`;
  return symbol;
}

/** Feed URLs in preference order. Yahoo works from Cloudflare's IPs; Google
 * News blocks datacenter ranges, so it is only a dev/local fallback. */
function feedUrls(symbol: string): string[] {
  const q = encodeURIComponent(queryForSymbol(symbol));
  return [
    `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(yahooTicker(symbol))}&region=US&lang=en-US`,
    `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`,
    `https://www.bing.com/news/search?q=${q}&format=rss`,
  ];
}

const cache = new Map<string, { at: number; items: NewsHeadline[] }>();
const CACHE_MS = 10 * 60 * 1000;

export async function getHeadlines(symbol: string, limit = 8): Promise<NewsHeadline[]> {
  const key = symbol.toUpperCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.items.slice(0, limit);

  for (const url of feedUrls(key)) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; TradeIntel/1.0)" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml);
      if (items.length === 0) continue;
      cache.set(key, { at: Date.now(), items });
      return items.slice(0, limit);
    } catch {
      // try the next feed
    }
  }
  return [];
}

function parseRssItems(xml: string): NewsHeadline[] {
  const items: NewsHeadline[] = [];
  const itemRe = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null && items.length < 20) {
    const block = m[1];
    const title = extractTag(block, "title");
    const link = extractTag(block, "link");
    const pubDate = extractTag(block, "pubDate");
    const source = extractTag(block, "source");
    if (!title) continue;
    items.push({
      title: decodeEntities(title),
      source: decodeEntities(source ?? "") || hostnameOf(link ?? ""),
      publishedAt: pubDate ? Date.parse(pubDate) || Date.now() : Date.now(),
      url: link ?? "",
    });
  }
  items.sort((a, b) => b.publishedAt - a.publishedAt);
  return items;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function extractTag(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "").trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}
