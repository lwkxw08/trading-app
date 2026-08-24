export interface PositionInput {
  accountSize: number;
  riskPercent: number; // e.g. 1 = risk 1% of account
  entry: number;
  stopLoss: number;
  takeProfit: number;
  leverage?: number;
}

export interface PositionPlan {
  direction: "long" | "short";
  riskAmount: number;
  positionSize: number; // units of the asset
  positionValue: number; // in quote currency
  marginRequired: number;
  riskRewardRatio: number;
  potentialProfit: number;
  potentialLoss: number;
  stopDistancePct: number;
  breakEvenPrice: number;
}

export function calculatePosition(input: PositionInput): PositionPlan {
  const { accountSize, riskPercent, entry, stopLoss, takeProfit } = input;
  const leverage = input.leverage ?? 1;
  if (entry <= 0 || stopLoss <= 0) throw new Error("Entry and stop loss must be positive");
  if (entry === stopLoss) throw new Error("Entry and stop loss cannot be equal");

  const direction: "long" | "short" = stopLoss < entry ? "long" : "short";
  const riskAmount = accountSize * (riskPercent / 100);
  const stopDistance = Math.abs(entry - stopLoss);
  const positionSize = riskAmount / stopDistance;
  const positionValue = positionSize * entry;
  const rewardDistance = Math.abs(takeProfit - entry);

  return {
    direction,
    riskAmount,
    positionSize,
    positionValue,
    marginRequired: positionValue / leverage,
    riskRewardRatio: stopDistance > 0 ? rewardDistance / stopDistance : 0,
    potentialProfit: positionSize * rewardDistance,
    potentialLoss: riskAmount,
    stopDistancePct: (stopDistance / entry) * 100,
    breakEvenPrice: entry,
  };
}

/** A ladder of take-profit levels at the given R multiples. */
export function takeProfitLadder(entry: number, stopLoss: number, rMultiples: number[] = [1, 2, 3]): { r: number; price: number }[] {
  const risk = Math.abs(entry - stopLoss);
  const sign = stopLoss < entry ? 1 : -1;
  return rMultiples.map((r) => ({ r, price: entry + sign * r * risk }));
}
