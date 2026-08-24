import type { EconomicEvent } from "@/lib/calendar/types";
import { CONDITION_LIBRARY, isConditionId, type CustomStrategy } from "@/lib/strategies/custom";
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
    recentLiquiditySweeps: analysis.liquiditySweeps.slice(-5),
    structureBreaks: analysis.structureBreaks.slice(-5),
    anchoredVwap: analysis.anchoredVwap
      ? { anchorType: analysis.anchoredVwap.anchorType, value: analysis.anchoredVwap.value }
      : null,
    sessionLevels: analysis.sessionLevels.sessions,
    scoredOpportunities: opportunities,
    upcomingHighImpactEvents: events
      .filter((e) => e.impact === "high" && e.timestamp * 1000 > Date.now())
      .slice(0, 10),
  };

  const text = await callClaude(
    [
      "You are a professional market analyst for a trading-intelligence platform.",
      "You are given deterministic, pre-computed technical structures (fair value gaps, order blocks, volume profile, trend state, swing points, liquidity sweeps, BOS/CHoCH structure breaks, anchored VWAP, session levels) and upcoming economic events.",
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

/**
 * AI-assisted strategy composition: maps a plain-English strategy description
 * onto the fixed deterministic condition library. Claude can only pick
 * condition IDs and weights — it never invents calculations.
 */
export async function composeStrategy(description: string): Promise<CustomStrategy> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const library = CONDITION_LIBRARY.map((c) => ({ id: c.id, label: c.label, description: c.description, defaultWeight: c.defaultWeight }));
  const text = await callClaude(
    [
      "You compose trading strategies for a deterministic confluence engine.",
      "You are given a library of supported conditions. Map the user's plain-English strategy description onto this library.",
      "Only use condition IDs from the library — never invent new conditions. If part of the description has no matching condition, omit it.",
      "Weights reflect relative importance (roughly 5-25 each, based on how central the concept is to the described strategy).",
      "minScore is the % of total weight that must be met to signal (typically 50-80; stricter descriptions => higher).",
      `Condition library: ${JSON.stringify(library)}`,
      'Respond ONLY with JSON: {"name": string, "conditions": [{"id": string, "weight": number}], "minScore": number}.',
    ].join(" "),
    description,
    800,
  );
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
    name?: string;
    conditions?: { id?: string; weight?: number }[];
    minScore?: number;
  };
  const conditions = (parsed.conditions ?? [])
    .filter((c): c is { id: string; weight?: number } => typeof c.id === "string" && isConditionId(c.id))
    .map((c) => ({
      id: c.id as CustomStrategy["conditions"][number]["id"],
      weight: Math.min(100, Math.max(1, Math.round(c.weight ?? CONDITION_LIBRARY.find((m) => m.id === c.id)?.defaultWeight ?? 10))),
    }));
  if (conditions.length === 0) throw new Error("Could not map the description to any supported conditions");
  return {
    name: (parsed.name ?? "Custom strategy").slice(0, 60),
    conditions,
    minScore: Math.min(100, Math.max(0, Math.round(parsed.minScore ?? 60))),
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
