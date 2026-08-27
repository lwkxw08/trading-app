import { apiUrl } from "@/components/api";
import type { Opportunity } from "@/lib/strategies/types";
import type { AlertEvent, AlertRule } from "./types";

interface TickerLite {
  symbol: string;
  lastPrice: number;
}

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Evaluates all enabled rules against live data. Returns the triggered
 * events and the rules array with updated cooldown timestamps.
 */
export async function checkAlertRules(rules: AlertRule[]): Promise<{ events: AlertEvent[]; rules: AlertRule[] }> {
  const now = Date.now();
  const events: AlertEvent[] = [];
  const next = rules.map((r) => ({ ...r }));

  // --- Price level rules: one tickers fetch for all symbols ---
  const priceRules = next.filter(
    (r): r is Extract<AlertRule, { type: "price_level" }> =>
      r.type === "price_level" && r.enabled && (r.lastFiredAt === null || now - r.lastFiredAt >= r.cooldownMin * 60_000),
  );
  if (priceRules.length > 0) {
    const symbols = [...new Set(priceRules.map((r) => r.symbol))].join(",");
    try {
      const res = await fetch(apiUrl(`/api/tickers?symbols=${encodeURIComponent(symbols)}`));
      const data = (await res.json()) as { tickers?: TickerLite[] };
      const bySymbol = new Map((data.tickers ?? []).map((t) => [t.symbol, t.lastPrice]));
      for (const rule of priceRules) {
        const price = bySymbol.get(rule.symbol);
        if (price === undefined) continue;
        const hit = rule.condition === "above" ? price >= rule.level : price <= rule.level;
        if (hit) {
          rule.lastFiredAt = now;
          events.push({
            id: uid(),
            time: now,
            ruleId: rule.id,
            message: `${rule.symbol} crossed ${rule.condition} ${rule.level} (last ${price})${rule.note ? ` — ${rule.note}` : ""}`,
          });
        }
      }
    } catch {
      // network failure — skip this cycle, retry next interval
    }
  }

  // --- Setup rules: one scan per (symbols, tf) combination ---
  const setupRules = next.filter((r): r is Extract<AlertRule, { type: "setup" }> => r.type === "setup" && r.enabled);
  const scans = new Map<string, Promise<Opportunity[]>>();
  for (const rule of setupRules) {
    const key = `${rule.symbols}|${rule.tf}|${rule.setup ?? ""}`;
    if (!scans.has(key)) {
      const params = new URLSearchParams({ tf: rule.tf });
      if (rule.symbols.trim()) params.set("symbols", rule.symbols.trim());
      if (rule.setup) params.set("setup", rule.setup);
      scans.set(
        key,
        fetch(apiUrl(`/api/scan?${params}`))
          .then((r) => r.json())
          .then((d: { opportunities?: Opportunity[] }) => d.opportunities ?? [])
          .catch(() => []),
      );
    }
  }
  for (const rule of setupRules) {
    const opps = await scans.get(`${rule.symbols}|${rule.tf}|${rule.setup ?? ""}`)!;
    for (const opp of opps) {
      if (opp.score < rule.minScore) continue;
      if (rule.direction !== "both" && opp.direction !== rule.direction) continue;
      const key = `${opp.symbol}:${opp.direction}`;
      const last = rule.lastFired[key];
      if (last !== undefined && now - last < rule.cooldownMin * 60_000) continue;
      rule.lastFired[key] = now;
      events.push({
        id: uid(),
        time: now,
        ruleId: rule.id,
        message: rule.setup === "trendbreak"
          ? `${opp.symbol} ${opp.direction.toUpperCase()} 15m Trend Break → 1m FVG ready — entry ${opp.entry}, SL ${opp.stopLoss}, TP ${opp.takeProfit}`
          : rule.setup === "sessionopen"
            ? `${opp.symbol} ${opp.direction.toUpperCase()} Session Open Range ready — entry ${opp.entry}, SL ${opp.stopLoss}, TP ${opp.takeProfit}`
            : `${opp.symbol} ${opp.direction.toUpperCase()} setup on ${rule.tf} — score ${opp.score}, entry ${opp.entry}, SL ${opp.stopLoss}, TP ${opp.takeProfit}`,
      });
    }
  }

  return { events, rules: next };
}
