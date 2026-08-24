import type { EconomicEvent } from "@/lib/calendar/types";
import type { Opportunity, StrategyAnalysis } from "@/lib/strategies/types";

const MODEL = "claude-sonnet-4-5";

export interface AiAnalysis {
  thesis: string;
  bullCase: string;
  bearCase: string;
  keyLevels: string;
  macroContext: string;
  riskNotes: string;
}

export function isAiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

interface AnthropicMessageResponse {
  content: { type: string; text?: string }[];
}

/** Minimal fetch-based Anthropic Messages API client (edge-runtime compatible). */
async function callClaude(system: string, userContent: string, maxTokens: number): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: userContent }],
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as AnthropicMessageResponse;
  return data.content.find((b) => b.type === "text")?.text ?? "{}";
}

/**
 * The LLM never "reads charts" — it receives the deterministic strategy
 * engine's structured output plus the macro calendar and does synthesis only.
 */
export async function generateAnalysis(
  analysis: StrategyAnalysis,
  opportunities: Opportunity[],
  events: EconomicEvent[],
): Promise<AiAnalysis> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const context = {
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    lastPrice: analysis.lastPrice,
    trend: analysis.trend,
    higherTimeframeTrend: analysis.higherTimeframeTrend,
    volumeProfile: { poc: analysis.volumeProfile.poc, vah: analysis.volumeProfile.vah, val: analysis.volumeProfile.val },
    unfilledFvgs: analysis.fvgs.filter((g) => !g.filled).slice(-8),
    activeOrderBlocks: analysis.orderBlocks.filter((b) => !b.mitigated).slice(-8),
    recentSwings: analysis.swings.slice(-8),
    scoredOpportunities: opportunities,
    upcomingHighImpactEvents: events
      .filter((e) => e.impact === "high" && e.timestamp * 1000 > Date.now())
      .slice(0, 10),
  };

  const text = await callClaude(
    [
      "You are a professional market analyst for a trading-intelligence platform.",
      "You are given deterministic, pre-computed technical structures (fair value gaps, order blocks, volume profile, trend state, swing points) and upcoming economic events.",
      "Never invent price levels — only reference levels present in the input.",
      "This is analysis and education, NOT financial advice; keep language framed as scenarios and invalidation levels.",
      "Respond ONLY with JSON matching: {\"thesis\": string, \"bullCase\": string, \"bearCase\": string, \"keyLevels\": string, \"macroContext\": string, \"riskNotes\": string}. Each field 1-3 sentences, concrete and specific.",
    ].join(" "),
    JSON.stringify(context),
    1500,
  );
  const jsonStart = text.indexOf("{");
  const jsonEnd = text.lastIndexOf("}");
  const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as Partial<AiAnalysis>;
  return {
    thesis: parsed.thesis ?? "",
    bullCase: parsed.bullCase ?? "",
    bearCase: parsed.bearCase ?? "",
    keyLevels: parsed.keyLevels ?? "",
    macroContext: parsed.macroContext ?? "",
    riskNotes: parsed.riskNotes ?? "",
  };
}

export interface DailyBriefing {
  headline: string;
  marketOverview: string;
  eventWatch: string;
  topSetups: string;
}

export async function generateBriefing(
  tickers: { symbol: string; lastPrice: number; change24hPct: number }[],
  opportunities: Opportunity[],
  events: EconomicEvent[],
): Promise<DailyBriefing> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const text = await callClaude(
    [
      "You write the daily market briefing for a trading-intelligence platform.",
      "Input: 24h market movers, top confluence-scored setups from a deterministic strategy engine, and upcoming high-impact economic events.",
      "Analysis and education only, not financial advice.",
      "Respond ONLY with JSON: {\"headline\": string, \"marketOverview\": string, \"eventWatch\": string, \"topSetups\": string}. headline is one punchy sentence; other fields 2-4 sentences.",
    ].join(" "),
    JSON.stringify({
      tickers,
      topOpportunities: opportunities.slice(0, 5),
      upcomingHighImpactEvents: events.filter((e) => e.impact === "high" && e.timestamp * 1000 > Date.now()).slice(0, 8),
    }),
    1000,
  );
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<DailyBriefing>;
  return {
    headline: parsed.headline ?? "",
    marketOverview: parsed.marketOverview ?? "",
    eventWatch: parsed.eventWatch ?? "",
    topSetups: parsed.topSetups ?? "",
  };
}
