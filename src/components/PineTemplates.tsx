"use client";

import { useCallback, useState } from "react";
import { apiUrl } from "@/components/api";
import { PINE_TEMPLATES, type PineStrategyKind } from "@/lib/pine/templates";

/** Pre-built Pine indicator presets (formerly the Indicator Studio page). */
export default function PineTemplates() {
  const [kind, setKind] = useState<PineStrategyKind>("ema_cross");
  const [name, setName] = useState("My Signal Indicator");
  const [fastLength, setFastLength] = useState(20);
  const [slowLength, setSlowLength] = useState(50);
  const [rsiLength, setRsiLength] = useState(14);
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);
  const [riskPercent, setRiskPercent] = useState(1);
  const [atrStopMultiplier, setAtrStopMultiplier] = useState(1.5);
  const [rewardMultiple, setRewardMultiple] = useState(2);
  const [script, setScript] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(apiUrl("/api/pine"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind,
        name,
        fastLength,
        slowLength,
        rsiLength,
        rsiOversold,
        rsiOverbought,
        riskPercent,
        atrStopMultiplier,
        rewardMultiple,
      }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "generation failed");
        setScript(d.script);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [kind, name, fastLength, slowLength, rsiLength, rsiOversold, rsiOverbought, riskPercent, atrStopMultiplier, rewardMultiple]);

  const copy = useCallback(() => {
    if (!script) return;
    navigator.clipboard.writeText(script).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [script]);

  return (
    <section className="rounded-lg border border-edge bg-surface p-4">
      <h2 className="font-semibold">Starter Pine templates</h2>
      <p className="mt-1 text-xs text-muted">
        One-click pre-built indicators — pick a template, tune it, and paste the generated Pine v6 script into
        TradingView&apos;s Pine Editor. Each includes buy/sell signals, alerts, and a position-size / SL / TP table.
      </p>

      <div className="mt-3 grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            {PINE_TEMPLATES.map((t) => (
              <button
                key={t.kind}
                onClick={() => setKind(t.kind)}
                className={`rounded-lg border p-3 text-left text-sm ${
                  kind === t.kind ? "border-accent bg-accent/10" : "border-edge hover:border-muted"
                }`}
              >
                <div className="font-semibold">{t.label}</div>
                <div className="mt-1 text-xs text-muted">{t.description}</div>
              </button>
            ))}
          </div>

          <label className="block text-sm">
            <span className="text-xs text-muted">Indicator name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1 w-full rounded-md border border-edge bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>

          <div className="grid grid-cols-3 gap-3">
            {(kind === "ema_cross" || kind === "macd_momentum") && (
              <>
                <Num label={kind === "ema_cross" ? "Fast EMA" : "MACD fast"} value={fastLength} onChange={setFastLength} />
                <Num label={kind === "ema_cross" ? "Slow EMA" : "MACD slow"} value={slowLength} onChange={setSlowLength} />
              </>
            )}
            {kind === "rsi_reversal" && (
              <>
                <Num label="RSI length" value={rsiLength} onChange={setRsiLength} />
                <Num label="Oversold" value={rsiOversold} onChange={setRsiOversold} />
                <Num label="Overbought" value={rsiOverbought} onChange={setRsiOverbought} />
              </>
            )}
            <Num label="Risk %" value={riskPercent} onChange={setRiskPercent} step={0.1} />
            <Num label="ATR stop ×" value={atrStopMultiplier} onChange={setAtrStopMultiplier} step={0.25} />
            <Num label="Reward (R)" value={rewardMultiple} onChange={setRewardMultiple} step={0.5} />
          </div>

          <button
            onClick={generate}
            disabled={loading || !name.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50"
          >
            {loading ? "Generating…" : "Generate Pine Script"}
          </button>
          {error && <p className="text-sm text-bear">{error}</p>}
        </div>

        <div className="rounded-lg border border-edge bg-background">
          <div className="flex items-center justify-between border-b border-edge px-4 py-2">
            <span className="text-xs font-semibold uppercase text-muted">Pine Script v6</span>
            <button
              onClick={copy}
              disabled={!script}
              className="rounded-md border border-edge px-3 py-1 text-xs hover:border-accent disabled:opacity-40"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
          <pre className="max-h-[480px] overflow-auto p-4 font-mono text-xs leading-relaxed">
            {script ?? "// Generated script will appear here"}
          </pre>
        </div>
      </div>
    </section>
  );
}

function Num({
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
    <label className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="mt-1 w-full rounded-md border border-edge bg-background px-2 py-1.5 font-mono text-sm outline-none focus:border-accent"
      />
    </label>
  );
}
