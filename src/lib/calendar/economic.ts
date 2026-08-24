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

/**
 * Free weekly economic calendar feed (Forex Factory data via faireconomy CDN).
 * Covers CPI, FOMC, NFP, central-bank decisions etc. Cached for 30 minutes.
 */
export async function getEconomicCalendar(): Promise<EconomicEvent[]> {
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
