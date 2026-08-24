const KEY = "tradeintel.drawings.v1";

type DrawingsMap = Record<string, number[]>;

function loadAll(): DrawingsMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DrawingsMap) : {};
  } catch {
    return {};
  }
}

function saveAll(map: DrawingsMap) {
  window.localStorage.setItem(KEY, JSON.stringify(map));
}

export function loadDrawings(symbol: string): number[] {
  return loadAll()[symbol.toUpperCase()] ?? [];
}

export function addDrawing(symbol: string, price: number): number[] {
  const map = loadAll();
  const key = symbol.toUpperCase();
  const next = [...(map[key] ?? []), price];
  map[key] = next;
  saveAll(map);
  return next;
}

export function removeDrawing(symbol: string, index: number): number[] {
  const map = loadAll();
  const key = symbol.toUpperCase();
  const next = (map[key] ?? []).filter((_, i) => i !== index);
  if (next.length === 0) delete map[key];
  else map[key] = next;
  saveAll(map);
  return next;
}

export function clearDrawings(symbol: string): number[] {
  const map = loadAll();
  delete map[symbol.toUpperCase()];
  saveAll(map);
  return [];
}
