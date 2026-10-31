import { previousMonth } from "@/lib/dates";
import { monthLabel } from "@/lib/format";
import { lockAndSend, type CloseDeps } from "@/lib/report/close-month";

// The two monthly jobs, as orchestration over injected dependencies (testable without a database or the mailer):
//   3rd: review nudge     tell the owner how many bank transactions from last month still need a look
//   5th: monthly close    sync -> lock -> send last month's report, but only when it is safe to do so unattended
// Both are OFF unless REPORTS_AUTO_SEND=true, are idempotent per month (a JobRun row), and never lock a month with
// unreviewed transactions or a bank that needs attention: they send a notice saying why instead.

export const autoSendEnabled = (env: Record<string, string | undefined> = process.env): boolean => env.REPORTS_AUTO_SEND === "true";

export type JobDeps = {
  now(): Date;
  timezone: string;
  /** false = this month's run is already done (or running). */
  claim(job: string, period: string): Promise<boolean>;
  finish(job: string, period: string, error?: string): Promise<void>;
  /** Plain-text notice to the owner (and cc). */
  notify(subject: string, body: string): Promise<void>;
};

export type NudgeDeps = JobDeps & { unreviewed(month: string): Promise<number> };
export type NudgeResult = { status: "disabled" | "already_done" | "nothing_to_review" | "sent" | "failed"; month?: string; count?: number };

export async function reviewNudge(deps: NudgeDeps, env: Record<string, string | undefined> = process.env): Promise<NudgeResult> {
  if (!autoSendEnabled(env)) return { status: "disabled" };
  const month = previousMonth(deps.now(), deps.timezone);
  if (!(await deps.claim("review-nudge", month))) return { status: "already_done", month };
  try {
    const count = await deps.unreviewed(month);
    if (!count) {
      await deps.finish("review-nudge", month);
      return { status: "nothing_to_review", month, count: 0 };
    }
    await deps.notify(
      `${count} transaction${count === 1 ? "" : "s"} to review before the ${monthLabel(month)} report`,
      `${count} bank transaction${count === 1 ? " from" : "s from"} ${monthLabel(month, true)} still need${count === 1 ? "s" : ""} a category.\n\nThe ${monthLabel(month)} report is built and sent on the 5th. Anything still unreviewed then is left out of Net Income, so the report won't be locked automatically.\n\nOpen Review in Yummy Finances and clear them when you have a few minutes.`,
    );
    await deps.finish("review-nudge", month);
    return { status: "sent", month, count };
  } catch (e) {
    await deps.finish("review-nudge", month, e instanceof Error ? e.message : "failed");
    return { status: "failed", month };
  }
}

export type CloseCronDeps = JobDeps & {
  /** Runs the same sync as the Sync now button. `problems` is empty when everything succeeded. */
  sync(): Promise<{ problems: string[] }>;
  /** Banks that need attention (reconnect, error) or none connected: the data may be incomplete. */
  bankProblems(): Promise<string[]>;
  close: CloseDeps;
};
export type CloseCronResult = { status: "disabled" | "already_done" | "synced_failed" | "blocked" | "send_failed" | "sent"; month?: string };

export async function monthlyClose(deps: CloseCronDeps, env: Record<string, string | undefined> = process.env): Promise<CloseCronResult> {
  if (!autoSendEnabled(env)) return { status: "disabled" };
  const month = previousMonth(deps.now(), deps.timezone);
  if (!(await deps.claim("monthly-close", month))) return { status: "already_done", month };
  const name = monthLabel(month, true);
  const fail = async (status: CloseCronResult["status"], why: string, notice: string): Promise<CloseCronResult> => {
    await deps.finish("monthly-close", month, why);
    await deps.notify(`${monthLabel(month)} report was not sent`, `${notice}\n\nNothing was locked or sent for ${name} by the automatic job. Open Reports in Yummy Finances to look at it, fix what's flagged and press Lock & send, or send a test report first.`).catch(() => undefined);
    return { status, month };
  };
  try {
    // 1. sync: a report built on stale data is worse than a late one
    const sync = await deps.sync();
    if (sync.problems.length) return fail("synced_failed", `sync: ${sync.problems.join("; ")}`, `The sync before the report had problems: ${sync.problems.join("; ")}.`);

    // 2. lock and send, only if safe unattended (unreviewed transactions or a bank needing attention block it)
    const res = await lockAndSend(deps.close, month, { actor: "monthly-close", auto: { bankProblems: await deps.bankProblems() } });
    if (res.ok) {
      await deps.finish("monthly-close", month);
      return { status: "sent", month };
    }
    if (res.code === "already_locked_sent") {
      await deps.finish("monthly-close", month);
      return { status: "already_done", month };
    }
    return fail(res.code === "send_failed" ? "send_failed" : "blocked", res.message, res.message);
  } catch (e) {
    return fail("send_failed", e instanceof Error ? e.message : "failed", "The automatic close hit an unexpected error.");
  }
}
