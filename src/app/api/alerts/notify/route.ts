import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "edge";

const schema = z.object({
  message: z.string().min(1).max(2000),
  webhookUrl: z.string().url().startsWith("http").optional(),
  telegramChatId: z.string().min(1).max(64).optional(),
});

export async function POST(req: NextRequest) {
  const parsed = schema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  }
  const { message, webhookUrl, telegramChatId } = parsed.data;
  const results: Record<string, string> = {};

  if (webhookUrl) {
    try {
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message, content: message }),
      });
      results.webhook = res.ok ? "sent" : `error ${res.status}`;
    } catch (e) {
      results.webhook = e instanceof Error ? e.message : "failed";
    }
  }

  if (telegramChatId) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      results.telegram = "TELEGRAM_BOT_TOKEN not configured on the server";
    } else {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegramChatId, text: message }),
        });
        results.telegram = res.ok ? "sent" : `error ${res.status}`;
      } catch (e) {
        results.telegram = e instanceof Error ? e.message : "failed";
      }
    }
  }

  return NextResponse.json({ results });
}
