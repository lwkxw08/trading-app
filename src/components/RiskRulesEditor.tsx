"use client";

import type { StopRule, TargetRule } from "@/lib/strategies/risk";

/** Shared SL/TP placement rule editor used by the Strategy Lab and the Backtest page. */
export default function RiskRulesEditor({
  stopRule,
  targetRule,
  onStopChange,
  onTargetChange,
}: {
  stopRule: StopRule;
  targetRule: TargetRule;
  onStopChange: (rule: StopRule) => void;
  onTargetChange: (rule: TargetRule) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <label className="text-xs text-muted">Stop-loss</label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <select
            value={stopRule.type}
            onChange={(e) => {
              const t = e.target.value as StopRule["type"];
              onStopChange(
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
                onChange={(e) => onStopChange({ type: "atr", multiple: Number(e.target.value) })}
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
                onChange={(e) => onStopChange({ type: "percent", percent: Number(e.target.value) })}
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
                onChange={(e) => onStopChange({ type: stopRule.type, bufferAtr: Number(e.target.value) })}
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
              onTargetChange(
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
                onChange={(e) => onTargetChange({ type: "rr", ratio: Number(e.target.value) })}
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
                onChange={(e) => onTargetChange({ type: "atr", multiple: Number(e.target.value) })}
                className="w-16 rounded-md border border-edge bg-background px-2 py-1 outline-none"
              />
              × ATR
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
