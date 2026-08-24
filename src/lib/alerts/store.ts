import type { AlertEvent, AlertRule, DeliverySettings } from "./types";

const RULES_KEY = "tradeintel.alerts.rules.v1";
const EVENTS_KEY = "tradeintel.alerts.events.v1";
const DELIVERY_KEY = "tradeintel.alerts.delivery.v1";
const MAX_EVENTS = 200;

export function loadRules(): AlertRule[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(RULES_KEY) ?? "[]") as AlertRule[];
  } catch {
    return [];
  }
}

export function saveRules(rules: AlertRule[]): void {
  window.localStorage.setItem(RULES_KEY, JSON.stringify(rules));
}

export function loadEvents(): AlertEvent[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(EVENTS_KEY) ?? "[]") as AlertEvent[];
  } catch {
    return [];
  }
}

export function saveEvents(events: AlertEvent[]): void {
  window.localStorage.setItem(EVENTS_KEY, JSON.stringify(events.slice(0, MAX_EVENTS)));
}

export function loadDelivery(): DeliverySettings {
  const fallback: DeliverySettings = { browserNotifications: true, webhookUrl: "", telegramChatId: "" };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(DELIVERY_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<DeliverySettings>) } : fallback;
  } catch {
    return fallback;
  }
}

export function saveDelivery(settings: DeliverySettings): void {
  window.localStorage.setItem(DELIVERY_KEY, JSON.stringify(settings));
}
