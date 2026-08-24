import { NextRequest, NextResponse } from "next/server";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import type { Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

const MTF_TIMEFRAMES: Timeframe[] = ["15m", "30m", "1h", "2h", "4h", "1d", "1w"];

export interface MtfRow {
  timeframe: Timeframe;
  trend: "up" | "down" | "sideways";
  rsi14: number | null;
  macdHistogram: number | null;
  priceVsPoc: "above" | "below";
  priceVsVwap: "above" | "below" | null;
  openFvgs: number;
  activeOrderBlocks: number;
  lastStructureBreak: { type: "bos" | "choch"; direction: "bullish" | "bearish" } | null;
  bestSetup: { direction: "long" | "short"; score: number } | null;
}

export async function GET(req: NextRequest) {
  const symbol = req.nextUrl.searchParams.get("symbol");
  if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });

  try {
    const provider = getProviderForSymbol(symbol);
    const events = await getEconomicCalendar().catch(() => []);

    const results = await Promise.allSettled(
      MTF_TIMEFRAMES.map(async (tf): Promise<MtfRow> => {
        const htf = higherTimeframe(tf);
        const [candles, htfCandles] = await Promise.all([
          provider.getCandles(symbol, tf, 400),
          provider.getCandles(symbol, htf, 300),
        ]);
        if (candles.length < 50) throw new Error("not enough data");
        const a = analyze(symbol, tf, candles, htfCandles, htf);
        const opportunities = scoreOpportunities(a, events);
        const best = opportunities.sort((x, y) => y.score - x.score)[0] ?? null;
        const lastBreak = a.structureBreaks[a.structureBreaks.length - 1] ?? null;
        return {
          timeframe: tf,
          trend: a.trend.direction,
          rsi14: a.trend.rsi14,
          macdHistogram: a.trend.macdHistogram,
          priceVsPoc: a.lastPrice >= a.volumeProfile.poc ? "above" : "below",
          priceVsVwap: a.anchoredVwap ? (a.lastPrice >= a.anchoredVwap.value ? "above" : "below") : null,
          openFvgs: a.fvgs.filter((g) => !g.filled).length,
          activeOrderBlocks: a.orderBlocks.filter((b) => !b.mitigated).length,
          lastStructureBreak: lastBreak ? { type: lastBreak.type, direction: lastBreak.direction } : null,
          bestSetup: best ? { direction: best.direction, score: best.score } : null,
        };
      }),
    );

    const rows = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    if (rows.length === 0) return NextResponse.json({ error: "no data for symbol" }, { status: 502 });
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "mtf analysis failed" }, { status: 502 });
  }
}
