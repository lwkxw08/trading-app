// Resolves API paths against the page origin. Browsers reject fetch() with a
// relative URL when the document URL embeds credentials (user:pass@host), so
// always build an absolute URL from location.origin, which strips them.
export function apiUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}

/** GET JSON with the same defensive parsing/retry behaviour as postJson. */
export async function getJson<T>(path: string, retries = 1): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(apiUrl(path));
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (attempt < retries) continue;
      throw new Error("The server couldn't complete this request. Please retry.");
    }
    if (!r.ok) throw new Error((data as { error?: string }).error ?? "request failed");
    return data as T;
  }
}

/**
 * POST JSON and parse a JSON response defensively. Heavy requests (e.g.
 * backtests) can occasionally exceed the host's compute limit, which returns
 * an HTML/plain-text error page instead of JSON — retry once, then surface a
 * readable message rather than a JSON parse error.
 */
export async function postJson<T>(path: string, body: unknown, retries = 1): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(apiUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      if (attempt < retries) continue;
      throw new Error(
        "The server couldn't complete this request (it likely hit the hosting compute limit). Try fewer history bars or a higher timeframe, then retry.",
      );
    }
    if (!r.ok) throw new Error((data as { error?: string }).error ?? "request failed");
    return data as T;
  }
}
