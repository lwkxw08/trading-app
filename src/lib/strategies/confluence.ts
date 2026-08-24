import type { EconomicEvent } from "@/lib/calendar/types";
import type { ConfluenceFactor, Opportunity, StrategyAnalysis } from "./types";

const NEAR_ZONE_ATR = 1.0; // price within 1 ATR of a zone counts as "near"

/**
 * Turns a StrategyAnalysis into zero, one, or two scored opportunities
 * (long and/or short) based on confluence of detected structures.
 */
export function scoreOpportunities(analysis: StrategyAnalysis, upcomingEvents: EconomicEvent[] = []): Opportunity[] {
  const out: Opportunity[] = [];
  for (const direction of ["long", "short"] as const) {
    const opp = scoreDirection(analysis, direction, upcomingEvents);
    if (opp && opp.score >= 40) out.push(opp);
  }
  return out.sort((a, b) => b.score - a.score);
}

function scoreDirection(a: StrategyAnalysis, direction: "long" | "short", events: EconomicEvent[]): Opportunity | null {
  const price = a.lastPrice;
  const atrVal = a.trend.atr14 ?? price * 0.01;
  const near = NEAR_ZONE_ATR * atrVal;
  const wantBullish = direction === "long";
  const factors: ConfluenceFactor[] = [];

  // 1. Unfilled FVG near price in our direction (retest entry)
  const activeFvgs = a.fvgs.filter(
    (g) => !g.filled && g.direction === (wantBullish ? "bullish" : "bearish") &&
      (wantBullish ? price - g.top <= near && price >= g.bottom : g.bottom - price <= near && price <= g.top),
  );
  if (activeFvgs.length > 0) {
    factors.push({ name: "Fair Value Gap", detail: `${activeFvgs.length} unfilled ${wantBullish ? "bullish" : "bearish"} FVG(s) within 1 ATR — retest zone`, weight: 22 });
  }

  // 2. Unmitigated order block near price
  const activeObs = a.orderBlocks.filter(
    (b) => !b.mitigated && b.direction === (wantBullish ? "bullish" : "bearish") &&
      (wantBullish ? Math.abs(price - b.top) <= near : Math.abs(price - b.bottom) <= near),
  );
  if (activeObs.length > 0) {
    factors.push({ name: "Order Block", detail: `Unmitigated ${wantBullish ? "bullish" : "bearish"} order block near price`, weight: 18 });
  }

  // 3. Volume profile position
  const vp = a.volumeProfile;
  if (wantBullish && price >= vp.val && price <= vp.poc) {
    factors.push({ name: "Volume Profile", detail: "Price between VAL and POC — value-area discount for longs", weight: 15 });
  } else if (!wantBullish && price <= vp.vah && price >= vp.poc) {
    factors.push({ name: "Volume Profile", detail: "Price between POC and VAH — value-area premium for shorts", weight: 15 });
  } else if (Math.abs(price - vp.poc) <= near) {
    factors.push({ name: "Volume Profile", detail: "Price at POC — high-volume node acting as magnet/pivot", weight: 8 });
  }

  // 3b. High-volume node acting as support (longs) / resistance (shorts)
  const supportHvn = vp.hvns.find((nd) => (wantBullish ? price >= nd.price && price - nd.price <= near : nd.price >= price && nd.price - price <= near));
  if (supportHvn) {
    factors.push({
      name: "HVN Level",
      detail: `High-volume node at ${supportHvn.price.toFixed(2)} (${Math.round(supportHvn.strength * 100)}% of peak volume) acting as ${wantBullish ? "support below" : "resistance above"} price`,
      weight: 12,
    });
  }

  // 3c. Low-volume node ahead: thin volume in the trade direction eases the path to target
  const lvnAhead = vp.lvns.find((nd) => (wantBullish ? nd.price > price && nd.price - price <= 2 * atrVal : nd.price < price && price - nd.price <= 2 * atrVal));
  if (lvnAhead) {
    factors.push({
      name: "LVN Path",
      detail: `Low-volume node at ${lvnAhead.price.toFixed(2)} ${wantBullish ? "above" : "below"} — thin volume, price tends to traverse it quickly toward target`,
      weight: 6,
    });
  }

  // 4. Trend alignment on trading timeframe
  if ((wantBullish && a.trend.direction === "up") || (!wantBullish && a.trend.direction === "down")) {
    factors.push({ name: "Trend Alignment", detail: `${a.timeframe} trend is ${a.trend.direction} (price vs EMA20/50)`, weight: 15 });
  } else if (a.trend.direction !== "sideways") {
    factors.push({ name: "Counter-trend", detail: `${a.timeframe} trend is ${a.trend.direction} — trading against it`, weight: -12 });
  }

  // 5. Higher-timeframe trend alignment
  const htf = a.higherTimeframeTrend;
  if (htf) {
    if ((wantBullish && htf.direction === "up") || (!wantBullish && htf.direction === "down")) {
      factors.push({ name: "HTF Alignment", detail: `${htf.timeframe} trend agrees (${htf.direction})`, weight: 12 });
    } else if (htf.direction !== "sideways") {
      factors.push({ name: "HTF Conflict", detail: `${htf.timeframe} trend is ${htf.direction}`, weight: -10 });
    }
  }

  // 6. Momentum: RSI positioning
  const rsiVal = a.trend.rsi14;
  if (rsiVal !== null) {
    if (wantBullish && rsiVal < 35) factors.push({ name: "RSI", detail: `RSI ${rsiVal.toFixed(1)} — oversold for longs`, weight: 8 });
    else if (!wantBullish && rsiVal > 65) factors.push({ name: "RSI", detail: `RSI ${rsiVal.toFixed(1)} — overbought for shorts`, weight: 8 });
    else if (wantBullish && rsiVal > 75) factors.push({ name: "RSI", detail: `RSI ${rsiVal.toFixed(1)} — overextended against longs`, weight: -8 });
    else if (!wantBullish && rsiVal < 25) factors.push({ name: "RSI", detail: `RSI ${rsiVal.toFixed(1)} — overextended against shorts`, weight: -8 });
  }

  // 7. MACD histogram momentum
  const hist = a.trend.macdHistogram;
  if (hist !== null && ((wantBullish && hist > 0) || (!wantBullish && hist < 0))) {
    factors.push({ name: "MACD", detail: "Histogram supports direction", weight: 6 });
  }

  // 8. Liquidity sweep: recent stop hunt in our direction (reversal fuel)
  const recentBars = a.candles.length - 1;
  const recentSweeps = a.liquiditySweeps.filter(
    (s) => s.direction === (wantBullish ? "bullish" : "bearish") && recentBars - s.index <= 10,
  );
  if (recentSweeps.length > 0) {
    const s = recentSweeps[recentSweeps.length - 1];
    factors.push({ name: "Liquidity Sweep", detail: `Swept ${wantBullish ? "lows" : "highs"} at ${s.sweptLevel.toFixed(2)} and reclaimed within last 10 bars`, weight: 16 });
  }

  // 9. Market structure: latest BOS/CHoCH direction
  const lastBreak = a.structureBreaks[a.structureBreaks.length - 1];
  if (lastBreak) {
    const agrees = lastBreak.direction === (wantBullish ? "bullish" : "bearish");
    if (agrees && lastBreak.type === "choch") {
      factors.push({ name: "CHoCH", detail: `Change of character ${lastBreak.direction} through ${lastBreak.brokenLevel.toFixed(2)} — early reversal signal`, weight: 14 });
    } else if (agrees) {
      factors.push({ name: "BOS", detail: `Break of structure ${lastBreak.direction} through ${lastBreak.brokenLevel.toFixed(2)} — continuation`, weight: 10 });
    } else {
      factors.push({ name: "Structure Conflict", detail: `Latest ${lastBreak.type.toUpperCase()} is ${lastBreak.direction} — against this direction`, weight: -10 });
    }
  }

  // 10. Anchored VWAP positioning
  const avwap = a.anchoredVwap;
  if (avwap) {
    const above = price > avwap.value;
    if ((wantBullish && above) || (!wantBullish && !above)) {
      const nearVwap = Math.abs(price - avwap.value) <= near;
      factors.push({
        name: "Anchored VWAP",
        detail: `Price ${above ? "above" : "below"} AVWAP (${avwap.value.toFixed(2)}, anchored at ${avwap.anchorType.replace("_", " ")})${nearVwap ? " — retest zone" : ""}`,
        weight: nearVwap ? 10 : 6,
      });
    }
  }

  // 11. Session level reaction: price near a prior session high/low
  for (const s of a.sessionLevels.sessions) {
    const level = wantBullish ? s.low : s.high;
    if (Math.abs(price - level) <= near * 0.5) {
      factors.push({ name: "Session Level", detail: `Price at ${s.name} session ${wantBullish ? "low" : "high"} (${level.toFixed(2)}) — liquidity pool / reaction level`, weight: 8 });
      break;
    }
  }

  // 12. Macro risk window: penalize when high-impact events are near
  const soon = Date.now() + 12 * 3600 * 1000;
  const riskyEvents = events.filter((e) => e.impact === "high" && e.timestamp * 1000 > Date.now() && e.timestamp * 1000 < soon);
  if (riskyEvents.length > 0) {
    factors.push({ name: "Macro Risk Window", detail: `${riskyEvents.length} high-impact event(s) within 12h: ${riskyEvents.slice(0, 3).map((e) => e.title).join(", ")}`, weight: -10 });
  }

  // Require at least one structural reason to exist
  const structural = factors.some(
    (f) => ["Fair Value Gap", "Order Block", "Volume Profile", "HVN Level", "Liquidity Sweep", "CHoCH", "BOS"].includes(f.name) && f.weight > 0,
  );
  if (!structural) return null;

  const raw = 30 + factors.reduce((s, f) => s + f.weight, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const { entry, stopLoss, takeProfit, riskRewardRatio } = buildTradeLevels(a, direction);

  return {
    symbol: a.symbol,
    timeframe: a.timeframe,
    direction,
    score,
    factors,
    entry,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    generatedAt: Date.now(),
  };
}

/**
 * Entry/SL/TP from structure: stop beyond the recent swing (or ATR fallback),
 * TP at opposing structure or 2R fallback. Shared by built-in confluence
 * scoring and custom strategy evaluation.
 */
export function buildTradeLevels(
  a: StrategyAnalysis,
  direction: "long" | "short",
): { entry: number; stopLoss: number; takeProfit: number; riskRewardRatio: number } {
  const price = a.lastPrice;
  const atrVal = a.trend.atr14 ?? price * 0.01;
  const wantBullish = direction === "long";
  const entry = price;
  const stopDistance = 1.5 * atrVal;
  const recentSwings = a.swings.slice(-10);
  const swingLow = recentSwings.filter((s) => s.type === "low" && s.price < price).map((s) => s.price).sort((x, y) => y - x)[0];
  const swingHigh = recentSwings.filter((s) => s.type === "high" && s.price > price).map((s) => s.price).sort((x, y) => x - y)[0];

  let stopLoss: number;
  let takeProfit: number;
  if (wantBullish) {
    stopLoss = swingLow !== undefined ? Math.min(swingLow - 0.25 * atrVal, entry - 0.5 * atrVal) : entry - stopDistance;
    takeProfit = swingHigh !== undefined && swingHigh > entry + (entry - stopLoss) ? swingHigh : entry + 2 * (entry - stopLoss);
  } else {
    stopLoss = swingHigh !== undefined ? Math.max(swingHigh + 0.25 * atrVal, entry + 0.5 * atrVal) : entry + stopDistance;
    takeProfit = swingLow !== undefined && swingLow < entry - (stopLoss - entry) ? swingLow : entry - 2 * (stopLoss - entry);
  }

  const risk = Math.abs(entry - stopLoss);
  const reward = Math.abs(takeProfit - entry);
  return { entry, stopLoss, takeProfit, riskRewardRatio: risk > 0 ? reward / risk : 0 };
}
