import type { CustomStrategy } from "./custom";

const STORAGE_KEY = "tradeintel.strategies.v1";
const MAX_STRATEGIES = 30;

export interface SavedStrategy {
  id: string;
  savedAt: number;
  source: "manual" | "calibrated";
  strategy: CustomStrategy;
}

export function loadSavedStrategies(): SavedStrategy[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedStrategy[]) : [];
  } catch {
    return [];
  }
}

export function saveSavedStrategies(list: SavedStrategy[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_STRATEGIES)));
}

export function addSavedStrategy(strategy: CustomStrategy, source: SavedStrategy["source"] = "manual"): SavedStrategy[] {
  const entry: SavedStrategy = {
    id: `strat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    savedAt: Date.now(),
    source,
    strategy,
  };
  const next = [entry, ...loadSavedStrategies()].slice(0, MAX_STRATEGIES);
  saveSavedStrategies(next);
  return next;
}

/** Overwrite a saved strategy's definition in place (keeps its id and position). */
export function updateSavedStrategy(id: string, strategy: CustomStrategy): SavedStrategy[] {
  const next = loadSavedStrategies().map((s) => (s.id === id ? { ...s, savedAt: Date.now(), strategy } : s));
  saveSavedStrategies(next);
  return next;
}

export function deleteSavedStrategy(id: string): SavedStrategy[] {
  const next = loadSavedStrategies().filter((s) => s.id !== id);
  saveSavedStrategies(next);
  return next;
}
