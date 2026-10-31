import { DateTime } from "luxon";
import { monthBounds } from "@/lib/dates";
import type { Report } from "@/lib/report/pnl";

// Rules for closing a month: when it may be locked, and what the AUTOMATIC close refuses to lock over. Pure.

/** A month can't be locked until this many days after it ends (late bank postings, Clover offline uploads). */
export const LOCK_DELAY_DAYS = 3;

export type Eligibility = { ok: true } | { ok: false; reason: string; availableFrom: string };

/** Lock is blocked for the current month and for any month that ended fewer than LOCK_DELAY_DAYS days ago (business timezone). */
export function lockEligibility(month: string, now: Date, timezone: string): Eligibility {
  const end = DateTime.fromJSDate(monthBounds(month, timezone).end, { zone: timezone });
  const from = end.plus({ days: LOCK_DELAY_DAYS });
  const when = DateTime.fromJSDate(now, { zone: timezone });
  if (when >= from) return { ok: true };
  const availableFrom = from.toFormat("yyyy-MM-dd");
  const monthStillOpen = when < end;
  return {
    ok: false,
    availableFrom,
    reason: monthStillOpen
      ? `That month isn't over yet. It can be locked from ${from.toFormat("LLL d")}.`
      : `That month ended less than ${LOCK_DELAY_DAYS} days ago, so late transactions may still arrive. It can be locked from ${from.toFormat("LLL d")}.`,
  };
}

/** Bank transactions in the report that nobody has reviewed (Zelle, checks, other): they are NOT in Net Income. */
export function unreviewedCount(report: Pick<Report, "below">): number {
  return report.below.groups.flatMap((g) => g.lines).filter((l) => l.computed).reduce((a, l) => a + (l.count ?? 0), 0) + (report.below.uncategorized.count ?? 0);
}

/** What stops the AUTOMATIC close (a person pressing Lock & send sees the same as warnings and decides). Empty = safe to lock. */
export function autoBlockers(report: Pick<Report, "below">, bankProblems: readonly string[]): string[] {
  const out: string[] = [];
  const n = unreviewedCount(report);
  if (n) out.push(`${n} bank transaction${n === 1 ? " is" : "s are"} still waiting for review`);
  out.push(...bankProblems);
  return out;
}
