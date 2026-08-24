// Resolves API paths against the page origin. Browsers reject fetch() with a
// relative URL when the document URL embeds credentials (user:pass@host), so
// always build an absolute URL from location.origin, which strips them.
export function apiUrl(path: string): string {
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path}`;
}
