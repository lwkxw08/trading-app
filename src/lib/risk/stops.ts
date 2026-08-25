import type { StrategyAnalysis } from "@/lib/strategies/types";

export interface StopCandidate {
  label: string;
  price: number;
  basis: string;
}

/**
 * Deterministic stop-loss candidates for a planned trade: each one sits just
 * beyond a detected structure (swing, HVN, FVG, order block, pullback zone)
 * or falls back to an ATR buffer. The AI layer may recommend among these but
 * never invents its own levels.
 */
export function suggestStopCandidates(a: StrategyAnalysis, direction: "long" | "short", entry: number): StopCandidate[] {
  const bull = direction === "long";
  const atrVal = a.trend.atr14 ?? entry * 0.01;
  const out: StopCandidate[] = [];
  const push = (label: string, price: number, basis: string) => {
    if (price > 0 && (bull ? price < entry : price > entry)) out.push({ label, price, basis });
  };

  const swing = a.swings
    .slice(-12)
    .filter((s) => (bull ? s.type === "low" && s.price < entry : s.type === "high" && s.price > entry))
    .sort((x, y) => (bull ? y.price - x.price : x.price - y.price))[0];
  if (swing) {
    push("Swing", bull ? swing.price - 0.25 * atrVal : swing.price + 0.25 * atrVal, `Beyond the last swing ${swing.type} at ${swing.price}`);
  }

  const hvn = a.volumeProfile.hvns
    .filter((nd) => (bull ? nd.price < entry : nd.price > entry))
    .sort((x, y) => (bull ? y.price - x.price : x.price - y.price))[0];
  if (hvn) {
    push("HVN", bull ? hvn.price - 0.5 * atrVal : hvn.price + 0.5 * atrVal, `Beyond the high-volume node at ${hvn.price} — invalid once the node fails`);
  }

  const fvg = a.fvgs
    .filter((g) => !g.filled && g.direction === (bull ? "bullish" : "bearish") && (bull ? g.bottom < entry : g.top > entry))
    .sort((x, y) => (bull ? y.bottom - x.bottom : x.top - y.top))[0];
  if (fvg) {
    push("FVG", bull ? fvg.bottom - 0.1 * atrVal : fvg.top + 0.1 * atrVal, `Beyond the ${bull ? "bullish" : "bearish"} FVG — gap fully traded through means the imbalance failed`);
  }

  const ob = a.orderBlocks
    .filter((b) => !b.mitigated && b.direction === (bull ? "bullish" : "bearish") && (bull ? b.bottom < entry : b.top > entry))
    .sort((x, y) => (bull ? y.bottom - x.bottom : x.top - y.top))[0];
  if (ob) {
    push("Order block", bull ? ob.bottom - 0.1 * atrVal : ob.top + 0.1 * atrVal, "Beyond the order block that anchors the setup");
  }

  const pullback = a.hvnFvgPullbacks.find((s) => s.direction === (bull ? "bullish" : "bearish") && s.state !== "invalidated");
  if (pullback) {
    push(
      "HVN+FVG zone",
      bull ? pullback.zoneBottom - 0.25 * atrVal : pullback.zoneTop + 0.25 * atrVal,
      "Beyond the impulse HVN+FVG entry zone — a close through it invalidates the pullback setup",
    );
  }

  push("ATR", bull ? entry - 1.5 * atrVal : entry + 1.5 * atrVal, "1.5 ATR volatility buffer (fallback when no structure is nearby)");

  // dedupe near-identical levels, closest stop first
  const deduped: StopCandidate[] = [];
  for (const c of out.sort((x, y) => Math.abs(x.price - entry) - Math.abs(y.price - entry))) {
    if (deduped.every((k) => Math.abs(k.price - c.price) > 0.2 * atrVal)) deduped.push(c);
  }
  return deduped.slice(0, 4);
}
