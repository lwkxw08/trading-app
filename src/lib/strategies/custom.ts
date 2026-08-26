import { buildTradeLevels } from "./confluence";
import { buildRiskTradeLevels, type RiskSettings } from "./risk";
import type { ConfluenceFactor, Opportunity, StrategyAnalysis } from "./types";
import { evaluateUserCondition, type UserCondition } from "./userConditions";

/**
 * Custom strategy builder: users pick conditions from the deterministic
 * detector library, assign their own weights, and the strategy is evaluated
 * against the same StrategyAnalysis the built-in confluence engine uses.
 * Score = 100 * (sum of met weights) / (sum of all weights).
 */

export type ConditionId =
  | "fvg_retest"
  | "order_block"
  | "volume_profile_value"
  | "hvn_level"
  | "lvn_path"
  | "hvn_fvg_pullback"
  | "liquidity_sweep"
  | "bos"
  | "choch"
  | "anchored_vwap"
  | "session_level"
  | "trend_alignment"
  | "htf_alignment"
  | "rsi_extreme"
  | "macd_momentum";

export interface CustomCondition {
  id: ConditionId;
  weight: number; // relative importance, > 0
}

export interface WeightedUserCondition {
  condition: UserCondition;
  weight: number;
}

export interface CustomStrategy {
  name: string;
  conditions: CustomCondition[];
  minScore: number; // 0..100, minimum % of weighted conditions met
  /** user-built conditions (definitions embedded so strategies are self-contained) */
  userConditions?: WeightedUserCondition[];
  /** SL/TP placement rules; omitted = structure defaults */
  risk?: RiskSettings;
}

export interface ConditionMeta {
  id: ConditionId;
  label: string;
  description: string;
  defaultWeight: number;
  pineSupported: boolean;
}

export const CONDITION_LIBRARY: ConditionMeta[] = [
  { id: "fvg_retest", label: "Fair Value Gap retest", description: "Price within 1 ATR of an unfilled FVG in trade direction", defaultWeight: 20, pineSupported: true },
  { id: "order_block", label: "Order block", description: "Unmitigated order block near price in trade direction", defaultWeight: 18, pineSupported: false },
  { id: "volume_profile_value", label: "Volume profile value area", description: "Longs between VAL and POC, shorts between POC and VAH", defaultWeight: 15, pineSupported: false },
  { id: "hvn_level", label: "High-volume node level", description: "An HVN within 1 ATR acting as support (longs) or resistance (shorts)", defaultWeight: 12, pineSupported: false },
  { id: "lvn_path", label: "Low-volume node path", description: "An LVN within 2 ATR in the trade direction — thin volume eases the move", defaultWeight: 6, pineSupported: false },
  { id: "hvn_fvg_pullback", label: "Impulse HVN + FVG pullback", description: "Sharp move whose heavy volume node coincides with an FVG; price pulled back into that zone or is bouncing away from it", defaultWeight: 20, pineSupported: false },
  { id: "liquidity_sweep", label: "Liquidity sweep", description: "Stop hunt beyond a swing high/low reclaimed within last 10 bars", defaultWeight: 16, pineSupported: true },
  { id: "bos", label: "Break of Structure (BOS)", description: "Latest structure break continues in trade direction", defaultWeight: 10, pineSupported: true },
  { id: "choch", label: "Change of Character (CHoCH)", description: "Latest structure break is a reversal into trade direction", defaultWeight: 14, pineSupported: true },
  { id: "anchored_vwap", label: "Anchored VWAP", description: "Price on the right side of the swing-anchored VWAP", defaultWeight: 10, pineSupported: true },
  { id: "session_level", label: "Session level reaction", description: "Price at a prior Asia/London/NY session high or low", defaultWeight: 8, pineSupported: true },
  { id: "trend_alignment", label: "Trend alignment", description: "EMA20/50 trend on the trading timeframe agrees", defaultWeight: 15, pineSupported: true },
  { id: "htf_alignment", label: "Higher-timeframe alignment", description: "The next timeframe up trends in the same direction", defaultWeight: 12, pineSupported: true },
  { id: "rsi_extreme", label: "RSI extreme", description: "RSI oversold for longs (<35) / overbought for shorts (>65)", defaultWeight: 8, pineSupported: true },
  { id: "macd_momentum", label: "MACD momentum", description: "MACD histogram supports trade direction", defaultWeight: 6, pineSupported: true },
];

