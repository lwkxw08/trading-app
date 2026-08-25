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

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** Minimal fetch-based Anthropic Messages API client (edge-runtime compatible). */
async function callClaudeMessages(system: string, messages: ChatTurn[], maxTokens: number): Promise<string> {
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
      messages,
    }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as AnthropicMessageResponse;
  return data.content.find((b) => b.type === "text")?.text ?? "{}";
}

async function callClaude(system: string, userContent: string, maxTokens: number): Promise<string> {
  return callClaudeMessages(system, [{ role: "user", content: userContent }], maxTokens);
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
    volumeProfile: { poc: analysis.volumeProfile.poc, vah: analysis.volumeProfile.vah, val: analysis.volumeProfile.val, hvns: analysis.volumeProfile.hvns, lvns: analysis.volumeProfile.lvns },
    hvnFvgPullbackSetups: analysis.hvnFvgPullbacks,
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

/**
 * Conversational follow-ups on an analysis: the model answers questions about
 * the deterministic engine's structured output (scores, structures, levels,
 * macro events) — it never invents levels or new calculations.
 */
export async function chatOnAnalysis(
  analysis: StrategyAnalysis,
  opportunities: Opportunity[],
  events: EconomicEvent[],
  messages: ChatTurn[],
): Promise<string> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const context = {
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    lastPrice: analysis.lastPrice,
    trend: analysis.trend,
    higherTimeframeTrend: analysis.higherTimeframeTrend,
    volumeProfile: { poc: analysis.volumeProfile.poc, vah: analysis.volumeProfile.vah, val: analysis.volumeProfile.val, hvns: analysis.volumeProfile.hvns, lvns: analysis.volumeProfile.lvns },
    hvnFvgPullbackSetups: analysis.hvnFvgPullbacks,
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

  return callClaudeMessages(
    [
      "You are a market analyst answering follow-up questions about one symbol's technical analysis on a trading-intelligence platform.",
      "You are given deterministic, pre-computed technical structures (fair value gaps, order blocks, volume profile, trend state, swing points, liquidity sweeps, BOS/CHoCH structure breaks, anchored VWAP, session levels), confluence-scored setups with their factor breakdowns, and upcoming economic events.",
      "Answer strictly from this data. Never invent price levels — only reference levels present in the input. If the data cannot answer the question, say so.",
      "Explain how the confluence score is composed of its listed factors when asked why something scores as it does; discuss invalidation in terms of the provided stop, structure and levels.",
      "Analysis and education only, not financial advice. Answer in plain prose (no JSON), concise: 2-6 sentences unless more detail is genuinely needed.",
      `Analysis context: ${JSON.stringify(context)}`,
    ].join(" "),
    messages,
    1200,
  );
}

export interface StopAdvice {
  recommendedStop: number;
  rationale: string;
  alternatives: string;
}

/**
 * AI stop-placement advice: Claude receives the trade plan (entry, TP,
 * direction) plus deterministic stop candidates derived from structure and
 * must recommend one of those candidates — it never invents its own level.
 */
export async function suggestStopAdvice(
  analysis: StrategyAnalysis,
  plan: { direction: "long" | "short"; entry: number; takeProfit: number },
  candidates: { label: string; price: number; basis: string }[],
): Promise<StopAdvice> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");
  if (candidates.length === 0) throw new Error("No stop candidates for this plan");

  const context = {
    symbol: analysis.symbol,
    timeframe: analysis.timeframe,
    lastPrice: analysis.lastPrice,
    atr14: analysis.trend.atr14,
    trend: analysis.trend,
    higherTimeframeTrend: analysis.higherTimeframeTrend,
    plan,
    stopCandidates: candidates.map((c) => ({
      ...c,
      riskRewardRatio: Math.abs(c.price - plan.entry) > 0 ? Math.abs(plan.takeProfit - plan.entry) / Math.abs(c.price - plan.entry) : 0,
    })),
    volumeProfile: { poc: analysis.volumeProfile.poc, vah: analysis.volumeProfile.vah, val: analysis.volumeProfile.val, hvns: analysis.volumeProfile.hvns, lvns: analysis.volumeProfile.lvns },
    hvnFvgPullbackSetups: analysis.hvnFvgPullbacks,
    recentSwings: analysis.swings.slice(-8),
  };

  const text = await callClaude(
    [
      "You advise on stop-loss placement for a planned trade on a trading-intelligence platform.",
      "Input: the trade plan (direction, entry, take profit), deterministic stop candidates each derived from a detected structure (with the resulting risk:reward), and the surrounding technical context.",
      "Recommend exactly ONE of the provided candidate prices — never invent a different level. Weigh structure quality (is the stop behind something real?), stop distance vs ATR (too tight gets wicked out, too wide wrecks R:R), and the resulting risk:reward against the take profit.",
      "Analysis and education only, not financial advice.",
      'Respond ONLY with JSON: {"recommendedStop": number (one of the candidate prices), "rationale": string (2-3 sentences), "alternatives": string (1-2 sentences on when a different candidate would be better)}.',
    ].join(" "),
    JSON.stringify(context),
    700,
  );
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<StopAdvice>;
  const recommended = typeof parsed.recommendedStop === "number" ? parsed.recommendedStop : candidates[0].price;
  const matched = candidates.reduce((best, c) => (Math.abs(c.price - recommended) < Math.abs(best.price - recommended) ? c : best), candidates[0]);
  return {
    recommendedStop: matched.price,
    rationale: parsed.rationale ?? "",
    alternatives: parsed.alternatives ?? "",
  };
}

