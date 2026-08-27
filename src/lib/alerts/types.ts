import type { Timeframe } from "@/lib/market/types";

export interface PriceLevelRule {
  id: string;
  type: "price_level";
  enabled: boolean;
  symbol: string;
  level: number;
  condition: "above" | "below";
  note: string;
  cooldownMin: number;
  lastFiredAt: number | null; // unix ms
}

export interface SetupRule {
  id: string;
  type: "setup";
  enabled: boolean;
  /** Comma-separated symbols; blank = default universe. */
  symbols: string;
  tf: Timeframe;
  direction: "both" | "long" | "short";
  minScore: number;
  /** Dedicated setup scan instead of built-in confluence. */
  setup?: "trendbreak" | "sessionopen";
  cooldownMin: number;
  /** Per symbol+direction cooldown tracking (unix ms). */
  lastFired: Record<string, number>;
}

export type AlertRule = PriceLevelRule | SetupRule;

export interface AlertEvent {
  id: string;
  time: number; // unix ms
  ruleId: string;
  message: string;
}

export interface DeliverySettings {
  browserNotifications: boolean;
  webhookUrl: string;
  telegramChatId: string;
}
