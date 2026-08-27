"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import PineTemplates from "@/components/PineTemplates";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { fmtPrice } from "@/components/format";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";
import { CONDITION_LIBRARY, type ConditionId, type CustomEvaluation, type CustomStrategy } from "@/lib/strategies/custom";
import { STRATEGY_PRESETS } from "@/lib/strategies/presets";
import { describeStopRule, describeTargetRule, type RiskSettings, type StopRule, type TargetRule } from "@/lib/strategies/risk";
import { addSavedStrategy, deleteSavedStrategy, loadSavedStrategies, type SavedStrategy } from "@/lib/strategies/savedStore";
import {
  METRIC_LIBRARY,
  describeUserCondition,
  loadUserConditions,
  newUserConditionId,
  saveUserConditions,
  type MetricId,
  type UserClause,
  type UserCondition,
} from "@/lib/strategies/userConditions";

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
  const [saved, setSaved] = useState<SavedStrategy[]>([]);
  const [justSaved, setJustSaved] = useState(false);
  const [userConds, setUserConds] = useState<UserCondition[]>([]);
  const [userStates, setUserStates] = useState<Record<string, ConditionState>>({});
  const [editId, setEditId] = useState<string | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editLabel, setEditLabel] = useState("");
  const [editShortMode, setEditShortMode] = useState<"mirror" | "same">("mirror");
  const [editClauses, setEditClauses] = useState<UserClause[]>([{ metric: "rsi14", op: "lt", value: 35 }]);
  const [stopRule, setStopRule] = useState<StopRule>({ type: "default" });
  const [targetRule, setTargetRule] = useState<TargetRule>({ type: "default" });

  useEffect(() => {
    setSaved(loadSavedStrategies());
    const conds = loadUserConditions();
    setUserConds(conds);
    setUserStates(Object.fromEntries(conds.map((c) => [c.id, { enabled: false, weight: 10 }])));
  }, []);

  const strategy = useMemo<CustomStrategy>(() => {
    const enabledUser = userConds
      .filter((c) => userStates[c.id]?.enabled)
      .map((c) => ({ condition: c, weight: userStates[c.id].weight }));
    const riskCustom = stopRule.type !== "default" || targetRule.type !== "default";
    return {
      name,
      minScore,
      conditions: CONDITION_LIBRARY.filter((c) => conditions[c.id].enabled).map((c) => ({ id: c.id, weight: conditions[c.id].weight })),
      ...(enabledUser.length > 0 ? { userConditions: enabledUser } : {}),
      ...(riskCustom ? { risk: { stop: stopRule, target: targetRule } satisfies RiskSettings } : {}),
    };
  }, [name, minScore, conditions, userConds, userStates, stopRule, targetRule]);

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
      body: JSON.stringify({ description, ...(userConds.length > 0 ? { userConditions: userConds } : {}) }),
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
        setUserStates((prev) =>
          Object.fromEntries(
            Object.keys(prev).map((id) => {
              const picked = s.userConditions?.find((u) => u.condition.id === id);
              return [id, { enabled: Boolean(picked), weight: picked?.weight ?? prev[id].weight }];
            }),
          ),
        );
      })
      .catch((e) => setComposeError(e.message))
      .finally(() => setComposeLoading(false));
  }, [description, userConds]);

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

  const enabledCount = strategy.conditions.length + (strategy.userConditions?.length ?? 0);

  const saveStrategy = useCallback(() => {
    setSaved(addSavedStrategy(strategy, "manual"));
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 2000);
  }, [strategy]);

  const loadStrategy = useCallback(
    (s: CustomStrategy) => {
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
      // Import any embedded user conditions missing from the local library.
      const embedded = s.userConditions ?? [];
      const missing = embedded.map((u) => u.condition).filter((c) => !userConds.some((x) => x.id === c.id));
      const nextConds = missing.length > 0 ? [...userConds, ...missing] : userConds;
      if (missing.length > 0) {
        setUserConds(nextConds);
        saveUserConditions(nextConds);
      }
      setUserStates(
        Object.fromEntries(
          nextConds.map((c) => {
            const picked = embedded.find((u) => u.condition.id === c.id);
            return [c.id, { enabled: Boolean(picked), weight: picked?.weight ?? 10 }];
          }),
        ),
      );
      setStopRule(s.risk?.stop ?? { type: "default" });
      setTargetRule(s.risk?.target ?? { type: "default" });
    },
    [userConds],
  );

  const openEditor = useCallback((cond: UserCondition | null) => {
    setEditId(cond?.id ?? null);
    setEditLabel(cond?.label ?? "");
    setEditShortMode(cond?.shortMode ?? "mirror");
    setEditClauses(cond ? cond.clauses.map((c) => ({ ...c })) : [{ metric: "rsi14", op: "lt", value: 35 }]);
    setEditorOpen(true);
  }, []);

  const saveCondition = useCallback(() => {
    const label = editLabel.trim();
    if (!label || editClauses.length === 0) return;
    const cond: UserCondition = { id: editId ?? newUserConditionId(), label, shortMode: editShortMode, clauses: editClauses };
    const next = editId ? userConds.map((c) => (c.id === editId ? cond : c)) : [...userConds, cond];
    setUserConds(next);
    saveUserConditions(next);
    setUserStates((prev) => ({ ...prev, [cond.id]: prev[cond.id] ?? { enabled: true, weight: 10 } }));
    setEditorOpen(false);
  }, [editId, editLabel, editShortMode, editClauses, userConds]);

  const deleteCondition = useCallback(
    (id: string) => {
      const next = userConds.filter((c) => c.id !== id);
      setUserConds(next);
      saveUserConditions(next);
      setUserStates((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== id)));
      if (editId === id) setEditorOpen(false);
    },
    [userConds, editId],
  );

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
              Claude maps your description onto the supported conditions below (including your own) — it never invents calculations.
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
                <button
                  onClick={saveStrategy}
                  disabled={enabledCount === 0}
                  className="rounded-md border border-edge px-3 py-1 text-xs font-semibold hover:bg-edge disabled:opacity-50"
                  title="Save to your strategy library — used by the Backtest tab's comparison matrix"
                >
                  {justSaved ? "Saved ✓" : "Save strategy"}
                </button>
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
              {userConds.map((c) => {
                const st = userStates[c.id] ?? { enabled: false, weight: 10 };
                return (
                  <div key={c.id} className={`rounded-md border p-3 ${st.enabled ? "border-accent/60 bg-background" : "border-edge"}`}>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input
                        type="checkbox"
                        checked={st.enabled}
                        onChange={(e) => setUserStates((prev) => ({ ...prev, [c.id]: { ...st, enabled: e.target.checked } }))}
                        className="mt-0.5 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="text-sm font-medium">{c.label}</span>
                        <span className="ml-2 text-[10px] uppercase text-accent">yours</span>
                        <span className="ml-1 text-[10px] uppercase text-muted">web only</span>
                        <span className="block text-xs text-muted">{describeUserCondition(c)}</span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            openEditor(c);
                          }}
                          className="rounded border border-edge px-1.5 py-0.5 text-[10px] font-semibold hover:bg-edge"
                        >
                          Edit
                        </button>
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            deleteCondition(c.id);
                          }}
                          className="px-1 text-muted hover:text-bear"
                        >
                          ✕
                        </button>
                      </span>
                    </label>
                    {st.enabled && (
                      <div className="mt-2 flex items-center gap-2 pl-6">
                        <input
                          type="range"
                          min={1}
                          max={30}
                          value={st.weight}
                          onChange={(e) => setUserStates((prev) => ({ ...prev, [c.id]: { ...st, weight: Number(e.target.value) } }))}
                          className="w-40 accent-[var(--accent)]"
                        />
                        <span className="w-14 text-xs text-muted">weight {st.weight}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* User condition editor */}
            <div className="mt-3 rounded-md border border-edge bg-background p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold">Your conditions</span>
                <button
                  onClick={() => openEditor(null)}
                  className="rounded-md border border-edge px-3 py-1 text-xs font-semibold hover:bg-edge"
                >
                  + New condition
                </button>
              </div>
              <p className="mt-1 text-xs text-muted">
                Build your own rules from deterministic metrics (RSI, EMA/VWAP/POC distance, volatility, swings…). Rules are written
                for the long side — shorts use the mirrored rule unless you choose otherwise. They join the list above and work in
                live evaluation, scanning and backtests (web only — excluded from Pine export).
              </p>
              {editorOpen && (
                <div className="mt-3 space-y-2 rounded-md border border-accent/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      placeholder="Condition name…"
                      className="w-56 rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none focus:border-accent"
                    />
                    <select
                      value={editShortMode}
                      onChange={(e) => setEditShortMode(e.target.value as "mirror" | "same")}
                      className="rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
                    >
                      <option value="mirror">Mirror rule for shorts</option>
                      <option value="same">Same rule both directions</option>
                    </select>
                  </div>
                  {editClauses.map((cl, i) => {
                    const meta = METRIC_LIBRARY.find((m) => m.id === cl.metric);
                    return (
                      <div key={i} className="flex flex-wrap items-center gap-2">
                        {i > 0 && <span className="text-[10px] font-semibold uppercase text-muted">and</span>}
                        <select
                          value={cl.metric}
                          onChange={(e) =>
                            setEditClauses((prev) => prev.map((x, j) => (j === i ? { ...x, metric: e.target.value as MetricId } : x)))
                          }
                          className="max-w-56 truncate rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
                        >
                          {METRIC_LIBRARY.map((m) => (
                            <option key={m.id} value={m.id} title={m.description}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={cl.op}
                          onChange={(e) =>
                            setEditClauses((prev) => prev.map((x, j) => (j === i ? { ...x, op: e.target.value as UserClause["op"] } : x)))
                          }
                          className="rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
                        >
                          <option value="lt">&lt; below</option>
                          <option value="gt">&gt; above</option>
                        </select>
                        <input
                          type="number"
                          step="any"
                          value={cl.value}
                          onChange={(e) =>
                            setEditClauses((prev) => prev.map((x, j) => (j === i ? { ...x, value: Number(e.target.value) } : x)))
                          }
                          className="w-24 rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none focus:border-accent"
                        />
                        {meta?.unit && <span className="text-xs text-muted">{meta.unit}</span>}
                        {editClauses.length > 1 && (
                          <button
                            onClick={() => setEditClauses((prev) => prev.filter((_, j) => j !== i))}
                            className="text-muted hover:text-bear"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    );
                  })}
                  {(() => {
                    const lastMeta = METRIC_LIBRARY.find((m) => m.id === editClauses[editClauses.length - 1]?.metric);
                    return lastMeta ? <p className="text-[11px] text-muted">{lastMeta.label}: {lastMeta.description}</p> : null;
                  })()}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setEditClauses((prev) => (prev.length < 6 ? [...prev, { metric: "price_vs_ema20", op: "gt", value: 0 }] : prev))}
                      className="rounded-md border border-edge px-2 py-1 text-xs font-semibold hover:bg-edge"
                    >
                      + AND clause
                    </button>
                    <button
                      onClick={saveCondition}
                      disabled={editLabel.trim().length === 0}
                      className="rounded-md bg-accent px-3 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {editId ? "Update condition" : "Add condition"}
                    </button>
                    <button onClick={() => setEditorOpen(false)} className="text-xs text-muted hover:text-foreground">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            {/* Risk settings */}
            <div className="mt-3 rounded-md border border-edge bg-background p-3">
              <span className="text-sm font-semibold">Risk settings — SL &amp; TP placement</span>
              <p className="mt-1 text-xs text-muted">
                How this strategy places its stop-loss and target on every signal (live evaluation, scanner and backtests).
              </p>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs text-muted">Stop-loss</label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <select
                      value={stopRule.type}
                      onChange={(e) => {
                        const t = e.target.value as StopRule["type"];
                        setStopRule(
                          t === "default"
                            ? { type: "default" }
                            : t === "atr"
                              ? { type: "atr", multiple: 1.5 }
                              : t === "percent"
                                ? { type: "percent", percent: 1 }
                                : t === "swing"
                                  ? { type: "swing", bufferAtr: 0.25 }
                                  : { type: "hvn", bufferAtr: 0.25 },
                        );
                      }}
                      className="rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
                    >
                      <option value="default">Structure default (beyond swing)</option>
                      <option value="swing">Beyond recent swing low/high + buffer</option>
                      <option value="hvn">Beyond nearest HVN + buffer</option>
                      <option value="atr">Fixed ATR multiple</option>
                      <option value="percent">Fixed % from entry</option>
                    </select>
                    {stopRule.type === "atr" && (
                      <span className="flex items-center gap-1 text-xs">
                        <input
                          type="number"
                          step="0.1"
                          min={0.1}
                          value={stopRule.multiple}
                          onChange={(e) => setStopRule({ type: "atr", multiple: Number(e.target.value) })}
                          className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
                        />
                        × ATR
                      </span>
                    )}
                    {stopRule.type === "percent" && (
                      <span className="flex items-center gap-1 text-xs">
                        <input
                          type="number"
                          step="0.1"
                          min={0.05}
                          value={stopRule.percent}
                          onChange={(e) => setStopRule({ type: "percent", percent: Number(e.target.value) })}
                          className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
                        />
                        %
                      </span>
                    )}
                    {(stopRule.type === "swing" || stopRule.type === "hvn") && (
                      <span className="flex items-center gap-1 text-xs">
                        buffer
                        <input
                          type="number"
                          step="0.05"
                          min={0}
                          value={stopRule.bufferAtr}
                          onChange={(e) => setStopRule({ type: stopRule.type, bufferAtr: Number(e.target.value) })}
                          className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
                        />
                        ATR
                      </span>
                    )}
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted">Take-profit</label>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <select
                      value={targetRule.type}
                      onChange={(e) => {
                        const t = e.target.value as TargetRule["type"];
                        setTargetRule(
                          t === "default"
                            ? { type: "default" }
                            : t === "rr"
                              ? { type: "rr", ratio: 2 }
                              : t === "atr"
                                ? { type: "atr", multiple: 3 }
                                : t === "swing"
                                  ? { type: "swing" }
                                  : { type: "hvn" },
                        );
                      }}
                      className="rounded-md border border-edge bg-background px-2 py-1 text-xs outline-none"
                    >
                      <option value="default">Structure default (opposing structure / 2R)</option>
                      <option value="rr">Fixed R multiple of the stop</option>
                      <option value="hvn">Next HVN in trade direction</option>
                      <option value="swing">Next swing high/low</option>
                      <option value="atr">Fixed ATR multiple</option>
                    </select>
                    {targetRule.type === "rr" && (
                      <span className="flex items-center gap-1 text-xs">
                        <input
                          type="number"
                          step="0.1"
                          min={0.2}
                          value={targetRule.ratio}
                          onChange={(e) => setTargetRule({ type: "rr", ratio: Number(e.target.value) })}
                          className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
                        />
                        R
                      </span>
                    )}
                    {targetRule.type === "atr" && (
                      <span className="flex items-center gap-1 text-xs">
                        <input
                          type="number"
                          step="0.1"
                          min={0.1}
                          value={targetRule.multiple}
                          onChange={(e) => setTargetRule({ type: "atr", multiple: Number(e.target.value) })}
                          className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
                        />
                        × ATR
                      </span>
                    )}
                  </div>
                </div>
              </div>
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

          {/* Pre-built strategy presets */}
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Preset strategies</h2>
            <p className="mt-1 text-xs text-muted">
              Complete, ready-to-use configurations. Load one into the editor to tweak it, or save it straight to your
              library to scan, evaluate and backtest with it.
            </p>
            <div className="mt-2 space-y-2">
              {STRATEGY_PRESETS.map((p) => {
                const alreadySaved = saved.some((s) => s.strategy.name === p.strategy.name);
                return (
                  <div key={p.id} className="rounded-md border border-edge bg-background px-3 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{p.strategy.name}</span>
                      <span className="flex items-center gap-2">
                        <button
                          onClick={() => loadStrategy(p.strategy)}
                          className="rounded-md border border-edge px-2 py-1 text-xs font-semibold hover:bg-edge"
                        >
                          Load into editor
                        </button>
                        <button
                          onClick={() => setSaved(addSavedStrategy(p.strategy, "manual"))}
                          disabled={alreadySaved}
                          className="rounded-md bg-accent px-2 py-1 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
                        >
                          {alreadySaved ? "In library ✓" : "Save to library"}
                        </button>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">{p.summary}</p>
                    <p className="mt-1 text-[11px] text-muted">
                      {p.strategy.conditions.length} conditions · min score {p.strategy.minScore}
                      {p.strategy.risk
                        ? ` · SL: ${describeStopRule(p.strategy.risk.stop)} · TP: ${describeTargetRule(p.strategy.risk.target)}`
                        : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {saved.length > 0 && (
            <section className="rounded-lg border border-edge bg-surface p-4">
              <h2 className="font-semibold">Saved strategies ({saved.length})</h2>
              <p className="mt-1 text-xs text-muted">
                Load one back into the editor, or compare them side by side in the Backtest tab&apos;s comparison matrix.
              </p>
              <div className="mt-2 space-y-1">
                {saved.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border border-edge bg-background px-3 py-1.5 text-sm">
                    <span>
                      {s.strategy.name}
                      {s.source === "calibrated" && (
                        <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-accent">calibrated</span>
                      )}
                      <span className="ml-2 text-xs text-muted">
                        {s.strategy.conditions.length + (s.strategy.userConditions?.length ?? 0)} condition
                        {s.strategy.conditions.length + (s.strategy.userConditions?.length ?? 0) === 1 ? "" : "s"} · min score {s.strategy.minScore}
                        {s.strategy.risk && (s.strategy.risk.stop.type !== "default" || s.strategy.risk.target.type !== "default") ? " · custom risk" : ""}
                      </span>
                    </span>
                    <span className="flex items-center gap-2">
                      <button onClick={() => loadStrategy(s.strategy)} className="rounded-md border border-edge px-2 py-1 text-xs font-semibold hover:bg-edge">
                        Load
                      </button>
                      <button onClick={() => setSaved(deleteSavedStrategy(s.id))} className="text-muted hover:text-bear">
                        ✕
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Pre-built Pine templates (merged from Indicator Studio) */}
          <PineTemplates />
        </div>

        {/* Live evaluation */}
        <div className="space-y-4">
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Evaluate live</h2>
            <div className="mt-2 flex gap-2">
              <SymbolInput
                value={symbol}
                onChange={setSymbol}
                className="w-36 rounded-md border border-edge bg-background px-2 py-1 font-mono text-sm uppercase outline-none focus:border-accent"
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