export interface JournalReview {
  overview: string;
  edgeAnalysis: string;
  executionAnalysis: string;
  patterns: string;
  refinements: string[];
  riskAdvice: string;
}

/**
 * Coaching review of the user's trade journal: Claude receives closed/open
 * trades (with the confluence snapshot captured at entry) plus aggregate
 * stats, and suggests concrete strategy refinements. Advice must reference
 * only conditions the deterministic engine supports.
 */
export async function reviewJournal(payload: unknown): Promise<JournalReview> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const supported = CONDITION_LIBRARY.map((c) => c.label).join(", ");
  const text = await callClaude(
    [
      "You are a trading performance coach for a trading-intelligence platform.",
      "Input: the user's trade journal — each trade has direction, entry/exit, stop/target, the platform's confluence score and factors detected at entry, market trend/RSI snapshot, and notes — plus aggregate stats (win rate, avg R, per-factor and per-strategy performance).",
      "Analyze what is working and what is not: which confluence factors and strategies correlate with wins/losses, entry/exit quality vs the recorded stop/target plan, direction or session biases, and risk consistency.",
      `When suggesting refinements, only reference conditions the platform supports: ${supported}. Refinements should be specific and actionable (e.g. tighten a filter, require an extra confluence, adjust R targets), not generic platitudes.`,
      "If the sample is small, say so and keep conclusions tentative. Educational analysis only, not financial advice.",
      'Respond ONLY with JSON: {"overview": string, "edgeAnalysis": string, "executionAnalysis": string, "patterns": string, "refinements": [string], "riskAdvice": string}. Each string field 2-4 sentences; refinements is 3-6 short actionable items.',
    ].join(" "),
    JSON.stringify(payload),
    1800,
  );
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<JournalReview>;
  return {
    overview: parsed.overview ?? "",
    edgeAnalysis: parsed.edgeAnalysis ?? "",
    executionAnalysis: parsed.executionAnalysis ?? "",
    patterns: parsed.patterns ?? "",
    refinements: Array.isArray(parsed.refinements) ? parsed.refinements.filter((r): r is string => typeof r === "string") : [],
    riskAdvice: parsed.riskAdvice ?? "",
  };
}

export interface GapReview {
  overview: string;
  missedEntries: string;
  exitDiscipline: string;
  unsignalledTrades: string;
  actions: string[];
}

/**
 * Discipline-mirror narrative: Claude receives the deterministic gap findings
 * (journal trades vs what the strategy actually signalled over the same
 * period) and turns them into coaching. It must only discuss the supplied
 * events — it never invents trades or signals.
 */
export async function reviewGaps(payload: unknown): Promise<GapReview> {
  if (!isAiConfigured()) throw new Error("ANTHROPIC_API_KEY not configured");

  const text = await callClaude(
    [
      "You are a trading discipline coach for a trading-intelligence platform.",
      "Input: deterministic gap findings comparing the user's executed journal trades against what the platform's strategy engine signalled over the same period — missed signalled entries, entries taken with no signal, exits cut short of the signal's outcome, and quick re-entries after losses.",
      "Discuss ONLY the supplied events and counts; never invent trades, signals, or price levels. Note: simTradesAcrossFullBacktestWindow counts simulated trades over the entire history window, most of which may predate the user's journalling — only signalsDuringJournalledPeriod and the missed_entry events represent signals the user could actually have taken. Focus on behavioral patterns: hesitation, overtrading, cutting winners, revenge trading, and consistency between the plan and execution.",
      "If there are few or no events, say the execution tracked the strategy well and keep it brief. Educational analysis only, not financial advice.",
      'Respond ONLY with JSON: {"overview": string, "missedEntries": string, "exitDiscipline": string, "unsignalledTrades": string, "actions": [string]}. Each string field 2-4 sentences; actions is 2-5 short behavioral rules.',
    ].join(" "),
    JSON.stringify(payload),
    1400,
  );
  const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Partial<GapReview>;
  return {
    overview: parsed.overview ?? "",
    missedEntries: parsed.missedEntries ?? "",
    exitDiscipline: parsed.exitDiscipline ?? "",
    unsignalledTrades: parsed.unsignalledTrades ?? "",
    actions: Array.isArray(parsed.actions) ? parsed.actions.filter((a): a is string => typeof a === "string") : [],
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
