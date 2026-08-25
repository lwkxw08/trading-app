"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "./api";
import { buildPatternMemory } from "@/lib/ai/memory";
import { loadTrades } from "@/lib/journal/store";
import type { Timeframe } from "@/lib/market/types";
import { loadSignals } from "@/lib/signals/store";

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "Why is the top setup scoring what it is?",
  "What invalidates this setup?",
  "How do the higher timeframes affect this?",
  "What are the key macro risks right now?",
];

export default function AiChat({ symbol, tf }: { symbol: string; tf: Timeframe }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTurns([]);
    setError(null);
  }, [symbol, tf]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns, loading]);

  const ask = (question: string) => {
    const q = question.trim();
    if (!q || loading) return;
    const next: Turn[] = [...turns, { role: "user", content: q }];
    setTurns(next);
    setInput("");
    setLoading(true);
    setError(null);
    fetch(apiUrl("/api/ai/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol, tf, messages: next, memory: buildPatternMemory(loadSignals(), loadTrades(), symbol, tf) }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "AI chat failed");
        setTurns((prev) => [...prev, { role: "assistant", content: d.reply }]);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  return (
    <section className="rounded-lg border border-edge bg-surface p-4">
      <h2 className="font-semibold">Ask AI about this analysis</h2>
      <p className="mt-1 text-xs text-muted">
        Answers are grounded in the deterministic analysis of {symbol} on {tf} — scores, structures, levels and macro
        events.
      </p>
      {turns.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => ask(s)}
              disabled={loading}
              className="rounded-full border border-edge px-3 py-1 text-xs text-muted hover:border-accent hover:text-foreground disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}
      {turns.length > 0 && (
        <div className="mt-3 max-h-80 space-y-3 overflow-y-auto pr-1">
          {turns.map((t, i) => (
            <div key={i} className={t.role === "user" ? "flex justify-end" : "flex justify-start"}>
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm ${
                  t.role === "user" ? "bg-accent/20" : "border border-edge bg-background"
                }`}
              >
                {t.content}
              </div>
            </div>
          ))}
          {loading && <p className="text-xs text-muted">Thinking…</p>}
          <div ref={endRef} />
        </div>
      )}
      {error && <p className="mt-2 text-sm text-bear">{error}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
        className="mt-3 flex gap-2"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={`Ask about ${symbol}…`}
          className="flex-1 rounded-md border border-edge bg-background px-3 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-md bg-accent px-3 py-2 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50"
        >
          Ask
        </button>
      </form>
    </section>
  );
}
