import { DEFAULT_CRYPTO_UNIVERSE } from "./binance";
import { DEFAULT_FOREX_UNIVERSE, DEFAULT_STOCK_UNIVERSE } from "./twelvedata";

export const MARKETS = ["crypto", "stocks", "forex"] as const;
export type Market = (typeof MARKETS)[number];

export const MARKET_LABELS: Record<Market, string> = {
  crypto: "Crypto",
  stocks: "Stocks & ETFs",
  forex: "Forex",
};

export function isMarket(value: string | null): value is Market {
  return MARKETS.includes(value as Market);
}

/**
 * Default scan universe per market. Non-crypto lists are capped at 4 symbols:
 * a scan costs 2 Twelve Data credits per symbol and the free tier allows
 * 8 credits/min — larger universes would silently drop symbols to rate limits.
 */
export function defaultUniverse(market: Market): string[] {
  if (market === "stocks") return DEFAULT_STOCK_UNIVERSE.slice(0, 4).map((c) => c.symbol);
  if (market === "forex") return DEFAULT_FOREX_UNIVERSE.slice(0, 4).map((c) => c.symbol);
  return DEFAULT_CRYPTO_UNIVERSE.map((c) => c.symbol);
}
