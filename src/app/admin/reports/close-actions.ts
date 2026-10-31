"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { claimLock, releaseLock } from "@/lib/job-lock";
import { classificationIsReady, withMessage } from "@/lib/review/gate";
import { lockEligibility } from "@/lib/report/close";
import { lockAndSend, resend, sendTest, type CloseResult } from "@/lib/report/close-month";
import { prismaCloseDeps, prismaFileDeps } from "@/lib/report/close-store";
import { fileMonths, monthRange } from "@/lib/report/file-months";
import { buildLiveReport } from "@/lib/report/load";

// Lock & send, Re-send and Send test report. Each re-checks admin, readiness and eligibility itself (a form post can be replayed
// without the page), takes a per-month lock so a double tap can't send twice, and ends with a redirect and a one-line message.

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = (f: FormData) => {
  const m = String(f.get("month") ?? "");
  if (!MONTH.test(m)) redirect("/admin/reports");
  return m;
};

async function run(formData: FormData, name: string, fn: (ctx: { deps: ReturnType<typeof prismaCloseDeps>; m: string; business: Awaited<ReturnType<typeof getBusiness>> }) => Promise<CloseResult>, done: string, back?: (m: string) => string): Promise<never> {
  const m = month(formData);
  const target = back ? back(m) : `/admin/reports/${m}`;
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) redirect(withMessage(target, "error", "Transactions haven't been categorized yet."));
  if (!(await claimLock(business.id, `${name}:${m}`, "10 minutes"))) redirect(withMessage(target, "error", "That is already running. Give it a minute."));
  let result: CloseResult;
  try {
    result = await fn({ deps: prismaCloseDeps(business, actor), m, business });
  } finally {
    await releaseLock(business.id, `${name}:${m}`);
  }
  revalidatePath("/admin/reports", "layout");
  if (!result.ok) redirect(withMessage(`/admin/reports/${m}`, "error", result.message));
  redirect(withMessage(`/admin/reports/${m}`, "notice", done));
}

export async function lockAndSendAction(formData: FormData): Promise<void> {
  await run(formData, "lock-send", async ({ deps, m, business }) => {
    // the confirm step shows the warnings: the post must say they were read, whenever there are any
    const snap = await deps.getSnapshot(m);
    if (snap?.status !== "LOCKED") {
      const elig = lockEligibility(m, new Date(), business.timezone);
      if (!elig.ok) return { ok: false, code: "not_eligible", message: elig.reason };
      const report = await buildLiveReport(business, m);
      if (report.warnings.length && formData.get("ack") !== "1") return { ok: false, code: "blocked", message: "Tick the box to say you've read the warnings, then lock." };
    }
    return lockAndSend(deps, m, { actor: "admin" });
  }, "Locked and sent.");
}

export async function resendAction(formData: FormData): Promise<void> {
  await run(formData, "resend", ({ deps, m }) => resend(deps, m), "Sent again.");
}

export async function sendTestAction(formData: FormData): Promise<void> {
  await run(formData, "send-test", ({ deps, m }) => sendTest(deps, m), "Test report sent to the owner's email (marked TEST). Nothing was locked.");
}

/**
 * One-time "Lock & file past months": lock a range of past months and write their tabs and YTD rows to the real workbook, with NO
 * email. All months are checked before any is locked (see src/lib/report/file-months.ts); the form must acknowledge warnings per month.
 */
export async function fileMonthsAction(formData: FormData): Promise<void> {
  const from = String(formData.get("from") ?? ""), to = String(formData.get("to") ?? "");
  const back = `/admin/reports/file-past?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const months = monthRange(from, to);
  if (typeof months === "string") redirect(withMessage("/admin/reports/file-past", "error", months));

  const { actor } = await requireAdmin();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) redirect(withMessage(back, "error", "Transactions haven't been categorized yet."));
  if (!(await claimLock(business.id, "file-past-months", "15 minutes"))) redirect(withMessage(back, "error", "Filing is already running. Give it a minute, then check the Reports list."));

  let result: Awaited<ReturnType<typeof fileMonths>>;
  try {
    const acknowledged = new Set(formData.getAll("ack").map(String));
    result = await fileMonths(prismaFileDeps(business, actor), months, { acknowledged });
  } finally {
    await releaseLock(business.id, "file-past-months");
  }
  revalidatePath("/admin/reports", "layout");

  if (!result.ok && result.reason === "problems") redirect(withMessage(back, "error", `Nothing was locked. ${result.problems.map((p) => `${p.month}: ${p.message}`).join(" ")}`));
  const done = result.done.length;
  if (!result.ok) {
    redirect(withMessage(back, "error", `Stopped at ${result.failedAt.month}: ${result.failedAt.message} ${done} month${done === 1 ? "" : "s"} before it ${done === 1 ? "was" : "were"} locked and filed. Run it again to carry on.`));
  }
  const fresh = result.done.filter((d) => d.locked).length;
  redirect(withMessage("/admin/reports", "notice", `Locked and filed ${done} month${done === 1 ? "" : "s"} (${fresh} newly locked). No email was sent.`));
}
