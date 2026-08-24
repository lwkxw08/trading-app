import type { AssetClass, Candle, Instrument, MarketDataProvider, Ticker, Timeframe } from "./types";

// data-api.binance.vision is Binance's public market-data mirror and is
// reachable from regions where api.binance.com is geo-restricted.
const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

const TF_MAP: Record<Timeframe, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h",
  "1d": "1d", "1w": "1w",
};

export const DEFAULT_CRYPTO_UNIVERSE: { symbol: string; name: string }[] = [
  { symbol: "BTCUSDT", name: "Bitcoin" },
  { symbol: "ETHUSDT", name: "Ethereum" },
  { symbol: "SOLUSDT", name: "Solana" },
  { symbol: "BNBUSDT", name: "BNB" },
  { symbol: "XRPUSDT", name: "XRP" },
  { symbol: "DOGEUSDT", name: "Dogecoin" },
  { symbol: "ADAUSDT", name: "Cardano" },
  { symbol: "AVAXUSDT", name: "Avalanche" },
  { symbol: "LINKUSDT", name: "Chainlink" },
  { symbol: "LTCUSDT", name: "Litecoin" },
];

type BinanceKline = [number, string, string, string, string, string, ...unknown[]];

interface Binance24hTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
}

async function fetchWithFallback(path: string, label: string): Promise<Response> {
  let lastError = "";
  for (const host of HOSTS) {
    const res = await fetch(`${host}${path}`, { next: { revalidate: 30 } });
    if (res.ok) return res;
    lastError = `${res.status}`;
    if (res.status !== 451 && res.status !== 403) break;
  }
  throw new Error(`Binance error ${lastError} fetching ${label}`);
}

export class BinanceProvider implements MarketDataProvider {
  readonly id = "binance";
  readonly assetClasses: AssetClass[] = ["crypto"];

  isConfigured(): boolean {
    return true; // public endpoints, no key required
  }

  async listInstruments(): Promise<Instrument[]> {
    return DEFAULT_CRYPTO_UNIVERSE.map((c) => ({
      symbol: c.symbol,
      name: c.name,
      assetClass: "crypto",
      provider: this.id,
      quoteCurrency: "USDT",
      pricePrecision: 2,
    }));
  }

  async getCandles(symbol: string, timeframe: Timeframe, limit = 500): Promise<Candle[]> {
    const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${TF_MAP[timeframe]}&limit=${Math.min(limit, 1000)}`;
    const res = await fetchWithFallback(path, `klines for ${symbol}`);
    const raw = (await res.json()) as BinanceKline[];
    return raw.map((k) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5] as string),
    }));
  }

  async getTickers(symbols: string[]): Promise<Ticker[]> {
    const path = `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    const res = await fetchWithFallback(path, "24h tickers");
    const raw = (await res.json()) as Binance24hTicker[];
    return raw.map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      change24hPct: parseFloat(t.priceChangePercent),
      volume24h: parseFloat(t.quoteVolume),
    }));
  }
}
