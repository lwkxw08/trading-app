"use client";

import { useEffect, useState } from "react";
import { apiUrl } from "@/components/api";
import { fmtTime } from "@/components/format";
import type { EconomicEvent, EventImpact } from "@/lib/calendar/types";

export default function CalendarPage() {
  const [events, setEvents] = useState<EconomicEvent[]>([]);
  const [impact, setImpact] = useState<EventImpact | "all">("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(apiUrl("/api/calendar"))
      .then((r) => r.json())
      .then((d) => setEvents(d.events ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const filtered = events.filter((e) => impact === "all" || e.impact === impact);
  const now = Date.now() / 1000;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Macro & Economic Calendar</h1>
        <select
          value={impact}
          onChange={(e) => setImpact(e.target.value as typeof impact)}
          className="rounded-md border border-edge bg-surface px-2 py-1.5 text-sm outline-none"
        >
          <option value="all">All impact</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </select>
      </div>
      {loading ? (
        <p className="text-sm text-muted">Loading this week&apos;s calendar…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Country</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Impact</th>
                <th className="px-3 py-2">Forecast</th>
                <th className="px-3 py-2">Previous</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={i} className={`border-t border-edge ${e.timestamp < now ? "opacity-40" : ""}`}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{fmtTime(e.timestamp)}</td>
                  <td className="px-3 py-2">{e.country}</td>
                  <td className="px-3 py-2">{e.title}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase ${
                        e.impact === "high"
                          ? "bg-bear/20 text-bear"
                          : e.impact === "medium"
                            ? "bg-accent/20 text-accent"
                            : "bg-edge text-muted"
                      }`}
                    >
                      {e.impact}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{e.forecast ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs">{e.previous ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
