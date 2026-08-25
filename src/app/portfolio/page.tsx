"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fmtPrice } from "@/components/format";
import { usePrices } from "@/components/usePrices";
import { dueActions, openR, type DueAction } from "@/lib/journal/manage";
import { loadTrades, tradeMetrics } from "@/lib/journal/store";
import type { JournalTrade } from "@/lib/journal/types";
import { assetClassForSymbol } from "@/lib/market/symbols";
import { findCorrelationWarnings } from "@/lib/risk/correlation";

interface RiskSettings {
  accountSize: number | null;
  dailyLossLimitPct: number | null;
  maxOpenRiskPct: number | null;
}

const SETTINGS_KEY = "tradeintel.risk.settings";

function loadSettings(): RiskSettings {
  if (typeof window === "undefined") return { accountSize: null, dailyLossLimitPct: null, maxOpenRiskPct: null };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (raw) return JSON.parse(raw) as RiskSettings;
  } catch {
    // corrupted settings fall back to defaults
  }
  return { accountSize: null, dailyLossLimitPct: 3, maxOpenRiskPct: 6 };
}

const CLASS_LABELS: Record<string, string> = {
  crypto: "Crypto",
  stocks: "Stocks & ETFs",
  forex: "Forex",
  futures: "Futures",
};

export default function PortfolioPage() {
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [settings, setSettings] = useState<RiskSettings>({ accountSize: null, dailyLossLimitPct: 3, maxOpenRiskPct: 6 });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setTrades(loadTrades());
    setSettings(loadSettings());
    setLoaded(true);
  }, []);

  const updateSettings = useCallback((patch: Partial<RiskSettings>) => {
    setSettings((cur) => {
      const next = { ...cur, ...patch };
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        // storage may be unavailable (private mode)
      }
      return next;
    });
  }, []);

  const openTrades = useMemo(() => trades.filter((t) => t.status === "open"), [trades]);
  const prices = usePrices(useMemo(() => openTrades.map((t) => t.symbol), [openTrades]));
  const warnings = useMemo(() => findCorrelationWarnings(openTrades), [openTrades]);

  const rows = useMemo(
    () =>
      openTrades.map((t) => {
        const price = prices[t.symbol];
        const riskPerUnit = t.stopLoss != null ? Math.abs(t.entryPrice - t.stopLoss) : null;
        const riskCash = riskPerUnit != null && t.size != null ? riskPerUnit * t.size : null;
        const notional = t.size != null ? t.entryPrice * t.size : null;
        const r = price !== undefined ? openR(t, price) : null;
        const actions: DueAction[] = price !== undefined ? dueActions(t, price) : [];
        return { t, price, riskPerUnit, riskCash, notional, r, actions, cls: assetClassForSymbol(t.symbol) };
      }),
    [openTrades, prices],
  );

  const totalRiskCash = useMemo(() => {
    const known = rows.filter((r) => r.riskCash != null);
    return known.length > 0 ? known.reduce((s, r) => s + (r.riskCash ?? 0), 0) : null;
  }, [rows]);
  const unsizedCount = rows.filter((r) => r.riskCash == null).length;

  const byClass = useMemo(() => {
    const map = new Map<string, { positions: number; notional: number; riskCash: number }>();
    for (const r of rows) {
      const cur = map.get(r.cls) ?? { positions: 0, notional: 0, riskCash: 0 };
      cur.positions += 1;
      cur.notional += r.notional ?? 0;
      cur.riskCash += r.riskCash ?? 0;
      map.set(r.cls, cur);
    }
    return [...map.entries()];
  }, [rows]);

  const todayRealized = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const closedToday = trades.filter((t) => t.status === "closed" && t.exitTime != null && t.exitTime >= start.getTime());
    let pnl = 0;
    let known = 0;
    for (const t of closedToday) {
      const m = tradeMetrics(t);
      if (m?.pnl != null) {
        pnl += m.pnl;
        known += 1;
      }
    }
    return { trades: closedToday.length, pnl: known > 0 ? pnl : null };
  }, [trades]);

  const allActions = useMemo(() => rows.flatMap((r) => r.actions), [rows]);

  const openRiskPct = settings.accountSize != null && settings.accountSize > 0 && totalRiskCash != null ? (totalRiskCash / settings.accountSize) * 100 : null;
  const dailyLossCash = settings.accountSize != null && settings.dailyLossLimitPct != null ? (settings.accountSize * settings.dailyLossLimitPct) / 100 : null;
  const dailyLossBreached = dailyLossCash != null && todayRealized.pnl != null && todayRealized.pnl <= -dailyLossCash;
  const openRiskBreached = openRiskPct != null && settings.maxOpenRiskPct != null && openRiskPct > settings.maxOpenRiskPct;

  const inputCls = "rounded-md border border-edge bg-background px-2 py-1 font-mono text-sm outline-none focus:border-accent";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold">Portfolio Risk</h1>
        <p className="text-sm text-muted">
          Aggregated from your open Journal trades stored in this browser — not a broker connection. Sizes, stops and
          exits are what you logged, so keep the Journal current for accurate numbers. Advisory only.
        </p>
      </div>

      {(dailyLossBreached || openRiskBreached) && (
        <div className="rounded-lg border border-bear/50 bg-bear/10 p-3 text-sm">
          {dailyLossBreached && (
            <p className="font-semibold text-bear">
              Daily loss limit hit: realized {fmtPrice(todayRealized.pnl ?? 0)} today vs limit -{fmtPrice(dailyLossCash ?? 0)}. Consider stopping for the day.
            </p>
          )}
          {openRiskBreached && (
            <p className="font-semibold text-bear">
              Open risk {openRiskPct?.toFixed(1)}% of account exceeds your {settings.maxOpenRiskPct}% threshold.
            </p>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Open risk</h2>
          <div className="mt-3 space-y-2 text-sm">
            <Row label="Open positions" value={`${openTrades.length}`} />
            <Row label="Total risk at stops" value={totalRiskCash != null ? fmtPrice(totalRiskCash) : "—"} />
            {unsizedCount > 0 && <p className="text-xs text-muted">{unsizedCount} position(s) without size and/or stop are excluded from cash risk.</p>}
            <Row label="Risk as % of account" value={openRiskPct != null ? `${openRiskPct.toFixed(1)}%` : "set account size →"} />
            <Row
              label="Realized P&L today"
              value={todayRealized.pnl != null ? `${todayRealized.pnl >= 0 ? "+" : ""}${fmtPrice(Math.abs(todayRealized.pnl))}` : todayRealized.trades > 0 ? `${todayRealized.trades} closed (no sizes)` : "—"}
            />
          </div>
        </section>

        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Exposure by asset class</h2>
          {byClass.length === 0 && loaded && <p className="mt-2 text-sm text-muted">No open positions.</p>}
          <div className="mt-3 space-y-2 text-sm">
            {byClass.map(([cls, v]) => (
              <div key={cls} className="flex items-center justify-between">
                <span>{CLASS_LABELS[cls] ?? cls}</span>
                <span className="font-mono text-xs text-muted">
                  {v.positions} pos{v.notional > 0 && ` · notional ${fmtPrice(v.notional)}`}
                  {v.riskCash > 0 && ` · risk ${fmtPrice(v.riskCash)}`}
                </span>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Risk settings</h2>
          <div className="mt-3 space-y-2 text-sm">
            <label className="block text-xs text-muted">
              Account size (quote currency)
              <input
                value={settings.accountSize ?? ""}
                onChange={(e) => updateSettings({ accountSize: e.target.value === "" ? null : Number(e.target.value) || null })}
                inputMode="decimal"
                placeholder="e.g. 10000"
                className={`${inputCls} mt-0.5 w-full`}
              />
            </label>
            <label className="block text-xs text-muted">
              Daily loss limit (% of account)
              <input
                value={settings.dailyLossLimitPct ?? ""}
                onChange={(e) => updateSettings({ dailyLossLimitPct: e.target.value === "" ? null : Number(e.target.value) || null })}
                inputMode="decimal"
                placeholder="e.g. 3"
                className={`${inputCls} mt-0.5 w-full`}
              />
            </label>
            <label className="block text-xs text-muted">
              Max total open risk (% of account)
              <input
                value={settings.maxOpenRiskPct ?? ""}
                onChange={(e) => updateSettings({ maxOpenRiskPct: e.target.value === "" ? null : Number(e.target.value) || null })}
                inputMode="decimal"
                placeholder="e.g. 6"
                className={`${inputCls} mt-0.5 w-full`}
              />
            </label>
            <p className="text-[10px] text-muted">Stored locally in this browser. Limits trigger the banner above — nothing is closed automatically.</p>
          </div>
        </section>
      </div>

      {warnings.length > 0 && (
        <section className="rounded-lg border border-amber-500/40 bg-surface p-4">
          <h2 className="font-semibold">Concentration & correlation</h2>
          <p className="mt-1 text-xs text-muted">Structural relationships (USD legs, BTC beta, index overlap) — approximate and advisory.</p>
          <ul className="mt-2 space-y-2 text-sm">
            {warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${w.severity === "high" ? "bg-bear/20 text-bear" : "bg-amber-500/20 text-amber-400"}`}>
                  {w.severity}
                </span>
                <span className="text-xs">{w.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {allActions.length > 0 && (
        <section className="rounded-lg border border-edge bg-surface p-4">
          <h2 className="font-semibold">Management actions due</h2>
          <p className="mt-1 text-xs text-muted">
            From the break-even / trailing / scaling rules on your open trades — apply them in the <Link href="/journal" className="text-accent hover:underline">Journal</Link>.
          </p>
          <ul className="mt-2 space-y-1">
            {allActions.map((a, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-md bg-background px-2 py-1 text-xs">
                <span className="font-mono font-semibold">{a.symbol}</span>
                <span className="font-semibold text-amber-400">{a.label}</span>
                <span className="text-muted">{a.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="rounded-lg border border-edge bg-surface p-4">
        <h2 className="font-semibold">Open positions</h2>
        {loaded && rows.length === 0 && (
          <p className="mt-2 text-sm text-muted">
            No open trades. Log trades in the <Link href="/journal" className="text-accent hover:underline">Journal</Link> to see portfolio risk here.
          </p>
        )}
        {rows.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-muted">
                <tr className="border-b border-edge">
                  <th className="py-1.5 pr-3">Symbol</th>
                  <th className="py-1.5 pr-3">Dir</th>
                  <th className="py-1.5 pr-3">Entry</th>
                  <th className="py-1.5 pr-3">Stop</th>
                  <th className="py-1.5 pr-3">Now</th>
                  <th className="py-1.5 pr-3">Open R</th>
                  <th className="py-1.5 pr-3">Size</th>
                  <th className="py-1.5 pr-3">Risk at stop</th>
                  <th className="py-1.5">Class</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map(({ t, price, r, riskCash }) => (
                  <tr key={t.id} className="border-b border-edge/50">
                    <td className="py-1.5 pr-3 font-semibold">{t.symbol}</td>
                    <td className={`py-1.5 pr-3 uppercase ${t.direction === "long" ? "text-bull" : "text-bear"}`}>{t.direction}</td>
                    <td className="py-1.5 pr-3">{fmtPrice(t.entryPrice)}</td>
                    <td className="py-1.5 pr-3">{t.stopLoss != null ? fmtPrice(t.stopLoss) : "—"}</td>
                    <td className="py-1.5 pr-3">{price !== undefined ? fmtPrice(price) : "…"}</td>
                    <td className={`py-1.5 pr-3 ${r != null ? (r >= 0 ? "text-bull" : "text-bear") : ""}`}>
                      {r != null ? `${r >= 0 ? "+" : ""}${r.toFixed(2)}R` : "—"}
                    </td>
                    <td className="py-1.5 pr-3">{t.size ?? "—"}</td>
                    <td className="py-1.5 pr-3">{riskCash != null ? fmtPrice(riskCash) : "—"}</td>
                    <td className="py-1.5">{CLASS_LABELS[assetClassForSymbol(t.symbol)]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted">{label}</span>
      <span className="font-mono font-semibold">{value}</span>
    </div>
  );
}
