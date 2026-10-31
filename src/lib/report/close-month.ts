import { createHash } from "node:crypto";
import { lockEligibility, autoBlockers } from "@/lib/report/close";
import type { Report } from "@/lib/report/pnl";

// Lock, send, re-send and test-send, as plain orchestration over injected dependencies (so every branch is testable without a
// database or the mailer). The Prisma/Apps Script wiring is in close-store.ts. Rules, in order of importance:
//   - a LOCKED month is never recomputed: sending it again sends the stored snapshot
//   - locking never loses data when sending fails: the month stays LOCKED, marked "not sent", and Re-send is offered
//   - a TEST send touches nothing: no lock, no delivery record, a separate workbook, owner only

export type Snapshot = { month: string; status: "DRAFT" | "LOCKED"; dataJson: unknown; emailSentAt: Date | null };

export type CloseDeps = {
  now(): Date;
  timezone: string;
  /** The month as it would be reported right now (never a stored snapshot). */
  liveReport(month: string): Promise<Report>;
  getSnapshot(month: string): Promise<Snapshot | null>;
  /** Idempotent; returns the snapshot and whether this call performed the lock. */
  lock(month: string, report: Report, inputsHash: string): Promise<{ snapshot: Snapshot; created: boolean }>;
  /** Throws on failure. */
  send(snapshot: Snapshot): Promise<void>;
  recordSent(month: string, at: Date): Promise<void>;
  sendTest(month: string, report: Report): Promise<void>;
  audit(action: string, payload: Record<string, unknown>): Promise<void>;
};

export type CloseResult =
  | { ok: true; locked: boolean; sent: boolean; alreadyLocked: boolean }
  | { ok: false; code: "not_eligible" | "already_locked_sent" | "send_failed" | "not_locked" | "blocked"; message: string; locked?: boolean };

export const hashReport = (r: Report): string => createHash("sha256").update(JSON.stringify(r)).digest("hex");
const msg = (e: unknown) => (e instanceof Error ? e.message : "failed").slice(0, 300);

/** "Lock & send": lock the month (if it isn't) and send it. Safe to call again after a failed send. */
export async function lockAndSend(deps: CloseDeps, month: string, opts: { actor: string; auto?: { bankProblems: readonly string[] } }): Promise<CloseResult> {
  const existing = await deps.getSnapshot(month);
  if (existing?.status === "LOCKED" && existing.emailSentAt) return { ok: false, code: "already_locked_sent", message: "That month is already locked and sent. Use Re-send to send it again." };

  let snapshot = existing?.status === "LOCKED" ? existing : null;
  let created = false;
  if (!snapshot) {
    const elig = lockEligibility(month, deps.now(), deps.timezone);
    if (!elig.ok) return { ok: false, code: "not_eligible", message: elig.reason };
    const report = await deps.liveReport(month);
    if (opts.auto) {
      const blockers = autoBlockers(report, opts.auto.bankProblems);
      if (blockers.length) return { ok: false, code: "blocked", message: `Not locked automatically: ${blockers.join("; ")}.` };
    }
    ({ snapshot, created } = await deps.lock(month, report, hashReport(report)));
    await deps.audit("report.lock", { month, created, auto: !!opts.auto, actor: opts.actor, warnings: report.warnings.length });
  }

  try {
    await deps.send(snapshot);
  } catch (e) {
    await deps.audit("report.send_failed", { month, auto: !!opts.auto, error: msg(e) });
    return { ok: false, code: "send_failed", locked: true, message: `The month is locked, but sending failed: ${msg(e)}. Use Re-send to try again.` };
  }
  await deps.recordSent(month, deps.now());
  await deps.audit("report.send", { month, resend: false, auto: !!opts.auto });
  return { ok: true, locked: true, sent: true, alreadyLocked: !created };
}

/** Send a locked month again. Sends the stored snapshot, never today's numbers. */
export async function resend(deps: CloseDeps, month: string): Promise<CloseResult> {
  const snap = await deps.getSnapshot(month);
  if (!snap || snap.status !== "LOCKED") return { ok: false, code: "not_locked", message: "Only a locked month can be re-sent." };
  try {
    await deps.send(snap);
  } catch (e) {
    await deps.audit("report.send_failed", { month, resend: true, error: msg(e) });
    return { ok: false, code: "send_failed", locked: true, message: `Sending failed: ${msg(e)}.` };
  }
  await deps.recordSent(month, deps.now());
  await deps.audit("report.send", { month, resend: true });
  return { ok: true, locked: true, sent: true, alreadyLocked: true };
}

/** A clearly labelled TEST copy of the report as it would look. Changes nothing about the month. */
export async function sendTest(deps: CloseDeps, month: string): Promise<CloseResult> {
  const snap = await deps.getSnapshot(month);
  const report = snap?.status === "LOCKED" ? (snap.dataJson as Report) : await deps.liveReport(month);
  try {
    await deps.sendTest(month, report);
  } catch (e) {
    await deps.audit("report.test_failed", { month, error: msg(e) });
    return { ok: false, code: "send_failed", message: `The test report didn't send: ${msg(e)}.` };
  }
  await deps.audit("report.test", { month });
  return { ok: true, locked: false, sent: false, alreadyLocked: snap?.status === "LOCKED" };
}
