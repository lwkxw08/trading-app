import { BinanceProvider } from "./binance";
import { PolygonProvider } from "./stocks";
import { isCryptoSymbol } from "./symbols";
import { TwelveDataProvider } from "./twelvedata";
import type { AssetClass, MarketDataProvider } from "./types";

const binance = new BinanceProvider();
const twelvedata = new TwelveDataProvider();
const polygon = new PolygonProvider();

const providers: MarketDataProvider[] = [binance, twelvedata, polygon];

export function getProviders(): MarketDataProvider[] {
  return providers;
}

export function getProviderForAssetClass(assetClass: AssetClass): MarketDataProvider | undefined {
  return providers.find((p) => p.assetClasses.includes(assetClass) && p.isConfigured());
}

export function getProviderForSymbol(symbol: string): MarketDataProvider {
  // Crypto symbols quoted in a stablecoin stay on Binance; everything else
  // (stocks, ETFs, forex pairs) routes to the first configured provider.
  if (isCryptoSymbol(symbol)) return binance;
  if (twelvedata.isConfigured()) return twelvedata;
  if (polygon.isConfigured()) return polygon;
  return binance;
}

export function availableAssetClasses(): { assetClass: AssetClass; available: boolean }[] {
  const classes: AssetClass[] = ["crypto", "stocks", "futures", "forex"];
  return classes.map((assetClass) => ({
    assetClass,
    available: Boolean(getProviderForAssetClass(assetClass)),
  }));
}
