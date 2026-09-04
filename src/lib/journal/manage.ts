import type { JournalTrade, ManagementRules } from "./types";

/** A management action that is currently due on an open trade. Advisory only —
 * the user applies it themselves (edit the stop / partial close in the Journal). */
export interface DueAction {
  kind: "break_even" | "trail" | "scale_in" | "scale_out" | "target_hit" | "stop_breached";
  tradeId: string;
  symbol: string;
  label: string;
  detail: string;
  suggestedStop?: number;
}

export const DEFAULT_RULES: ManagementRules = {
  breakEvenAtR: 1,
  trailAtR: 2,
  trailDistanceR: 1,
  scaleInAtR: null,
  scaleInPct: null,
  scaleOutAtR: 1.5,
  scaleOutPct: 50,
};

/** Current unrealized R multiple for an open trade, or null without a stop. */
export function openR(trade: JournalTrade, price: number): number | null {
  if (trade.stopLoss == null) return null;
  const risk = Math.abs(trade.entryPrice - trade.stopLoss);
  if (risk <= 0) return null;
  const move = trade.direction === "long" ? price - trade.entryPrice : trade.entryPrice - price;
  return move / risk;
}

export function dueActions(trade: JournalTrade, price: number): DueAction[] {
  if (trade.status !== "open") return [];
  const actions: DueAction[] = [];
  const long = trade.direction === "long";
  const r = openR(trade, price);
  const risk = trade.stopLoss != null ? Math.abs(trade.entryPrice - trade.stopLoss) : null;

  if (trade.stopLoss != null && (long ? price <= trade.stopLoss : price >= trade.stopLoss)) {
    actions.push({
      kind: "stop_breached",
      tradeId: trade.id,
      symbol: trade.symbol,
      label: "Stop breached",
      detail: `Price ${price} is beyond the recorded stop ${trade.stopLoss} — close or update the journal entry.`,
    });
    return actions;
  }
  if (trade.takeProfit != null && (long ? price >= trade.takeProfit : price <= trade.takeProfit)) {
    actions.push({
      kind: "target_hit",
      tradeId: trade.id,
      symbol: trade.symbol,
      label: "Target reached",
      detail: `Price ${price} has reached the recorded take-profit ${trade.takeProfit}.`,
    });
  }

  const rules = trade.management;
  if (!rules || r == null || risk == null) return actions;

  const stopAtBE = long ? trade.stopLoss != null && trade.stopLoss >= trade.entryPrice : trade.stopLoss != null && trade.stopLoss <= trade.entryPrice;
  if (rules.breakEvenAtR != null && r >= rules.breakEvenAtR && !stopAtBE) {
    actions.push({
      kind: "break_even",
      tradeId: trade.id,
      symbol: trade.symbol,
      label: "Move stop to break-even",
      detail: `Trade is at +${r.toFixed(2)}R (rule: +${rules.breakEvenAtR}R) — move the stop to entry ${trade.entryPrice}.`,
      suggestedStop: trade.entryPrice,
    });
  }
  if (rules.trailAtR != null && rules.trailDistanceR != null && r >= rules.trailAtR) {
    const trailStop = Number((long ? price - rules.trailDistanceR * risk : price + rules.trailDistanceR * risk).toPrecision(8));
    const improves = trade.stopLoss == null || (long ? trailStop > trade.stopLoss : trailStop < trade.stopLoss);
    if (improves) {
      actions.push({
        kind: "trail",
        tradeId: trade.id,
        symbol: trade.symbol,
        label: "Trail stop",
        detail: `Trade is at +${r.toFixed(2)}R (rule: trail from +${rules.trailAtR}R, ${rules.trailDistanceR}R behind) — suggested stop ${trailStop}.`,
        suggestedStop: trailStop,
      });
    }
  }
  if (rules.scaleInAtR != null && r >= rules.scaleInAtR) {
    actions.push({
      kind: "scale_in",
      tradeId: trade.id,
      symbol: trade.symbol,
      label: `Scale in${rules.scaleInPct != null ? ` ${rules.scaleInPct}%` : ""}`,
      detail: `Trade is at +${r.toFixed(2)}R (rule: +${rules.scaleInAtR}R) — planned add of ${rules.scaleInPct ?? "additional"}% is due. Re-check risk before adding.`,
    });
  }
  if (rules.scaleOutAtR != null && r >= rules.scaleOutAtR) {
    actions.push({
      kind: "scale_out",
      tradeId: trade.id,
      symbol: trade.symbol,
      label: `Scale out${rules.scaleOutPct != null ? ` ${rules.scaleOutPct}%` : ""}`,
      detail: `Trade is at +${r.toFixed(2)}R (rule: +${rules.scaleOutAtR}R) — consider taking ${rules.scaleOutPct ?? "partial"}% off.`,
    });
  }
  return actions;
}
