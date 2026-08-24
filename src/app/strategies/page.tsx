"use client";

import { useCallback, useMemo, useState } from "react";
import PineTemplates from "@/components/PineTemplates";
import { apiUrl } from "@/components/api";
import { fmtPrice } from "@/components/format";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { CONDITION_LIBRARY, type ConditionId, type CustomEvaluation, type CustomStrategy } from "@/lib/strategies/custom";

interface ConditionState {
  enabled: boolean;
  weight: number;
}

export default function StrategyLab() {
  const [name, setName] = useState("My Custom Strategy");
  const [minScore, setMinScore] = useState(60);
  const [conditions, setConditions] = useState<Record<ConditionId, ConditionState>>(
    () => Object.fromEntries(CONDITION_LIBRARY.map((c) => [c.id, { enabled: false, weight: c.defaultWeight }])) as Record<ConditionId, ConditionState>,
  );
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [tf, setTf] = useState<Timeframe>("1h");
  const [evaluations, setEvaluations] = useState<CustomEvaluation[] | null>(null);
  const [evalPrice, setEvalPrice] = useState<number | null>(null);
  const [evalLoading, setEvalLoading] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [composeLoading, setComposeLoading] = useState(false);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [script, setScript] = useState<string | null>(null);
  const [pineError, setPineError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const strategy = useMemo<CustomStrategy>(
    () => ({
      name,
      minScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
    }),
    [name, minScore, conditions],
  );

  const runEval = useCallback(() => {
    setEvalLoading(true);
    setEvalError(null);
    setEvaluations(null);
    fetch(apiUrl("/api/strategy/eval"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: symbol.toUpperCase(), tf, strategy }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "evaluation failed");
        setEvaluations(d.evaluations);
        setEvalPrice(d.lastPrice);
      })
      .catch((e) => setEvalError(e.message))
      .finally(() => setEvalLoading(false));
  }, [symbol, tf, strategy]);

  const runCompose = useCallback(() => {
    setComposeLoading(true);
    setComposeError(null);
    fetch(apiUrl("/api/strategy/compose"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "composition failed");
        const s: CustomStrategy = d.strategy;
        setName(s.name);
        setMinScore(s.minScore);
        setConditions(
          Object.fromEntries(
            CONDITION_LIBRARY.map((c) => {
              const picked = s.conditions.find((x) => x.id === c.id);
              return [c.id, { enabled: Boolean(picked), weight: picked?.weight ?? c.defaultWeight }];
            }),
          ) as Record<ConditionId, ConditionState>,
        );
      })
      .catch((e) => setComposeError(e.message))
      .finally(() => setComposeLoading(false));
  }, [description]);

  const runPine = useCallback(() => {
    setPineError(null);
    setScript(null);
    fetch(apiUrl("/api/pine/custom"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Pine generation failed");
        setScript(d.script);
      })
      .catch((e) => setPineError(e.message));
  }, [strategy]);

  const enabledCount = strategy.conditions.length;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Strategy Lab</h1>
        <p className="text-sm text-muted">
          Compose your own strategy from the deterministic condition library, evaluate it live against any symbol, and
          export it as a TradingView indicator — or start from a pre-built Pine template below.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {/* AI compose */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Describe it — AI composes it</h2>
            <p className="mt-1 text-xs text-muted">
              e.g. &quot;Buy liquidity sweeps of the lows when the higher timeframe is trending up and RSI is oversold&quot;.
              Claude maps your description onto the supported conditions below — it never invents calculations.
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              placeholder="Describe your strategy in plain English…"
              className="mt-2 w-full rounded-md border border-edge bg-background px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                onClick={runCompose}
                disabled={composeLoading || description.trim().length < 10}
                className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {composeLoading ? "Composing…" : "Compose strategy"}
              </button>
              {composeError && <span className="text-xs text-bear">{composeError}</span>}
            </div>
          </section>

          {/* Condition picker */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-semibold">Conditions &amp; weights</h2>
              <div className="flex items-center gap-2 text-sm">
                <label className="text-xs text-muted">Strategy name</label>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-52 rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none focus:border-accent"
                />
              </div>
            </div>
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {CONDITION_LIBRARY.map((c) => {
                const st = conditions[c.id];
                return (
                  <div
                    key={c.id}
                    className={`rounded-md border p-3 ${st.enabled ? "border-accent/60 bg-background" : "border-edge"}`}
                  >
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={st.enabled}
                        onChange={(e) => setConditions((prev) => ({ ...prev, [c.id]: { ...prev[c.id], enabled: e.target.checked } }))}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span>
                        <span className="text-sm font-medium">{c.label}</span>
                        {!c.pineSupported && <span className="ml-2 text-[10px] uppercase text-muted">web only</span>}
                        <span className="block text-xs text-muted">{c.description}</span>
                      </span>
                    </label>
                    {st.enabled && (
                      <div className="mt-2 flex items-center gap-2 pl-6">
                        <input
                          type="range"
                          min={1}
                          max={30}
                          value={st.weight}
                          onChange={(e) => setConditions((prev) => ({ ...prev, [c.id]: { ...prev[c.id], weight: Number(e.target.value) } }))}
                          className="w-40 accent-[var(--accent)]"
                        />
                        <span className="w-14 text-xs text-muted">weight {st.weight}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="mt-3 flex items-center gap-3 text-sm">
              <label className="text-xs text-muted">Min score to signal</label>
              <input
                type="range"
                min={0}
                max={100}
                value={minScore}
                onChange={(e) => setMinScore(Number(e.target.value))}
                className="w-40 accent-[var(--accent)]"
              />
              <span className="text-xs">{minScore}%</span>
            </div>
          </section>

          {/* Pine export */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">TradingView indicator</h2>
              <div className="flex gap-2">
                <button
                  onClick={runPine}
                  disabled={enabledCount === 0}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                >
                  Generate Pine Script
                </button>
                {script && (
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(script);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    }}
                    className="rounded-md border border-edge px-3 py-1.5 text-xs font-semibold hover:bg-edge"
                  >
                    {copied ? "Copied!" : "Copy"}
                  </button>
                )}
              </div>
            </div>
            {pineError && <p className="mt-2 text-xs text-bear">{pineError}</p>}
            {script ? (
              <pre className="mt-3 max-h-96 overflow-auto rounded-md border border-edge bg-background p-3 font-mono text-xs leading-relaxed">
                {script}
              </pre>
            ) : (
              <p className="mt-2 text-xs text-muted">
                Generates a Pine v6 indicator with your weighted conditions, buy/sell signals, alerts and the risk table.
                Conditions marked &quot;web only&quot; (volume profile, order blocks) are excluded from the Pine version.
              </p>
            )}
          </section>

          {/* Pre-built Pine templates (merged from Indicator Studio) */}
          <PineTemplates />
        </div>

        {/* Live evaluation */}
        <div className="space-y-4">
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Evaluate live</h2>
            <div className="mt-2 flex gap-2">
              <input
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-32 rounded-md border border-edge bg-background px-2 py-1 font-mono text-sm uppercase outline-none focus:border-accent"
              />
              <select
                value={tf}
                onChange={(e) => setTf(e.target.value as Timeframe)}
                className="rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none"
              >
                {TIMEFRAMES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                onClick={runEval}
                disabled={evalLoading || enabledCount === 0}
                className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
              >
                {evalLoading ? "Running…" : "Evaluate"}
              </button>
            </div>
            {enabledCount === 0 && <p className="mt-2 text-xs text-muted">Enable at least one condition first.</p>}
            {evalError && <p className="mt-2 text-xs text-bear">{evalError}</p>}

            {evaluations && (
              <div className="mt-3 space-y-3">
                {evalPrice !== null && (
                  <p className="text-xs text-muted">
                    {symbol.toUpperCase()} · {tf} · last {fmtPrice(evalPrice)}
                  </p>
                )}
                {evaluations.map((ev) => (
                  <div key={ev.direction} className={`rounded-md border p-3 ${ev.qualifies ? "border-accent/60" : "border-edge"}`}>
                    <div className="flex items-center justify-between">
                      <span className={`text-sm font-bold uppercase ${ev.direction === "long" ? "text-bull" : "text-bear"}`}>
                        {ev.direction}
                      </span>
                      <span className="text-sm font-semibold">
                        {ev.score}% {ev.qualifies ? "· qualifies" : ""}
                      </span>
                    </div>
                    <ul className="mt-2 space-y-1 text-xs">
                      {ev.factors.map((f, i) => (
                        <li key={i} className={f.met ? "text-foreground" : "text-muted line-through"}>
                          {f.name}: {f.detail}
                        </li>
                      ))}
                    </ul>
                    {ev.opportunity && (
                      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-edge pt-2 font-mono text-xs">
                        <div>
                          <div className="text-muted">Entry</div>
                          {fmtPrice(ev.opportunity.entry)}
                        </div>
                        <div>
                          <div className="text-muted">SL</div>
                          {fmtPrice(ev.opportunity.stopLoss)}
                        </div>
                        <div>
                          <div className="text-muted">TP ({ev.opportunity.riskRewardRatio.toFixed(1)}R)</div>
                          {fmtPrice(ev.opportunity.takeProfit)}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
