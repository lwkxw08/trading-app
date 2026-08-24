"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import SymbolInput from "@/components/SymbolInput";
import { useFavorites } from "@/components/useFavorites";
import { DEFAULT_CRYPTO_UNIVERSE } from "@/lib/market/binance";

export default function AnalyzeIndex() {
  const router = useRouter();
  const [symbol, setSymbol] = useState("");
  const { favorites } = useFavorites();

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="text-xl font-bold">Analysis Workspace</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (symbol.trim()) router.push(`/analyze/${symbol.trim().toUpperCase()}`);
        }}
        className="flex gap-2"
      >
        <div className="flex-1 [&>div]:w-full">
          <SymbolInput
            value={symbol}
            onChange={setSymbol}
            placeholder="Enter a symbol, e.g. BTCUSDT"
            className="w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
          />
        </div>
        <button type="submit" className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
          Analyze
        </button>
      </form>
      {favorites.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-muted">Favourites</h2>
          <div className="flex flex-wrap gap-2">
            {favorites.map((f) => (
              <button
                key={f}
                onClick={() => router.push(`/analyze/${f}`)}
                className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-accent"
              >
                <span className="mr-1 text-amber-400">★</span>
                {f}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">Popular</h2>
        <div className="flex flex-wrap gap-2">
          {DEFAULT_CRYPTO_UNIVERSE.map((c) => (
            <button
              key={c.symbol}
              onClick={() => router.push(`/analyze/${c.symbol}`)}
              className="rounded-md border border-edge bg-surface px-3 py-1.5 text-sm hover:border-accent"
            >
              {c.symbol}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
