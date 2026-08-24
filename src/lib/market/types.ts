export type AssetClass = "crypto" | "stocks" | "futures" | "forex";

export type Timeframe =
  | "1m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h"
  | "1d" | "1w";

export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d", "1w"];

export interface Candle {
  time: number; // unix seconds (open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Instrument {
  symbol: string;
  name: string;
  assetClass: AssetClass;
  provider: string;
  quoteCurrency: string;
  pricePrecision: number;
}

export interface Ticker {
  symbol: string;
  lastPrice: number;
  change24hPct: number;
  volume24h: number;
}

export interface MarketDataProvider {
  readonly id: string;
  readonly assetClasses: AssetClass[];
  /** Whether the provider is usable right now (e.g. has API key configured). */
  isConfigured(): boolean;
  listInstruments(): Promise<Instrument[]>;
  getCandles(symbol: string, timeframe: Timeframe, limit?: number): Promise<Candle[]>;
  /** Candles strictly before the given unix-seconds open time (for paginated history). Optional. */
  getCandlesBefore?(symbol: string, timeframe: Timeframe, beforeTime: number, limit?: number): Promise<Candle[]>;
  getTickers(symbols: string[]): Promise<Ticker[]>;
}
