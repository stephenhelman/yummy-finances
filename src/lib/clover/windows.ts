// Clover's Payments, Orders and Refunds endpoints only honor filters spanning
// <= 90 days (refunds silently narrow wider ranges to the most recent 90 days).
// We split any range into windows of at most 89 days so none is ever narrowed.

export const MAX_WINDOW_DAYS = 89;
const DAY_MS = 86_400_000;

export type Window = { fromMs: number; toMs: number }; // half-open [fromMs, toMs)

export function splitIntoWindows(startMs: number, endMs: number, maxDays = MAX_WINDOW_DAYS): Window[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new Error("Invalid window bounds");
  if (endMs <= startMs) return [];
  const span = maxDays * DAY_MS;
  const out: Window[] = [];
  for (let from = startMs; from < endMs; from += span) {
    out.push({ fromMs: from, toMs: Math.min(from + span, endMs) });
  }
  return out;
}
