import { callAppsScript } from "@/lib/apps-script";
import { db } from "@/lib/db";
import { claimPeriodJob, finishPeriodJob } from "@/lib/jobs";
import { prismaCloseDeps } from "@/lib/report/close-store";
import type { CloseCronDeps, NudgeDeps } from "@/lib/report/cron-jobs";
import { loadTxnViews } from "@/lib/review/queries";
import { reviewQueue } from "@/lib/review/view";
import { claimSyncLock, releaseSyncLock, runManualSync } from "@/lib/sync-now";

type Business = { id: string; name: string; timezone: string; salesTaxInRevenue: boolean; ownerEmail: string; ccEmail: string | null };

const recipients = (b: Business) => [...new Set([b.ownerEmail, b.ccEmail].filter((e): e is string => !!e))];

function base(business: Business) {
  return {
    now: () => new Date(),
    timezone: business.timezone,
    claim: (job: string, period: string) => claimPeriodJob(business.id, job, period),
    finish: (job: string, period: string, error?: string) => finishPeriodJob(business.id, job, period, error),
    notify: (subject: string, body: string) => callAppsScript({ type: "notice", to: recipients(business), subject, body }),
  };
}

export function nudgeDeps(business: Business): NudgeDeps {
  return {
    ...base(business),
    unreviewed: async (month) => reviewQueue(await loadTxnViews(db, business.id, { reviewOnly: true })).filter((t) => t.month === month).length,
  };
}

export function closeCronDeps(business: Business): CloseCronDeps {
  return {
    ...base(business),
    close: prismaCloseDeps(business, "monthly-close"),
    bankProblems: async () => {
      const items = await db.plaidItem.findMany({ where: { businessId: business.id }, select: { institutionName: true, status: true } });
      if (!items.length) return ["no bank is connected"];
      return items.filter((i) => i.status !== "OK").map((i) => `${i.institutionName ?? "a bank"} needs attention (${i.status.toLowerCase().replace(/_/g, " ")})`);
    },
    sync: async () => {
      if (!(await claimSyncLock(business.id))) return { problems: ["another sync was already running"] };
      try {
        const r = await runManualSync(business);
        const problems: string[] = [];
        if (!r.plaid.ok) problems.push(`bank sync failed: ${r.plaid.error}`);
        else for (const b of r.plaid.banks) if (b.result.outcome !== "synced") problems.push(`${b.institution ?? "a bank"} didn't sync`);
        if (!r.clover.ok) problems.push(`Clover sync failed: ${r.clover.error}`);
        await releaseSyncLock(business.id, problems.length ? problems.join("; ") : undefined);
        return { problems };
      } catch (e) {
        await releaseSyncLock(business.id, e instanceof Error ? e.message : "failed");
        return { problems: ["the sync crashed"] };
      }
    },
  };
}
