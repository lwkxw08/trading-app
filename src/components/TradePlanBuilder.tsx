"use client";

import { useEffect, useMemo, useState } from "react";
import { calculatePosition, takeProfitLadder } from "@/lib/risk/position";
import { fmtPrice } from "./format";

interface Defaults {
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export default function TradePlanBuilder({ defaults }: { defaults?: Defaults }) {
  const [accountSize, setAccountSize] = useState(10000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [leverage, setLeverage] = useState(1);
  const [entry, setEntry] = useState(defaults?.entry ?? 0);
  const [stopLoss, setStopLoss] = useState(defaults?.stopLoss ?? 0);
  const [takeProfit, setTakeProfit] = useState(defaults?.takeProfit ?? 0);

  useEffect(() => {
    if (defaults) {
      setEntry(defaults.entry);
      setStopLoss(defaults.stopLoss);
      setTakeProfit(defaults.takeProfit);
    }
  }, [defaults]);

  const plan = useMemo(() => {
    try {
      if (entry > 0 && stopLoss > 0 && takeProfit > 0 && entry !== stopLoss) {
        return calculatePosition({ accountSize, riskPercent, entry, stopLoss, takeProfit, leverage });
      }
    } catch {
      // invalid inputs — show nothing
    }
    return null;
  }, [accountSize, riskPercent, entry, stopLoss, takeProfit, leverage]);

  const ladder = useMemo(
    () => (entry > 0 && stopLoss > 0 && entry !== stopLoss ? takeProfitLadder(entry, stopLoss) : []),
    [entry, stopLoss],
  );

  return (
    <section className="rounded-lg border border-edge bg-surface p-4">
      <h2 className="mb-3 font-semibold">Trade Plan Builder</h2>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <NumberInput label="Account size ($)" value={accountSize} onChange={setAccountSize} />
        <NumberInput label="Risk %" value={riskPercent} onChange={setRiskPercent} step={0.1} />
        <NumberInput label="Entry" value={entry} onChange={setEntry} step={0.0001} />
        <NumberInput label="Leverage" value={leverage} onChange={setLeverage} />
        <NumberInput label="Stop loss" value={stopLoss} onChange={setStopLoss} step={0.0001} />
        <NumberInput label="Take profit" value={takeProfit} onChange={setTakeProfit} step={0.0001} />
      </div>
      {plan && (
        <div className="mt-4 space-y-1.5 border-t border-edge pt-3 text-sm">
          <Row label="Direction" value={plan.direction.toUpperCase()} accent={plan.direction === "long" ? "bull" : "bear"} />
          <Row label="Position size" value={`${plan.positionSize.toFixed(6)} units`} />
          <Row label="Position value" value={`$${fmtPrice(plan.positionValue)}`} />
          <Row label="Margin required" value={`$${fmtPrice(plan.marginRequired)}`} />
          <Row label="Risk amount" value={`$${fmtPrice(plan.riskAmount)}`} accent="bear" />
          <Row label="Potential profit" value={`$${fmtPrice(plan.potentialProfit)}`} accent="bull" />
          <Row label="R:R" value={plan.riskRewardRatio.toFixed(2)} />
          <Row label="Stop distance" value={`${plan.stopDistancePct.toFixed(2)}%`} />
          {ladder.length > 0 && (
            <div className="pt-1 text-xs text-muted">
              TP ladder: {ladder.map((l) => `${l.r}R ${fmtPrice(l.price)}`).join(" · ")}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <label className="block">
      <span className="text-xs text-muted">{label}</span>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full rounded-md border border-edge bg-background px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
    </label>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "bull" | "bear" }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={`font-mono ${accent === "bull" ? "text-bull" : accent === "bear" ? "text-bear" : ""}`}>{value}</span>
    </div>
  );
}
