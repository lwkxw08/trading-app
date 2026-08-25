import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isAiConfigured, reviewGaps } from "@/lib/ai/analyze";
import { runBacktest, type BacktestTrade } from "@/lib/backtest/engine";
import { detectGaps, type GapJournalTrade } from "@/lib/journal/gap";
import { getExtendedHistory } from "@/lib/market/history";
import { getProviderForSymbol } from "@/lib/market/registry";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { higherTimeframe } from "@/lib/strategies/engine";

export const runtime = "edge";

const tradeSchema = z.object({
  symbol: z.string().min(1).max(20),
  tf: z.enum(TIMEFRAMES as unknown as [string, ...string[]]).transform((v) => v as Timeframe),
  direction: z.enum(["long", "short"]),
  status: z.enum(["open", "closed"]),
  entryPrice: z.number().positive(),
  entryTime: z.number(),
  stopLoss: z.number().positive().nullable(),
  takeProfit: z.number().positive().nullable(),
  strategyName: z.string().max(60),
  exitPrice: z.number().positive().nullable(),
  exitTime: z.number().nullable(),
  rMultiple: z.number().nullable(),
});

const schema = z.object({
  trades: z.array(tradeSchema).min(1).max(200),
  minScore: z.number().min(0).max(100).default(55),
});

const MAX_PAIRS = 4;
const BARS = 1500;

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { trades, minScore } = parsed.data;

  const journal: GapJournalTrade[] = trades.map((t) => ({
    symbol: t.symbol.toUpperCase(),
    timeframe: t.tf,
    direction: t.direction,
    status: t.status,
    entryPrice: t.entryPrice,
    entryTime: t.entryTime,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    strategyName: t.strategyName,
    exitPrice: t.exitPrice,
    exitTime: t.exitTime,
    rMultiple: t.rMultiple,
  }));

  // Most-traded symbol/timeframe pairs first, capped to keep the run fast.
  const counts = new Map<string, number>();
  for (const t of journal) {
    const key = `${t.symbol}|${t.timeframe}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pairs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PAIRS)
    .map(([key]) => key);

  try {
    const simByPair = new Map<string, BacktestTrade[]>();
    await Promise.all(
      pairs.map(async (key) => {
        const [symbol, tf] = key.split("|") as [string, Timeframe];
        const provider = getProviderForSymbol(symbol);
        const htf = higherTimeframe(tf);
        const [candles, htfCandles] = await Promise.all([
          getExtendedHistory(provider, symbol, tf, BARS),
          getExtendedHistory(provider, symbol, htf, 1000),
        ]);
        if (candles.length < 200) return;
        const result = runBacktest(symbol, tf, candles, htfCandles, htf, {
          strategyType: "builtin",
          custom: null,
          minScore,
          direction: "both",
          maxHoldBars: 100,
          feePct: 0,
          slippagePct: 0,
        });
        simByPair.set(key, result.trades);
      }),
    );

    if (simByPair.size === 0) {
      return NextResponse.json({ error: "no historical data available for the journalled symbols" }, { status: 502 });
    }

    const findings = detectGaps(journal, simByPair);

    let review = null;
    let aiError: string | null = null;
    if (isAiConfigured()) {
      try {
        review = await reviewGaps({
          minScore,
          summary: {
            journalTrades: findings.journalTrades,
            signalsDuringJournalledPeriod: findings.signalledTrades,
            journalTradesMatchingASignal: findings.matchedTrades,
            pairsAnalyzed: findings.pairsAnalyzed.map((p) => ({
              symbol: p.symbol,
              timeframe: p.timeframe,
              simTradesAcrossFullBacktestWindow: p.simTrades,
            })),
          },
          events: findings.events.slice(0, 60),
        });
      } catch (e) {
        aiError = e instanceof Error ? e.message : "AI review failed";
      }
    } else {
      aiError = "ANTHROPIC_API_KEY not configured";
    }

    return NextResponse.json({ findings, review, aiError });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "gap analysis failed" }, { status: 502 });
  }
}
