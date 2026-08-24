const STORAGE_KEY = "tradeintel.favorites.v1";
export const FAVORITES_EVENT = "tradeintel:favorites";

export function loadFavorites(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as string[]).filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function saveFavorites(favorites: string[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  window.dispatchEvent(new Event(FAVORITES_EVENT));
}

export function toggleFavorite(symbol: string): string[] {
  const s = symbol.trim().toUpperCase();
  if (!s) return loadFavorites();
  const current = loadFavorites();
  const next = current.includes(s) ? current.filter((f) => f !== s) : [...current, s];
  saveFavorites(next);
  return next;
}
