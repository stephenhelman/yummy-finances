import { lockEligibility, unreviewedCount } from "@/lib/report/close";
import { hashReport, type CloseDeps, type Snapshot } from "@/lib/report/close-month";
import type { Report } from "@/lib/report/pnl";

// "Lock & file past months": lock a contiguous range of PAST months and write each one's tab (and so the YTD Summary row) to the real
// workbook through Apps Script WITHOUT sending any email. A one-time catch-up for months reported by hand before the app existed.
//
// Same lock rules as Lock & send (not the current month, not a month that ended under 3 days ago), and stricter on two counts:
//   - a month with unreviewed bank transactions is REFUSED (there is no override: review them first)
//   - every other warning must have been acknowledged for that month
// Everything is checked for ALL selected months before ANYTHING is locked. Then it works through them in order, one at a time; if a
// step fails it stops, and the months already done stay done. Re-running is safe: a locked month is not locked again, and its tab is
// simply rewritten with the same stored numbers.

export const MAX_FILE_MONTHS = 12;

export type FileDeps = CloseDeps & { file(snapshot: Snapshot): Promise<void> };

export type MonthPlan = { month: string; status: "DRAFT" | "LOCKED"; report: Report };
export type Problem = { month: string; kind: "not_eligible" | "unreviewed" | "unacknowledged"; message: string };

export type Done = { month: string; locked: boolean; filed: boolean };
export type FileResult =
  | { ok: true; done: Done[] }
  | { ok: false; reason: "problems"; problems: Problem[]; done: [] } // nothing was locked
  | { ok: false; reason: "failed"; done: Done[]; failedAt: { month: string; message: string } }; // the months in `done` stay done

/** The range's months, oldest first, or an error. `from` and `to` are "YYYY-MM". */
export function monthRange(from: string, to: string): string[] | string {
  const M = /^(\d{4})-(0[1-9]|1[0-2])$/;
  if (!M.test(from) || !M.test(to)) return "Choose a first and a last month.";
  if (to < from) return "The last month can't be before the first.";
  const out: string[] = [];
  for (let [y, m] = from.split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? ((y += 1), (m = 1)) : (m += 1)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (out.length > MAX_FILE_MONTHS) return `At most ${MAX_FILE_MONTHS} months at a time.`;
  }
  return out;
}

/** What blocks filing these months (empty = fine). `report` is today's numbers for an unlocked month, the stored ones for a locked month. */
export function problemsFor(plans: readonly MonthPlan[], now: Date, timezone: string, acknowledged: ReadonlySet<string>): Problem[] {
  const out: Problem[] = [];
  for (const p of plans) {
    if (p.status === "LOCKED") continue; // already locked: nothing to check, it is only (re)filed
    const elig = lockEligibility(p.month, now, timezone);
    if (!elig.ok) {
      out.push({ month: p.month, kind: "not_eligible", message: elig.reason });
      continue;
    }
    const un = unreviewedCount(p.report);
    if (un) out.push({ month: p.month, kind: "unreviewed", message: `${un} bank transaction${un === 1 ? " is" : "s are"} still waiting for review. Review ${un === 1 ? "it" : "them"} first.` });
    else if (p.report.warnings.length && !acknowledged.has(p.month)) out.push({ month: p.month, kind: "unacknowledged", message: `${p.report.warnings.length} warning${p.report.warnings.length === 1 ? "" : "s"} not acknowledged.` });
  }
  return out;
}

export async function fileMonths(deps: FileDeps, months: readonly string[], opts: { acknowledged: ReadonlySet<string> }): Promise<FileResult> {
  if (!months.length || months.length > MAX_FILE_MONTHS) return { ok: false, reason: "problems", problems: [{ month: months[0] ?? "", kind: "not_eligible", message: `Choose between 1 and ${MAX_FILE_MONTHS} months.` }], done: [] };

  // 1. check everything first; lock nothing if anything is wrong
  const plans: MonthPlan[] = [];
  for (const month of months) {
    const snap = await deps.getSnapshot(month);
    if (snap?.status === "LOCKED") plans.push({ month, status: "LOCKED", report: snap.dataJson as Report });
    else plans.push({ month, status: "DRAFT", report: await deps.liveReport(month) });
  }
  const problems = problemsFor(plans, deps.now(), deps.timezone, opts.acknowledged);
  if (problems.length) return { ok: false, reason: "problems", problems, done: [] };

  // 2. lock and file, one month at a time, oldest first
  const done: Done[] = [];
  for (const p of plans) {
    let snapshot: Snapshot;
    let locked = false;
    try {
      if (p.status === "LOCKED") snapshot = (await deps.getSnapshot(p.month))!;
      else {
        const r = await deps.lock(p.month, p.report, hashReport(p.report));
        snapshot = r.snapshot;
        locked = r.created;
        await deps.audit("report.lock", { month: p.month, created: r.created, bulk: true, warnings: p.report.warnings.length });
      }
      await deps.file(snapshot);
    } catch (e) {
      const message = (e instanceof Error ? e.message : "failed").slice(0, 300);
      await deps.audit("report.file_failed", { month: p.month, error: message, doneBefore: done.map((d) => d.month) });
      return { ok: false, reason: "failed", done, failedAt: { month: p.month, message } };
    }
    await deps.audit("report.file", { month: p.month, newlyLocked: locked });
    done.push({ month: p.month, locked, filed: true });
  }
  await deps.audit("report.file_range", { from: months[0], to: months[months.length - 1], months: months.length, newlyLocked: done.filter((d) => d.locked).length });
  return { ok: true, done };
}
