import { NextResponse } from "next/server";
import { getEconomicCalendar } from "@/lib/calendar/economic";

export const runtime = "edge";

export async function GET() {
  const events = await getEconomicCalendar();
  return NextResponse.json({ events });
}
