export function fmtPrice(value: number): string {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toFixed(2);
  return value.toPrecision(4);
}

export function fmtPct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function fmtCompact(value: number): string {
  return Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function timeAgo(unixMs: number): string {
  const mins = Math.max(0, Math.round((Date.now() - unixMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
