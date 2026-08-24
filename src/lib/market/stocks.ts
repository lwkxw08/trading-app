import type { AssetClass, Candle, Instrument, MarketDataProvider, Ticker, Timeframe } from "./types";

/**
 * Stocks/futures adapter backed by Polygon.io-compatible aggregate endpoints.
 * Inactive until POLYGON_API_KEY is set — the app degrades gracefully and
 * surfaces these asset classes as "coming online once a data plan is chosen".
 */
export class PolygonProvider implements MarketDataProvider {
  readonly id = "polygon";
  readonly assetClasses: AssetClass[] = ["stocks", "futures"];

  private get apiKey(): string | undefined {
    return process.env.POLYGON_API_KEY;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async listInstruments(): Promise<Instrument[]> {
    if (!this.isConfigured()) return [];
    return DEFAULT_STOCK_UNIVERSE.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      assetClass: "stocks",
      provider: this.id,
      quoteCurrency: "USD",
      pricePrecision: 2,
    }));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
    if (!this.apiKey) throw new Error("Polygon API key not configured");
    const { mult, span } = TF_TO_POLYGON[timeframe];
    const to = Date.now();
    const from = to - approxMs(timeframe) * limit;
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(symbol)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=${limit}&apiKey=${this.apiKey}`;
    const res = await fetch(url, { next: { revalidate: 60 } });
    if (!res.ok) throw new Error(`Polygon error ${res.status} for ${symbol}`);
    const data = (await res.json()) as { results?: { t: number; o: number; h: number; l: number; c: number; v: number }[] };
    return (data.results ?? []).map((r) => ({
      time: Math.floor(r.t / 1000),
      open: r.o,
      high: r.h,
      low: r.l,
      close: r.c,
      volume: r.v,
    }));
  }

  async getTickers(symbols: string[]): Promise<Ticker[]> {
    if (!this.apiKey) return [];
    const out: Ticker[] = [];
    for (const symbol of symbols) {
      const candles = await this.getCandles(symbol, "1d", 2);
      if (candles.length >= 2) {
        const [prev, last] = candles.slice(-2);
        out.push({
          symbol,
          lastPrice: last.close,
          change24hPct: ((last.close - prev.close) / prev.close) * 100,
          volume24h: last.volume,
        });
      }
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

const TF_TO_POLYGON: Record<Timeframe, { mult: number; span: string }> = {
  "1m": { mult: 1, span: "minute" },
  "5m": { mult: 5, span: "minute" },
  "15m": { mult: 15, span: "minute" },
  "30m": { mult: 30, span: "minute" },
  "1h": { mult: 1, span: "hour" },
  "2h": { mult: 2, span: "hour" },
  "4h": { mult: 4, span: "hour" },
  "1d": { mult: 1, span: "day" },
  "1w": { mult: 1, span: "week" },
};

function approxMs(tf: Timeframe): number {
  const m = 60_000;
  switch (tf) {
    case "1m": return m;
    case "5m": return 5 * m;
    case "15m": return 15 * m;
    case "30m": return 30 * m;
    case "1h": return 60 * m;
    case "2h": return 120 * m;
    case "4h": return 240 * m;
    case "1d": return 24 * 60 * m;
    case "1w": return 7 * 24 * 60 * m;
  }
}
