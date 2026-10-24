import { monthLabel } from "@/lib/format";
import type { ManualSyncResult } from "@/lib/sync-now";

// Plain-language result of a manual sync, for the owner. Persisted so the dashboard can show the last run.

export type SyncSummary = {
  at: string; // ISO time
  atLabel: string; // already formatted in the business timezone
  ok: boolean;
  plaidOk: boolean;
  cloverOk: boolean;
  lines: string[];
};

export function summarizeSync(result: ManualSyncResult, at: Date, atLabel: string): SyncSummary {
  const lines: string[] = [];
  let plaidOk = true;
  let cloverOk = true;

  const p = result.plaid;
  if (!p.ok) {
    plaidOk = false;
    lines.push(`Bank: couldn't sync. ${p.error}`);
  } else {
    const r = p.result;
    if (r.outcome === "no_bank_connected") lines.push("Bank: not connected yet.");
    else if (r.outcome === "skipped") {
      plaidOk = false;
      lines.push(`Bank: skipped. ${"message" in r && r.message ? r.message : "The bank connection needs attention. Open Connections."}`);
    } else if (r.outcome === "not_ready") lines.push("Bank: Plaid is still preparing your transactions. Try again in a minute.");
    else {
      const c = r.counts;
      const changes = c.created + c.updated + c.removed;
      let line = changes === 0 ? "Bank: up to date." : `Bank: ${c.created} new, ${c.updated} changed, ${c.removed} removed.`;
      if (c.late) line += ` ${c.late} landed in a month that was already closed.`;
      if (c.audited) line += ` ${c.audited} need a look.`;
      lines.push(line);
    }
  }

  const c = result.clover;
  if (!c.ok) {
    cloverOk = false;
    lines.push(`Clover: couldn't sync. ${c.error}`);
  } else {
    const months = c.report.months;
    const newPayments = months.reduce((a, m) => a + m.payments.created, 0);
    const changedPayments = months.reduce((a, m) => a + m.payments.updated, 0);
    const newRefunds = months.reduce((a, m) => a + m.refunds.created, 0);
    const span = months.length > 1 ? `${monthLabel(months[0].month)} to ${monthLabel(months[months.length - 1].month)}` : monthLabel(months[0].month);
    lines.push(
      newPayments + changedPayments + newRefunds === 0
        ? `Clover: up to date (${span} checked).`
        : `Clover: ${newPayments} new payments, ${changedPayments} changed, ${newRefunds} new refunds (${span} checked).`,
    );
  }

  return { at: at.toISOString(), atLabel, ok: plaidOk && cloverOk, plaidOk, cloverOk, lines };
}
