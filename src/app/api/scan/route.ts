import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getEconomicCalendar } from "@/lib/calendar/economic";
import { getProviderForSymbol } from "@/lib/market/registry";
import { defaultUniverse, isMarket } from "@/lib/market/universe";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { scoreOpportunities } from "@/lib/strategies/confluence";
import { evaluateCustomStrategy, type CustomStrategy } from "@/lib/strategies/custom";
import { customStrategySchema } from "@/lib/strategies/customSchema";
import { analyze, higherTimeframe } from "@/lib/strategies/engine";
import type { EconomicEvent } from "@/lib/calendar/types";
import type { Opportunity } from "@/lib/strategies/types";

export const runtime = "edge";

async function runScan(tf: Timeframe, symbols: string[], strategy: CustomStrategy | null) {
  const events: EconomicEvent[] = strategy ? [] : await getEconomicCalendar();
  const htf = higherTimeframe(tf);

  const results = await Promise.allSettled(
    symbols.map(async (symbol): Promise<Opportunity[]> => {
      const provider = getProviderForSymbol(symbol);
      const [candles, htfCandles] = await Promise.all([
        provider.getCandles(symbol, tf, 500),
        provider.getCandles(symbol, htf, 300),
      ]);
      if (candles.length < 50) return [];
      const analysis = analyze(symbol, tf, candles, htfCandles, htf);
      if (strategy) {
        return evaluateCustomStrategy(analysis, strategy)
          .map((e) => e.opportunity)
          .filter((o): o is Opportunity => o !== null);
      }
      return scoreOpportunities(analysis, events);
    }),
  );

  const opportunities = results
    .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    .sort((a, b) => b.score - a.score);
  const errors = results.filter((r) => r.status === "rejected").length;

  return { tf, scanned: symbols.length, errors, opportunities };
}

export async function GET(req: NextRequest) {
  const tf = (req.nextUrl.searchParams.get("tf") ?? "4h") as Timeframe;
  const symbolsParam = req.nextUrl.searchParams.get("symbols");
  const marketParam = req.nextUrl.searchParams.get("market");
  if (!TIMEFRAMES.includes(tf)) return NextResponse.json({ error: "invalid timeframe" }, { status: 400 });

  const symbols = symbolsParam
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20)
    : defaultUniverse(isMarket(marketParam) ? marketParam : "crypto");

  return NextResponse.json(await runScan(tf, symbols, null));
}

const postSchema = z.object({
  tf: z.enum(TIMEFRAMES as unknown as [string, ...string[]]).transform((v) => v as Timeframe),
  symbols: z.string().max(400).optional(),
  market: z.string().max(20).optional(),
  strategy: customStrategySchema.nullish(),
});

export async function POST(req: NextRequest) {
  const parsed = postSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { tf, symbols: symbolsParam, strategy } = parsed.data;
  const market = parsed.data.market ?? null;

  const symbols = symbolsParam?.trim()
    ? symbolsParam.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20)
    : defaultUniverse(isMarket(market) ? market : "crypto");

  return NextResponse.json(await runScan(tf, symbols, strategy ?? null));
}
