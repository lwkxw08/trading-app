import { BinanceProvider } from "./binance";
import { PolygonProvider } from "./stocks";
import type { AssetClass, MarketDataProvider } from "./types";

const providers: MarketDataProvider[] = [new BinanceProvider(), new PolygonProvider()];

export function getProviders(): MarketDataProvider[] {
  return providers;
}

export function getProviderForAssetClass(assetClass: AssetClass): MarketDataProvider | undefined {
  return providers.find((p) => p.assetClasses.includes(assetClass) && p.isConfigured());
}

export function getProviderForSymbol(symbol: string): MarketDataProvider {
  // Crypto symbols on Binance end in a quote asset like USDT; everything else
  // routes to the stocks/futures provider when configured.
  if (/USDT$|USDC$|BUSD$/.test(symbol)) return providers[0];
  const polygon = providers[1];
  if (polygon.isConfigured()) return polygon;
  return providers[0];
}

export function availableAssetClasses(): { assetClass: AssetClass; available: boolean }[] {
  const classes: AssetClass[] = ["crypto", "stocks", "futures", "forex"];
  return classes.map((assetClass) => ({
    assetClass,
    available: Boolean(getProviderForAssetClass(assetClass)),
  }));
}
