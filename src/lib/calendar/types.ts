export type EventImpact = "high" | "medium" | "low";

export interface EconomicEvent {
  title: string;
  country: string;
  timestamp: number; // unix seconds
  impact: EventImpact;
  forecast?: string;
  previous?: string;
}