export const CONDITION_IDS = CONDITION_LIBRARY.map((c) => c.id);

export function isConditionId(id: string): id is ConditionId {
  return (CONDITION_IDS as string[]).includes(id);
}

/** Whether a condition is currently met for the given direction. */
function conditionMet(id: ConditionId, a: StrategyAnalysis, direction: "long" | "short"): { met: boolean; detail: string } {
  const price = a.lastPrice;
  const atrVal = a.trend.atr14 ?? price * 0.01;
  const near = atrVal;
  const bull = direction === "long";
  const dir = bull ? "bullish" : "bearish";

  switch (id) {
    case "fvg_retest": {
      const hits = a.fvgs.filter(
        (g) => !g.filled && g.direction === dir &&
          (bull ? price - g.top <= near && price >= g.bottom : g.bottom - price <= near && price <= g.top),
      );
      return { met: hits.length > 0, detail: `${hits.length} unfilled ${dir} FVG(s) within 1 ATR` };
    }
    case "order_block": {
      const hits = a.orderBlocks.filter(
        (b) => !b.mitigated && b.direction === dir && (bull ? Math.abs(price - b.top) <= near : Math.abs(price - b.bottom) <= near),
      );
      return { met: hits.length > 0, detail: hits.length > 0 ? `Unmitigated ${dir} order block near price` : "No order block near price" };
    }
    case "volume_profile_value": {
      const vp = a.volumeProfile;
      const met = bull ? price >= vp.val && price <= vp.poc : price <= vp.vah && price >= vp.poc;
      return { met, detail: met ? (bull ? "Price in value-area discount (VAL–POC)" : "Price in value-area premium (POC–VAH)") : "Price outside favorable value area" };
    }
    case "hvn_level": {
      const hit = a.volumeProfile.hvns.find((nd) => (bull ? price >= nd.price && price - nd.price <= near : nd.price >= price && nd.price - price <= near));
      return { met: Boolean(hit), detail: hit ? `HVN at ${hit.price.toFixed(2)} acting as ${bull ? "support" : "resistance"}` : "No HVN within 1 ATR on the right side" };
    }
    case "lvn_path": {
      const hit = a.volumeProfile.lvns.find((nd) => (bull ? nd.price > price && nd.price - price <= 2 * atrVal : nd.price < price && price - nd.price <= 2 * atrVal));
      return { met: Boolean(hit), detail: hit ? `LVN at ${hit.price.toFixed(2)} ${bull ? "above" : "below"} — thin-volume path` : "No LVN ahead within 2 ATR" };
    }
    case "hvn_fvg_pullback": {
      const hit = a.hvnFvgPullbacks.find((s) => s.direction === dir && (s.state === "in_pullback" || s.state === "bounced"));
      return {
        met: Boolean(hit),
        detail: hit
          ? `${hit.state === "bounced" ? "Bouncing from" : "In pullback to"} HVN+FVG zone ${hit.zoneBottom.toFixed(2)}–${hit.zoneTop.toFixed(2)}, target ${hit.target.toFixed(2)}`
          : "No impulse HVN+FVG pullback in play",
      };
    }
    case "liquidity_sweep": {
      const recentBars = a.candles.length - 1;
      const hits = a.liquiditySweeps.filter((s) => s.direction === dir && recentBars - s.index <= 10);
      return { met: hits.length > 0, detail: hits.length > 0 ? `Swept ${bull ? "lows" : "highs"} at ${hits[hits.length - 1].sweptLevel} within last 10 bars` : "No recent sweep" };
    }
    case "bos": {
      const last = a.structureBreaks[a.structureBreaks.length - 1];
      const met = Boolean(last && last.type === "bos" && last.direction === dir);
      return { met, detail: met ? `BOS ${dir} through ${last.brokenLevel}` : "No aligned BOS" };
    }
    case "choch": {
      const last = a.structureBreaks[a.structureBreaks.length - 1];
      const met = Boolean(last && last.type === "choch" && last.direction === dir);
      return { met, detail: met ? `CHoCH ${dir} through ${last.brokenLevel}` : "No aligned CHoCH" };
    }
    case "anchored_vwap": {
      const v = a.anchoredVwap;
      const met = Boolean(v && (bull ? price > v.value : price < v.value));
      return { met, detail: v ? `Price ${price > v.value ? "above" : "below"} AVWAP ${v.value.toFixed(2)}` : "No AVWAP anchor" };
    }
    case "session_level": {
      const hit = a.sessionLevels.sessions.find((s) => Math.abs(price - (bull ? s.low : s.high)) <= near * 0.5);
      return { met: Boolean(hit), detail: hit ? `Price at ${hit.name} session ${bull ? "low" : "high"}` : "Not at a session level" };
    }
    case "trend_alignment": {
      const met = bull ? a.trend.direction === "up" : a.trend.direction === "down";
      return { met, detail: `${a.timeframe} trend is ${a.trend.direction}` };
    }
    case "htf_alignment": {
      const htf = a.higherTimeframeTrend;
      const met = Boolean(htf && (bull ? htf.direction === "up" : htf.direction === "down"));
      return { met, detail: htf ? `${htf.timeframe} trend is ${htf.direction}` : "No higher-timeframe data" };
    }
    case "rsi_extreme": {
      const rsiVal = a.trend.rsi14;
      const met = rsiVal !== null && (bull ? rsiVal < 35 : rsiVal > 65);
      return { met, detail: rsiVal !== null ? `RSI ${rsiVal.toFixed(1)}` : "No RSI data" };
    }
    case "macd_momentum": {
      const hist = a.trend.macdHistogram;
      const met = hist !== null && (bull ? hist > 0 : hist < 0);
      return { met, detail: hist !== null ? `MACD histogram ${hist > 0 ? "positive" : "negative"}` : "No MACD data" };
    }
  }
}

