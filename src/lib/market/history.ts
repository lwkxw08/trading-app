import type { Candle, MarketDataProvider, Timeframe } from "./types";

/**
 * Fetches up to `totalBars` of history by paginating backwards from the most
 * recent candle. Falls back to a single fetch when the provider does not
 * support pagination.
 */
export async function getExtendedHistory(
  provider: MarketDataProvider,
  symbol: string,
  timeframe: Timeframe,
  totalBars: number,
): Promise<Candle[]> {
  const pageSize = 1000;
  let candles = await provider.getCandles(symbol, timeframe, Math.min(totalBars, pageSize));
  if (!provider.getCandlesBefore) return candles;

  while (candles.length < totalBars && candles.length > 0) {
    const oldest = candles[0].time;
    const page = await provider.getCandlesBefore(
      symbol,
      timeframe,
      oldest,
      Math.min(totalBars - candles.length, pageSize),
    );
    if (page.length === 0) break; // start of available history
    candles = [...page, ...candles];
  }
  return candles.slice(-totalBars);
}
