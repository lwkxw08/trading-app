import type { Timeframe } from "@/lib/market/types";
import type { ConfluenceFactor } from "@/lib/strategies/types";

export interface MarketSnapshot {
  trendDirection: "up" | "down" | "sideways";
  htfDirection?: "up" | "down" | "sideways";
  rsi14: number | null;
  confluenceScore: number | null; // score of the matching-direction setup at entry, if any
  factors: ConfluenceFactor[]; // confluence factors at entry
}

export interface JournalTrade {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  status: "open" | "closed";
  entryPrice: number;
  entryTime: number; // unix ms
  size: number | null; // units of the asset
  stopLoss: number | null;
  takeProfit: number | null;
  strategyName: string;
  notes: string;
  snapshot: MarketSnapshot | null;
  exitPrice: number | null;
  exitTime: number | null;
  exitNotes: string;
}

export interface ClosedTradeMetrics {
  pnlPerUnit: number;
  pnl: number | null; // null when size unknown
  rMultiple: number | null; // null when no stop recorded
  win: boolean;
}

export interface JournalStats {
  total: number;
  closed: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgR: number | null;
  expectancyR: number | null;
  bestR: number | null;
  worstR: number | null;
  profitFactor: number | null;
  byFactor: { name: string; trades: number; wins: number; winRate: number; avgR: number | null }[];
  byStrategy: { name: string; trades: number; wins: number; winRate: number; avgR: number | null }[];
  byDirection: { direction: "long" | "short"; trades: number; wins: number; winRate: number; avgR: number | null }[];
}
