import type { AssetClass, Candle, Instrument, MarketDataProvider, Ticker, Timeframe } from "./types";

// data-api.binance.vision is Binance's public market-data mirror and is
// reachable from regions where api.binance.com is geo-restricted.
const HOSTS = ["https://api.binance.com", "https://data-api.binance.vision"];

// MEXC exposes a Binance-compatible /api/v3 market-data API and accepts
// requests from datacenter IPs (e.g. Cloudflare Workers) that Binance rejects.
const MEXC_HOST = "https://api.mexc.com";

const TF_MAP: Record<Timeframe, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "1h", "2h": "2h", "4h": "4h",
  "1d": "1d", "1w": "1w",
};

// MEXC has no native 2h interval (aggregated from 60m) and uses uppercase 1W for weekly.
const MEXC_TF_MAP: Record<Timeframe, string> = {
  "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
  "1h": "60m", "2h": "60m", "4h": "4h",
  "1d": "1d", "1w": "1W",
};

const TF_SECONDS_MAP: Record<Timeframe, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "2h": 7200, "4h": 14400,
  "1d": 86400, "1w": 604800,
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
  const errors: string[] = [];
  for (const host of HOSTS) {
    const res = await fetch(`${host}${path}`, { next: { revalidate: 30 } });
    if (res.ok) return res;
    errors.push(`${new URL(host).hostname}=${res.status}`);
    if (res.status !== 451 && res.status !== 403) break;
  }
  throw new Error(`Binance error (${errors.join(", ")}) fetching ${label}`);
}

function parseKlines(raw: BinanceKline[]): Candle[] {
  return raw.map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5] as string),
  }));
}

function aggregateCandles(candles: Candle[], seconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const c of candles) {
    const bucket = Math.floor(c.time / seconds) * seconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, { ...c, time: bucket });
    } else {
      existing.high = Math.max(existing.high, c.high);
      existing.low = Math.min(existing.low, c.low);
      existing.close = c.close;
      existing.volume += c.volume;
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

async function fetchMexcCandles(symbol: string, timeframe: Timeframe, limit: number, endTime?: number): Promise<Candle[]> {
  const twoHour = timeframe === "2h";
  const mexcLimit = Math.min(twoHour ? limit * 2 : limit, 1000);
  // MEXC ignores endTime unless startTime is also supplied.
  const baseTfMs = (twoHour ? 3600 : TF_SECONDS_MAP[timeframe]) * 1000;
  const end = endTime !== undefined ? `&startTime=${endTime + 1 - mexcLimit * baseTfMs}&endTime=${endTime}` : "";
  const res = await fetch(
    `${MEXC_HOST}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${MEXC_TF_MAP[timeframe]}&limit=${mexcLimit}${end}`,
    { next: { revalidate: 30 } },
  );
  if (!res.ok) throw new Error(`MEXC error ${res.status} fetching klines for ${symbol}`);
  const candles = parseKlines((await res.json()) as BinanceKline[]);
  return twoHour ? aggregateCandles(candles, 7200) : candles;
}

interface MexcTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string; // ratio, e.g. "-0.0051" = -0.51%
  quoteVolume: string;
}

async function fetchMexcTickers(symbols: string[]): Promise<Ticker[]> {
  return Promise.all(
    symbols.map(async (symbol) => {
      const res = await fetch(`${MEXC_HOST}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`, {
        next: { revalidate: 30 },
      });
      if (!res.ok) throw new Error(`MEXC error ${res.status} fetching ticker for ${symbol}`);
      const t = (await res.json()) as MexcTicker;
      return {
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        change24hPct: parseFloat(t.priceChangePercent) * 100,
        volume24h: parseFloat(t.quoteVolume),
      };
    }),
  );
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
    try {
      const res = await fetchWithFallback(path, `klines for ${symbol}`);
      return parseKlines((await res.json()) as BinanceKline[]);
    } catch {
      return fetchMexcCandles(symbol, timeframe, Math.min(limit, 1000));
    }
  }

  async getCandlesBefore(symbol: string, timeframe: Timeframe, beforeTime: number, limit = 1000): Promise<Candle[]> {
    const endTime = beforeTime * 1000 - 1;
    const path = `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${TF_MAP[timeframe]}&limit=${Math.min(limit, 1000)}&endTime=${endTime}`;
    try {
      const res = await fetchWithFallback(path, `klines for ${symbol}`);
      return parseKlines((await res.json()) as BinanceKline[]);
    } catch {
      return fetchMexcCandles(symbol, timeframe, Math.min(limit, 1000), endTime);
    }
  }

  async getTickers(symbols: string[]): Promise<Ticker[]> {
    const path = `/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
    try {
      const res = await fetchWithFallback(path, "24h tickers");
      const raw = (await res.json()) as Binance24hTicker[];
      return raw.map((t) => ({
        symbol: t.symbol,
        lastPrice: parseFloat(t.lastPrice),
        change24hPct: parseFloat(t.priceChangePercent),
        volume24h: parseFloat(t.quoteVolume),
      }));
    } catch {
      return fetchMexcTickers(symbols);
    }
  }
}
