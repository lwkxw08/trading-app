import { toTwelveDataSymbol } from "./symbols";
import type { AssetClass, Candle, Instrument, MarketDataProvider, Ticker, Timeframe } from "./types";

const HOST = "https://api.twelvedata.com";

const TF_MAP: Record<Timeframe, string> = {
  "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
  "1h": "1h", "2h": "2h", "4h": "4h",
  "1d": "1day", "1w": "1week",
};

interface TdValue {
  datetime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume?: string;
}

interface TdTimeSeries {
  status?: string;
  message?: string;
  values?: TdValue[];
}

interface TdQuote {
  symbol?: string;
  close?: string;
  percent_change?: string;
  volume?: string;
  status?: string;
  message?: string;
}

// datetime arrives as "YYYY-MM-DD HH:mm:ss" (or "YYYY-MM-DD" for daily+) in UTC
// because every request passes timezone=UTC.
function parseUtc(datetime: string): number {
  const iso = datetime.includes(" ") ? `${datetime.replace(" ", "T")}Z` : `${datetime}T00:00:00Z`;
  return Math.floor(Date.parse(iso) / 1000);
}

function toCandles(values: TdValue[]): Candle[] {
  return values
    .map((v) => ({
      time: parseUtc(v.datetime),
      open: parseFloat(v.open),
      high: parseFloat(v.high),
      low: parseFloat(v.low),
      close: parseFloat(v.close),
      volume: v.volume !== undefined ? parseFloat(v.volume) : 0,
    }))
    .sort((a, b) => a.time - b.time);
}

function endDateParam(beforeTime: number): string {
  // end_date is inclusive, so step back one second from the boundary candle.
  return new Date((beforeTime - 1) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Stocks/forex adapter backed by Twelve Data. Free tier covers real-time US
 * stocks/ETFs and forex; the app stays crypto-only until TWELVEDATA_API_KEY
 * is configured.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly id = "twelvedata";
  readonly assetClasses: AssetClass[] = ["stocks", "forex"];

  private get apiKey(): string | undefined {
    return process.env.TWELVEDATA_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async listInstruments(): Promise<Instrument[]> {
    if (!this.isConfigured()) return [];
    return [
      ...DEFAULT_STOCK_UNIVERSE.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        assetClass: "stocks" as const,
        provider: this.id,
        quoteCurrency: "USD",
        pricePrecision: 2,
      })),
      ...DEFAULT_FOREX_UNIVERSE.map((s) => ({
        symbol: s.symbol,
        name: s.name,
        assetClass: "forex" as const,
        provider: this.id,
        quoteCurrency: s.symbol.slice(3),
        pricePrecision: 5,
      })),
    ];
  }

  private async fetchSeries(symbol: string, timeframe: Timeframe, limit: number, endDate?: string): Promise<Candle[]> {
    if (!this.apiKey) throw new Error("Twelve Data API key not configured");
    const td = encodeURIComponent(toTwelveDataSymbol(symbol));
    const end = endDate ? `&end_date=${encodeURIComponent(endDate)}` : "";
    const url = `${HOST}/time_series?symbol=${td}&interval=${TF_MAP[timeframe]}&outputsize=${Math.min(limit, 5000)}&timezone=UTC${end}&apikey=${this.apiKey}`;
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) throw new Error(`Twelve Data error ${res.status} for ${symbol}`);
    const data = (await res.json()) as TdTimeSeries;
    if (data.status === "error") throw new Error(`Twelve Data: ${data.message ?? "unknown error"} (${symbol})`);
    return toCandles(data.values ?? []);
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
    return this.fetchSeries(symbol, timeframe, limit);
  }

  async getCandlesBefore(symbol: string, timeframe: Timeframe, beforeTime: number, limit = 1000): Promise<Candle[]> {
    return this.fetchSeries(symbol, timeframe, limit, endDateParam(beforeTime));
  }

  async getTickers(symbols: string[]): Promise<Ticker[]> {
    if (!this.apiKey) return [];
    const tdSymbols = symbols.map(toTwelveDataSymbol);
    const url = `${HOST}/quote?symbol=${encodeURIComponent(tdSymbols.join(","))}&apikey=${this.apiKey}`;
    const res = await fetch(url, { next: { revalidate: 30 } });
    if (!res.ok) throw new Error(`Twelve Data error ${res.status} fetching quotes`);
    const data = (await res.json()) as TdQuote | Record<string, TdQuote>;
    const quotes: Record<string, TdQuote> =
      symbols.length === 1 ? { [tdSymbols[0]]: data as TdQuote } : (data as Record<string, TdQuote>);
    const out: Ticker[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const q = quotes[tdSymbols[i]];
      if (!q || q.status === "error" || q.close === undefined) continue;
      out.push({
        symbol: symbols[i],
        lastPrice: parseFloat(q.close),
        change24hPct: q.percent_change !== undefined ? parseFloat(q.percent_change) : 0,
        volume24h: q.volume !== undefined ? parseFloat(q.volume) : 0,
      });
    }
    return out;
  }
}

export const DEFAULT_STOCK_UNIVERSE: { symbol: string; name: string }[] = [
  { symbol: "SPY", name: "S&P 500 ETF" },
  { symbol: "QQQ", name: "Nasdaq 100 ETF" },
  { symbol: "AAPL", name: "Apple" },
  { symbol: "MSFT", name: "Microsoft" },
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "TSLA", name: "Tesla" },
  { symbol: "AMZN", name: "Amazon" },
  { symbol: "META", name: "Meta" },
];

export const DEFAULT_FOREX_UNIVERSE: { symbol: string; name: string }[] = [
  { symbol: "EURUSD", name: "Euro / US Dollar" },
  { symbol: "GBPUSD", name: "Pound / US Dollar" },
  { symbol: "USDJPY", name: "US Dollar / Yen" },
  { symbol: "AUDUSD", name: "Aussie / US Dollar" },
  { symbol: "USDCAD", name: "US Dollar / CAD" },
  { symbol: "USDCHF", name: "US Dollar / Franc" },
];