export interface CustomEvaluation {
  direction: "long" | "short";
  score: number; // 0..100 weighted percentage of conditions met
  qualifies: boolean;
  factors: (ConfluenceFactor & { met: boolean })[];
  opportunity: Opportunity | null;
}

/** Evaluates a custom strategy against an analysis for both directions. */
export function evaluateCustomStrategy(a: StrategyAnalysis, strategy: CustomStrategy): CustomEvaluation[] {
  const results: CustomEvaluation[] = [];
  const userConds = strategy.userConditions ?? [];
  const totalWeight =
    strategy.conditions.reduce((s, c) => s + Math.max(0, c.weight), 0) +
    userConds.reduce((s, c) => s + Math.max(0, c.weight), 0);
  for (const direction of ["long", "short"] as const) {
    const factors: (ConfluenceFactor & { met: boolean })[] = [];
    let metWeight = 0;
    for (const cond of strategy.conditions) {
      const meta = CONDITION_LIBRARY.find((m) => m.id === cond.id);
      if (!meta) continue;
      const { met, detail } = conditionMet(cond.id, a, direction);
      if (met) metWeight += Math.max(0, cond.weight);
      factors.push({ name: meta.label, detail, weight: met ? cond.weight : 0, met });
    }
    for (const uc of userConds) {
      const { met, detail } = evaluateUserCondition(uc.condition, a, direction);
      if (met) metWeight += Math.max(0, uc.weight);
      factors.push({ name: uc.condition.label, detail, weight: met ? uc.weight : 0, met });
    }
    const score = totalWeight > 0 ? Math.round((100 * metWeight) / totalWeight) : 0;
    const qualifies = score >= strategy.minScore && factors.some((f) => f.met);
    const opportunity: Opportunity | null = qualifies
      ? {
          symbol: a.symbol,
          timeframe: a.timeframe,
          direction,
          score,
          factors: factors.filter((f) => f.met),
          ...(strategy.risk ? buildRiskTradeLevels(a, direction, strategy.risk) : buildTradeLevels(a, direction)),
          generatedAt: Date.now(),
          regime: a.regime.regime,
        }
      : null;
    results.push({ direction, score, qualifies, factors, opportunity });
  }
  return results.sort((x, y) => y.score - x.score);
}
