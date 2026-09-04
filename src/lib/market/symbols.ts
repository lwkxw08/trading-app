import type { AssetClass } from "./types";

// Client-safe symbol helpers shared by the provider registry and the UI.

const CURRENCY_CODES = new Set([
  "USD", "EUR", "GBP", "JPY", "CHF", "AUD", "NZD", "CAD",
  "SEK", "NOK", "DKK", "SGD", "HKD", "MXN", "ZAR", "TRY",
  "PLN", "CZK", "HUF", "CNH", "CNY",
]);

/** Crypto pairs quoted in a stablecoin, e.g. BTCUSDT — served by Binance/MEXC. */
export function isCryptoSymbol(symbol: string): boolean {
  return /USDT$|USDC$|BUSD$/.test(symbol.toUpperCase());
}

/** Six-letter fiat pairs like EURUSD / GBPJPY (or slashed EUR/USD). */
export function isForexSymbol(symbol: string): boolean {
  const s = symbol.toUpperCase();
  if (s.includes("/")) {
    const [base, quote] = s.split("/");
    return CURRENCY_CODES.has(base) && CURRENCY_CODES.has(quote);
  }
  return s.length === 6 && CURRENCY_CODES.has(s.slice(0, 3)) && CURRENCY_CODES.has(s.slice(3));
}

export function assetClassForSymbol(symbol: string): AssetClass {
  if (isCryptoSymbol(symbol)) return "crypto";
  if (isForexSymbol(symbol)) return "forex";
  return "stocks";
}

/** Twelve Data wants forex pairs slashed (EUR/USD); stocks stay as-is. */
export function toTwelveDataSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  if (!s.includes("/") && isForexSymbol(s)) return `${s.slice(0, 3)}/${s.slice(3)}`;
  return s;
}
