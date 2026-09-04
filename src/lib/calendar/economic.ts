import type { EconomicEvent, EventImpact } from "./types";

const FF_CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";

interface FFEvent {
  title: string;
  country: string;
  date: string; // ISO 8601
  impact: string;
  forecast?: string;
  previous?: string;
}

// TradingView's public economic-calendar API; reachable from datacenter IPs
// (e.g. Cloudflare Workers) where the faireconomy CDN rate-limits requests.
const TV_CALENDAR_URL = "https://economic-calendar.tradingview.com/events";
const TV_COUNTRIES = "US,EU,GB,JP,CN,CA,AU,NZ,CH";

interface TVEvent {
  title: string;
  country: string;
  currency: string;
  date: string; // ISO 8601
  importance: number; // -1 low, 0 medium, 1 high
  forecast: number | null;
  previous: number | null;
  unit?: string;
}

/**
 * Free weekly economic calendar feed (Forex Factory data via faireconomy CDN),
 * with TradingView's calendar API as fallback.
 * Covers CPI, FOMC, NFP, central-bank decisions etc. Cached for 30 minutes.
 */
export async function getEconomicCalendar(): Promise<EconomicEvent[]> {
  const events = await fetchFFCalendar();
  if (events.length > 0) return events;
  return fetchTVCalendar();
}

async function fetchFFCalendar(): Promise<EconomicEvent[]> {
  try {
    const res = await fetch(FF_CALENDAR_URL, { next: { revalidate: 1800 } });
    if (!res.ok) return [];
    const raw = (await res.json()) as FFEvent[];
    return raw
      .map((e) => ({
        title: e.title,
        country: e.country,
        timestamp: Math.floor(new Date(e.date).getTime() / 1000),
        impact: normalizeImpact(e.impact),
        forecast: e.forecast || undefined,
        previous: e.previous || undefined,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

async function fetchTVCalendar(): Promise<EconomicEvent[]> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - 1 * 86400_000).toISOString();
    const to = new Date(now.getTime() + 7 * 86400_000).toISOString();
    const url = `${TV_CALENDAR_URL}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&countries=${TV_COUNTRIES}`;
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", origin: "https://www.tradingview.com" },
      next: { revalidate: 1800 },
    });
    if (!res.ok) return [];
    const raw = (await res.json()) as { result?: TVEvent[] };
    return (raw.result ?? [])
      .map((e) => ({
        title: e.title,
        country: e.currency || e.country,
        timestamp: Math.floor(new Date(e.date).getTime() / 1000),
        impact: (e.importance >= 1 ? "high" : e.importance === 0 ? "medium" : "low") as EventImpact,
        forecast: e.forecast !== null ? `${e.forecast}${e.unit ?? ""}` : undefined,
        previous: e.previous !== null ? `${e.previous}${e.unit ?? ""}` : undefined,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

function normalizeImpact(impact: string): EventImpact {
  const v = impact.toLowerCase();
  if (v.includes("high")) return "high";
  if (v.includes("medium")) return "medium";
  return "low";
}

export function upcomingHighImpact(events: EconomicEvent[], withinHours = 48): EconomicEvent[] {
  const now = Date.now() / 1000;
  return events.filter((e) => e.impact === "high" && e.timestamp > now && e.timestamp < now + withinHours * 3600);
}
