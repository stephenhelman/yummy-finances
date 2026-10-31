import { addMonths } from "@/lib/dates";

// Request parsing for the production Clover backfill (POST /api/admin/backfill-clover). Pure. A call covers at most three months so
// it stays well inside the function time limit; a year is four calls (one per quarter).

export const MAX_BACKFILL_MONTHS = 3;
const MONTH = /^(20\d\d)-(0[1-9]|1[0-2])$/;
const QUARTER_START = ["01", "04", "07", "10"] as const;

export type BackfillPlan = { months: string[]; target: string; lookbackMonths: number; clipped: boolean };
export type BackfillParse = { ok: true; plan: BackfillPlan } | { ok: false; error: string };

/**
 * Accepts { year, quarter } or { from, to } (months, "YYYY-MM"). Months after `currentMonth` are dropped (there is nothing to sync
 * yet); a range of more than three months is refused.
 */
export function parseBackfill(body: unknown, currentMonth: string): BackfillParse {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  let from: string, to: string;

  if (b.year !== undefined || b.quarter !== undefined) {
    if (b.from !== undefined || b.to !== undefined) return { ok: false, error: "Give year and quarter, or from and to, not both." };
    const year = Number(b.year), quarter = Number(b.quarter);
    if (!Number.isInteger(year) || year < 2020 || year > Number(currentMonth.slice(0, 4))) return { ok: false, error: "year must be a year from 2020 to this year." };
    if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) return { ok: false, error: "quarter must be 1, 2, 3 or 4." };
    from = `${year}-${QUARTER_START[quarter - 1]}`;
    to = addMonths(from, 2);
  } else {
    if (typeof b.from !== "string" || typeof b.to !== "string" || !MONTH.test(b.from) || !MONTH.test(b.to)) return { ok: false, error: "Give { year, quarter } or { from: \"YYYY-MM\", to: \"YYYY-MM\" }." };
    from = b.from;
    to = b.to;
  }
  if (to < from) return { ok: false, error: "from must not be after to." };

  const months: string[] = [];
  for (let m = from; m <= to; m = addMonths(m, 1)) {
    months.push(m);
    if (months.length > MAX_BACKFILL_MONTHS) return { ok: false, error: `At most ${MAX_BACKFILL_MONTHS} months per call. Split it up (a year is four calls, one per quarter).` };
  }
  const usable = months.filter((m) => m <= currentMonth);
  if (!usable.length) return { ok: false, error: "That range is in the future: nothing to sync yet." };
  return { ok: true, plan: { months: usable, target: usable[usable.length - 1], lookbackMonths: usable.length - 1, clipped: usable.length < months.length } };
}
