"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import SymbolInput from "@/components/SymbolInput";
import { apiUrl } from "@/components/api";
import { checkAlertRules } from "@/lib/alerts/monitor";
import { loadDelivery, loadEvents, loadRules, saveDelivery, saveEvents, saveRules } from "@/lib/alerts/store";
import type { AlertEvent, AlertRule, DeliverySettings, PriceLevelRule, SetupRule } from "@/lib/alerts/types";
import { TIMEFRAMES, type Timeframe } from "@/lib/market/types";

const inputCls = "rounded-md border border-edge bg-background px-2 py-1 text-sm outline-none focus:border-accent";

function uid(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function AlertsPage() {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [delivery, setDelivery] = useState<DeliverySettings>({ browserNotifications: true, webhookUrl: "", telegramChatId: "" });
  const [monitoring, setMonitoring] = useState(false);
  const [intervalSec, setIntervalSec] = useState(60);
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);

  // Price rule form
  const [pSymbol, setPSymbol] = useState("BTCUSDT");
  const [pLevel, setPLevel] = useState("");
  const [pCondition, setPCondition] = useState<"above" | "below">("above");
  const [pNote, setPNote] = useState("");

  // Setup rule form
  const [sSymbols, setSSymbols] = useState("");
  const [sTf, setSTf] = useState<Timeframe>("4h");
  const [sDirection, setSDirection] = useState<"both" | "long" | "short">("both");
  const [sMinScore, setSMinScore] = useState(65);

  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const deliveryRef = useRef(delivery);
  deliveryRef.current = delivery;

  useEffect(() => {
    setRules(loadRules());
    setEvents(loadEvents());
    setDelivery(loadDelivery());
  }, []);

  const persistRules = useCallback((next: AlertRule[]) => {
    setRules(next);
    saveRules(next);
  }, []);

  const deliverEvents = useCallback((triggered: AlertEvent[]) => {
    const d = deliveryRef.current;
    for (const ev of triggered) {
      if (d.browserNotifications && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification("TradeIntel alert", { body: ev.message });
      }
    }
    if ((d.webhookUrl || d.telegramChatId) && triggered.length > 0) {
      const message = triggered.map((e) => e.message).join("\n");
      fetch(apiUrl("/api/alerts/notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          webhookUrl: d.webhookUrl || undefined,
          telegramChatId: d.telegramChatId || undefined,
        }),
      }).catch(() => {});
    }
  }, []);

  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      const { events: triggered, rules: updated } = await checkAlertRules(rulesRef.current);
      persistRules(updated);
      if (triggered.length > 0) {
        setEvents((prev) => {
          const next = [...triggered, ...prev].slice(0, 200);
          saveEvents(next);
          return next;
        });
        deliverEvents(triggered);
      }
      setLastCheck(Date.now());
    } finally {
      setChecking(false);
    }
  }, [persistRules, deliverEvents]);

  useEffect(() => {
    if (!monitoring) return;
    runCheck();
    const t = setInterval(runCheck, Math.max(15, intervalSec) * 1000);
    return () => clearInterval(t);
  }, [monitoring, intervalSec, runCheck]);

  const requestNotifications = () => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  };

  const addPriceRule = () => {
    const level = Number(pLevel);
    if (!pSymbol.trim() || !Number.isFinite(level) || level <= 0) return;
    const rule: PriceLevelRule = {
      id: uid(),
      type: "price_level",
      enabled: true,
      symbol: pSymbol.trim().toUpperCase(),
      level,
      condition: pCondition,
      note: pNote.trim(),
      cooldownMin: 60,
      lastFiredAt: null,
    };
    persistRules([rule, ...rules]);
    setPLevel("");
    setPNote("");
  };

  const addSetupRule = () => {
    const rule: SetupRule = {
      id: uid(),
      type: "setup",
      enabled: true,
      symbols: sSymbols.trim().toUpperCase(),
      tf: sTf,
      direction: sDirection,
      minScore: sMinScore,
      cooldownMin: 240,
      lastFired: {},
    };
    persistRules([rule, ...rules]);
  };

  const toggleRule = (id: string) =>
    persistRules(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)));
  const deleteRule = (id: string) => persistRules(rules.filter((r) => r.id !== id));

  const saveDeliverySettings = (next: DeliverySettings) => {
    setDelivery(next);
    saveDelivery(next);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Alerts</h1>
        <p className="text-sm text-muted">
          Price-level and setup alerts, checked while this tab is open. Browser notifications fire locally; webhook and
          Telegram delivery are optional. (Server-side scheduled monitoring arrives with the Cloudflare deploy.)
        </p>
      </div>

      <section className="flex flex-wrap items-center gap-3 rounded-lg border border-edge bg-surface p-4">
        <button
          onClick={() => {
            requestNotifications();
            setMonitoring((m) => !m);
          }}
          className={`rounded-md px-4 py-2 text-sm font-semibold ${monitoring ? "bg-bear text-white" : "bg-accent text-white"}`}
        >
          {monitoring ? "Stop monitoring" : "Start monitoring"}
        </button>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-xs text-muted">Check every</span>
          <select value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} className={inputCls}>
            <option value={30}>30s</option>
            <option value={60}>1m</option>
            <option value={300}>5m</option>
            <option value={900}>15m</option>
          </select>
        </label>
        <button onClick={runCheck} disabled={checking} className="rounded-md border border-edge px-3 py-1.5 text-xs font-semibold hover:bg-edge disabled:opacity-50">
          {checking ? "Checking…" : "Check now"}
        </button>
        {lastCheck && <span className="text-xs text-muted">Last check {new Date(lastCheck).toLocaleTimeString()}</span>}
        {monitoring && <span className="text-xs font-semibold text-bull">● monitoring (keep this tab open)</span>}
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Price level alert</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <SymbolInput value={pSymbol} onChange={setPSymbol} className={`${inputCls} w-32 font-mono uppercase`} placeholder="BTCUSDT" />
            <select value={pCondition} onChange={(e) => setPCondition(e.target.value as typeof pCondition)} className={inputCls}>
              <option value="above">crosses above</option>
              <option value="below">crosses below</option>
            </select>
            <input value={pLevel} onChange={(e) => setPLevel(e.target.value)} className={`${inputCls} w-28 font-mono`} placeholder="price" inputMode="decimal" />
            <input value={pNote} onChange={(e) => setPNote(e.target.value)} className={`${inputCls} flex-1`} placeholder="note (optional)" />
            <button onClick={addPriceRule} className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
              Add
            </button>
          </div>

          <h2 className="mt-4 font-semibold">Setup alert</h2>
          <p className="text-xs text-muted">Fires when the confluence engine finds a qualifying setup.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <div className="flex-1 [&>div]:w-full">
              <SymbolInput value={sSymbols} onChange={setSSymbols} multi className={`${inputCls} w-full font-mono uppercase`} placeholder="symbols, blank = default universe" />
            </div>
            <select value={sTf} onChange={(e) => setSTf(e.target.value as Timeframe)} className={inputCls}>
              {TIMEFRAMES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select value={sDirection} onChange={(e) => setSDirection(e.target.value as typeof sDirection)} className={inputCls}>
              <option value="both">Both</option>
              <option value="long">Long</option>
              <option value="short">Short</option>
            </select>
            <label className="flex items-center gap-1 text-xs text-muted">
              score ≥
              <input type="number" min={40} max={100} value={sMinScore} onChange={(e) => setSMinScore(Number(e.target.value))} className={`${inputCls} w-16 font-mono`} />
            </label>
            <button onClick={addSetupRule} className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90">
              Add
            </button>
          </div>

          <h2 className="mt-4 font-semibold">Rules ({rules.length})</h2>
          <ul className="mt-2 space-y-1">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-md border border-edge bg-background px-2 py-1.5 text-xs">
                <input type="checkbox" checked={r.enabled} onChange={() => toggleRule(r.id)} className="accent-[var(--accent)]" />
                <span className="flex-1">
                  {r.type === "price_level"
                    ? `${r.symbol} ${r.condition} ${r.level}${r.note ? ` — ${r.note}` : ""}`
                    : r.setup === "trendbreak"
                      ? `Trend Break ready · ${r.direction} · ${r.symbols || "default universe"}`
                      : r.setup === "sessionopen"
                        ? `Session Open ready · ${r.direction} · ${r.symbols || "default universe"}`
                        : r.setup === "pullbackvalue"
                          ? `Pullback to Value ready · ${r.direction} · ${r.symbols || "default universe"}`
                          : r.setup === "stochreversal"
                            ? `Stoch Double Top/Bottom ready · ${r.direction} · ${r.symbols || "default universe"}`
                            : r.setup === "trendlinefib"
                              ? `Trendline Break + Fib ready · ${r.direction} · ${r.symbols || "default universe"}`
                              : `Setup ≥${r.minScore} · ${r.direction} · ${r.tf} · ${r.symbols || "default universe"}`}
                </span>
                <span className="text-muted">{r.cooldownMin}m cooldown</span>
                <button onClick={() => deleteRule(r.id)} className="text-bear hover:underline">
                  delete
                </button>
              </li>
            ))}
            {rules.length === 0 && <li className="text-xs text-muted">No rules yet.</li>}
          </ul>
        </section>

        <div className="space-y-4">
          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Delivery</h2>
            <div className="mt-2 space-y-2 text-sm">
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={delivery.browserNotifications}
                  onChange={(e) => {
                    if (e.target.checked) requestNotifications();
                    saveDeliverySettings({ ...delivery, browserNotifications: e.target.checked });
                  }}
                  className="accent-[var(--accent)]"
                />
                Browser notifications (permission required)
              </label>
              <label className="block text-xs">
                <span className="text-muted">Webhook URL (POSTs {"{ text }"} JSON — works with Slack/Discord-style webhooks)</span>
                <input
                  value={delivery.webhookUrl}
                  onChange={(e) => saveDeliverySettings({ ...delivery, webhookUrl: e.target.value })}
                  className={`${inputCls} mt-1 w-full`}
                  placeholder="https://…"
                />
              </label>
              <label className="block text-xs">
                <span className="text-muted">Telegram chat ID (requires TELEGRAM_BOT_TOKEN on the server)</span>
                <input
                  value={delivery.telegramChatId}
                  onChange={(e) => saveDeliverySettings({ ...delivery, telegramChatId: e.target.value })}
                  className={`${inputCls} mt-1 w-full font-mono`}
                  placeholder="123456789"
                />
              </label>
            </div>
          </section>

          <section className="rounded-lg border border-edge bg-surface p-4">
            <h2 className="font-semibold">Triggered alerts</h2>
            <ul className="mt-2 max-h-96 space-y-1 overflow-auto">
              {events.map((e) => (
                <li key={e.id} className="rounded-md border border-edge bg-background px-2 py-1.5 text-xs">
                  <span className="text-muted">{new Date(e.time).toLocaleString()}</span> — {e.message}
                </li>
              ))}
              {events.length === 0 && <li className="text-xs text-muted">Nothing triggered yet.</li>}
            </ul>
            {events.length > 0 && (
              <button
                onClick={() => {
                  setEvents([]);
                  saveEvents([]);
                }}
                className="mt-2 text-xs text-muted hover:underline"
              >
                Clear log
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
