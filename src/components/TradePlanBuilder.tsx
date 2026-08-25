"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadTrades, saveTrades } from "@/lib/journal/store";
import type { JournalTrade, MarketSnapshot } from "@/lib/journal/types";
import type { Timeframe } from "@/lib/market/types";
import { calculatePosition, takeProfitLadder } from "@/lib/risk/position";
import type { StopCandidate } from "@/lib/risk/stops";
import { apiUrl } from "./api";
import { fmtPrice } from "./format";

interface StopAdviceResult {
  candidates: StopCandidate[];
  advice: { recommendedStop: number; rationale: string; alternatives: string } | null;
  error?: string;
}

interface Defaults {
  entry: number;
  stopLoss: number;
  takeProfit: number;
}

export interface JournalContext {
  symbol: string;
  timeframe: Timeframe;
  strategyName?: string;
  snapshot?: MarketSnapshot | null;
}

export default function TradePlanBuilder({ defaults, journal }: { defaults?: Defaults; journal?: JournalContext }) {
  const [accountSize, setAccountSize] = useState(10000);
  const [riskPercent, setRiskPercent] = useState(1);
  const [leverage, setLeverage] = useState(1);
  const [entry, setEntry] = useState(defaults?.entry ?? 0);
  const [stopLoss, setStopLoss] = useState(defaults?.stopLoss ?? 0);
  const [takeProfit, setTakeProfit] = useState(defaults?.takeProfit ?? 0);

  const [logged, setLogged] = useState(false);
  const [stops, setStops] = useState<StopAdviceResult | null>(null);
  const [stopsLoading, setStopsLoading] = useState(false);
  const [stopsError, setStopsError] = useState<string | null>(null);

  useEffect(() => {
    if (defaults) {
      setEntry(defaults.entry);
      setStopLoss(defaults.stopLoss);
      setTakeProfit(defaults.takeProfit);
      setLogged(false);
      setStops(null);
      setStopsError(null);
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

  const logToJournal = useCallback(() => {
    if (!plan || !journal) return;
    const trade: JournalTrade = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      symbol: journal.symbol.toUpperCase(),
      timeframe: journal.timeframe,
      direction: plan.direction,
      status: "open",
      entryPrice: entry,
      entryTime: Date.now(),
      size: plan.positionSize,
      stopLoss,
      takeProfit,
      strategyName: journal.strategyName ?? "",
      notes: "Logged from Trade Plan Builder",
      snapshot: journal.snapshot ?? null,
      exitPrice: null,
      exitTime: null,
      exitNotes: "",
    };
    saveTrades([trade, ...loadTrades()]);
    setLogged(true);
  }, [plan, journal, entry, stopLoss, takeProfit]);

  const suggestStops = useCallback(async () => {
    if (!journal || entry <= 0 || takeProfit <= 0) return;
    setStopsLoading(true);
    setStopsError(null);
    try {
      const res = await fetch(apiUrl("/api/ai/stops"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          symbol: journal.symbol,
          tf: journal.timeframe,
          direction: takeProfit >= entry ? "long" : "short",
          entry,
          takeProfit,
        }),
      });
      const data = (await res.json()) as StopAdviceResult & { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setStops(data);
      if (data.error) setStopsError(data.error);
    } catch (e) {
      setStopsError(e instanceof Error ? e.message : "Stop suggestion failed");
    } finally {
      setStopsLoading(false);
    }
  }, [journal, entry, takeProfit]);

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
      {journal && (
        <div className="mt-3">
          <button
            onClick={suggestStops}
            disabled={stopsLoading || entry <= 0 || takeProfit <= 0}
            className="rounded-md border border-edge px-3 py-1.5 text-xs font-semibold hover:border-accent disabled:opacity-50"
          >
            {stopsLoading ? "Analysing stops…" : "Suggest stop (AI)"}
          </button>
          {stopsError && <p className="mt-2 text-xs text-bear">{stopsError}</p>}
          {stops && stops.candidates.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {stops.candidates.map((c) => {
                const risk = Math.abs(entry - c.price);
                const rr = risk > 0 ? Math.abs(takeProfit - entry) / risk : 0;
                const recommended = stops.advice?.recommendedStop === c.price;
                return (
                  <div
                    key={c.label}
                    className={`flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs ${recommended ? "border-accent" : "border-edge"}`}
                  >
                    <div className="min-w-0">
                      <span className="font-semibold">
                        {c.label} {fmtPrice(c.price)}
                      </span>
                      <span className="ml-2 text-muted">R:R {rr.toFixed(2)}</span>
                      {recommended && <span className="ml-2 text-accent">AI pick</span>}
                      <p className="truncate text-muted" title={c.basis}>
                        {c.basis}
                      </p>
                    </div>
                    <button
                      onClick={() => setStopLoss(c.price)}
                      className="shrink-0 rounded-md border border-edge px-2 py-1 font-semibold hover:border-accent"
                    >
                      Use
                    </button>
                  </div>
                );
              })}
              {stops.advice && (
                <p className="text-xs text-muted">
                  {stops.advice.rationale} {stops.advice.alternatives}
                </p>
              )}
            </div>
          )}
        </div>
      )}
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
          {journal && (
            <div className="flex items-center gap-3 pt-2">
              <button
                onClick={logToJournal}
                disabled={logged}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {logged ? "Logged to Journal" : "Log to Journal"}
              </button>
              {logged && (
                <Link href="/journal" className="text-xs text-accent hover:underline">
                  View in Journal
                </Link>
              )}
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
