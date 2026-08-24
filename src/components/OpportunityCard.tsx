"use client";

import Link from "next/link";
import { useState } from "react";
import type { Opportunity } from "@/lib/strategies/types";
import { fmtPrice } from "./format";

export function ScoreBadge({ score }: { score: number }) {
  const color = score >= 70 ? "bg-bull/20 text-bull" : score >= 55 ? "bg-accent/20 text-accent" : "bg-edge text-muted";
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${color}`}>{score}</span>;
}

export function DirectionBadge({ direction }: { direction: "long" | "short" }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-bold uppercase ${
        direction === "long" ? "bg-bull/20 text-bull" : "bg-bear/20 text-bear"
      }`}
    >
      {direction}
    </span>
  );
}

export default function OpportunityCard({ opp }: { opp: Opportunity }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-edge bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Link href={`/analyze/${opp.symbol}?tf=${opp.timeframe}`} className="font-semibold hover:text-accent">
            {opp.symbol}
          </Link>
          <span className="text-xs text-muted">{opp.timeframe}</span>
          <DirectionBadge direction={opp.direction} />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">R:R {opp.riskRewardRatio.toFixed(1)}</span>
          <ScoreBadge score={opp.score} />
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
        <div>
          <div className="text-xs text-muted">Entry</div>
          <div className="font-mono">{fmtPrice(opp.entry)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Stop Loss</div>
          <div className="font-mono text-bear">{fmtPrice(opp.stopLoss)}</div>
        </div>
        <div>
          <div className="text-xs text-muted">Take Profit</div>
          <div className="font-mono text-bull">{fmtPrice(opp.takeProfit)}</div>
        </div>
      </div>
      <button onClick={() => setExpanded(!expanded)} className="mt-3 text-xs text-accent hover:underline">
        {expanded ? "Hide" : "Show"} confluence breakdown ({opp.factors.length} factors)
      </button>
      {expanded && (
        <ul className="mt-2 space-y-1.5">
          {opp.factors.map((f, i) => (
            <li key={i} className="flex items-start justify-between gap-3 text-xs">
              <span>
                <span className="font-semibold">{f.name}:</span> <span className="text-muted">{f.detail}</span>
              </span>
              <span className={`font-mono ${f.weight >= 0 ? "text-bull" : "text-bear"}`}>
                {f.weight >= 0 ? "+" : ""}
                {f.weight}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
