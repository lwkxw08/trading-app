import type { BacktestTrade } from "@/lib/backtest/engine";
import type { Timeframe } from "@/lib/market/types";

/**
 * Discipline mirror: deterministically compares executed journal trades with
 * what the strategy signalled over the same period — missed signals,
 * unsignalled discretionary entries, exits cut short of the plan, and quick
 * re-entries after a loss. The AI narrative is layered on top of these
 * findings; it never invents events.
 */

export interface GapJournalTrade {
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  status: "open" | "closed";
  entryPrice: number;
  entryTime: number; // unix ms
  stopLoss: number | null;
  takeProfit: number | null;
  strategyName: string;
  exitPrice: number | null;
  exitTime: number | null; // unix ms
  rMultiple: number | null;
}

export type GapEventType = "missed_entry" | "unsignalled_entry" | "early_exit" | "quick_reentry_after_loss";

export interface GapEvent {
  type: GapEventType;
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  time: number; // unix ms
  detail: string;
}

export interface GapFindings {
  events: GapEvent[];
  journalTrades: number;
  signalledTrades: number; // sim trades inside the journalled period
  matchedTrades: number; // journal trades that line up with a signal
  pairsAnalyzed: { symbol: string; timeframe: Timeframe; simTrades: number }[];
}

export const TF_SECONDS: Record<Timeframe, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

const MATCH_BARS = 3; // journal entry within this many bars of a signal counts as taking it

function fmt(n: number): string {
  return n >= 100 ? n.toFixed(2) : n.toPrecision(5);
}

export function detectGaps(
  journal: GapJournalTrade[],
  simByPair: Map<string, BacktestTrade[]>,
): GapFindings {
  const events: GapEvent[] = [];
  let signalled = 0;
  let matched = 0;
  const pairs: GapFindings["pairsAnalyzed"] = [];

  for (const [key, simTrades] of simByPair) {
    const [symbol, tf] = key.split("|") as [string, Timeframe];
    const tolerance = MATCH_BARS * TF_SECONDS[tf] * 1000;
    const pairJournal = journal.filter((t) => t.symbol === symbol && t.timeframe === tf);
    if (pairJournal.length === 0) continue;
    pairs.push({ symbol, timeframe: tf, simTrades: simTrades.length });

    const firstEntry = Math.min(...pairJournal.map((t) => t.entryTime));
    const active = simTrades.filter((st) => st.entryTime * 1000 >= firstEntry - tolerance);
    signalled += active.length;

    // Missed signals: strategy fired inside the journalled period, no trade taken.
    for (const st of active) {
      const taken = pairJournal.some(
        (jt) => jt.direction === st.direction && Math.abs(jt.entryTime - st.entryTime * 1000) <= tolerance,
      );
      if (!taken) {
        events.push({
          type: "missed_entry",
          symbol,
          timeframe: tf,
          direction: st.direction,
          time: st.entryTime * 1000,
          detail: `Strategy signalled a ${st.direction} (score ${st.score}) at ${fmt(st.entryPrice)} that resolved ${st.rMultiple >= 0 ? "+" : ""}${st.rMultiple.toFixed(2)}R — no journal trade taken`,
        });
      }
    }

    for (const jt of pairJournal) {
      const signalMatch = simTrades.find(
        (st) => st.direction === jt.direction && Math.abs(jt.entryTime - st.entryTime * 1000) <= tolerance,
      );
      if (signalMatch) {
        matched++;
        // Exit cut short of the strategy's outcome on the same entry.
        if (
          jt.status === "closed" &&
          jt.rMultiple !== null &&
          jt.exitTime !== null &&
          jt.exitTime < signalMatch.exitTime * 1000 &&
          signalMatch.rMultiple > jt.rMultiple + 0.5
        ) {
          events.push({
            type: "early_exit",
            symbol,
            timeframe: tf,
            direction: jt.direction,
            time: jt.exitTime,
            detail: `Exited at ${jt.rMultiple.toFixed(2)}R but the same signal ran to ${signalMatch.rMultiple >= 0 ? "+" : ""}${signalMatch.rMultiple.toFixed(2)}R (${signalMatch.exitReason.replace(/_/g, " ")})`,
          });
        }
      } else {
        events.push({
          type: "unsignalled_entry",
          symbol,
          timeframe: tf,
          direction: jt.direction,
          time: jt.entryTime,
          detail: `${jt.direction} entry at ${fmt(jt.entryPrice)} had no strategy signal within ${MATCH_BARS} bars${jt.rMultiple !== null ? ` — closed at ${jt.rMultiple.toFixed(2)}R` : ""}`,
        });
      }
    }

    // Quick re-entries after a loss (possible revenge trades).
    const losses = pairJournal.filter((t) => t.status === "closed" && t.rMultiple !== null && t.rMultiple < 0 && t.exitTime !== null);
    for (const loss of losses) {
      const reentry = pairJournal.find(
        (t) => t !== loss && t.entryTime > loss.exitTime! && t.entryTime - loss.exitTime! <= tolerance,
      );
      if (reentry) {
        events.push({
          type: "quick_reentry_after_loss",
          symbol,
          timeframe: tf,
          direction: reentry.direction,
          time: reentry.entryTime,
          detail: `Re-entered ${reentry.direction} within ${MATCH_BARS} bars of a ${loss.rMultiple!.toFixed(2)}R loss — check it was a fresh setup, not a revenge trade`,
        });
      }
    }
  }

  events.sort((a, b) => b.time - a.time);
  return {
    events,
    journalTrades: journal.length,
    signalledTrades: signalled,
    matchedTrades: matched,
    pairsAnalyzed: pairs,
  };
}
