import type { Timeframe } from "@/lib/market/types";
import type { ConfluenceFactor } from "@/lib/strategies/types";

export type SignalOutcome = "target" | "stop" | "timeout" | "pending";

export interface TrackedSignal {
  id: string;
  capturedAt: number;
  strategyName: string;
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  score: number;
  factors: ConfluenceFactor[];
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  generatedAt: number;
  outcome: SignalOutcome;
  resolvedAt: number | null;
  exitPrice: number | null;
  rMultiple: number | null;
  barsToResolve: number | null;
}

export interface SignalBucket {
  name: string;
  signals: number;
  targets: number;
  stops: number;
  timeouts: number;
  hitRate: number | null; // targets / (targets + stops)
  avgR: number | null;
  totalR: number;
}

export interface SignalStats {
  total: number;
  pending: number;
  resolved: number;
  targets: number;
  stops: number;
  timeouts: number;
  hitRate: number | null;
  avgR: number | null;
  totalR: number;
  byStrategy: SignalBucket[];
  byDirection: SignalBucket[];
  byTimeframe: SignalBucket[];
  bySymbol: SignalBucket[];
  byFactor: SignalBucket[];
}
