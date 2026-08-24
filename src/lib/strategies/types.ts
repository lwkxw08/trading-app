import type { Candle, Timeframe } from "@/lib/market/types";

export type Direction = "bullish" | "bearish";

export interface FairValueGap {
  kind: "fvg";
  direction: Direction;
  top: number;
  bottom: number;
  /** index of the middle candle that created the gap */
  index: number;
  time: number;
  filled: boolean;
  /** fraction of the gap that price has retraced into, 0..1 */
  fillRatio: number;
}

export interface OrderBlock {
  kind: "order_block";
  direction: Direction;
  top: number;
  bottom: number;
  index: number;
  time: number;
  mitigated: boolean;
}

export interface SwingPoint {
  kind: "swing";
  type: "high" | "low";
  price: number;
  index: number;
  time: number;
}

export interface VolumeProfileLevel {
  price: number;
  volume: number;
}

export interface VolumeProfile {
  kind: "volume_profile";
  poc: number; // point of control
  vah: number; // value area high
  val: number; // value area low
  bins: VolumeProfileLevel[];
}

export interface TrendState {
  timeframe: Timeframe;
  direction: "up" | "down" | "sideways";
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  macdHistogram: number | null;
  atr14: number | null;
}

export interface StrategyAnalysis {
  symbol: string;
  timeframe: Timeframe;
  lastPrice: number;
  candles: Candle[];
  fvgs: FairValueGap[];
  orderBlocks: OrderBlock[];
  swings: SwingPoint[];
  volumeProfile: VolumeProfile;
  trend: TrendState;
  higherTimeframeTrend?: TrendState;
}

export interface ConfluenceFactor {
  name: string;
  detail: string;
  weight: number; // contribution to score, can be negative
}

export interface Opportunity {
  symbol: string;
  timeframe: Timeframe;
  direction: "long" | "short";
  score: number; // 0..100
  factors: ConfluenceFactor[];
  entry: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  generatedAt: number;
}
