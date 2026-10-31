import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

// Per-period cron idempotency on top of JobRun (unique on business + job + period). A period that SUCCEEDED is never run again;
// a FAILED one, or a RUNNING one older than `staleAfter` (a crash), can be claimed again. Returns false when there is nothing to do.
export async function claimPeriodJob(businessId: string, job: string, period: string, staleAfter = "15 minutes"): Promise<boolean> {
  const changed = await db.$executeRaw`
    INSERT INTO "JobRun" ("id", "businessId", "job", "period", "status", "startedAt")
    VALUES (${randomUUID()}, ${businessId}, ${job}, ${period}, 'RUNNING', now())
    ON CONFLICT ("businessId", "job", "period") DO UPDATE
      SET "status" = 'RUNNING', "startedAt" = now(), "finishedAt" = NULL, "error" = NULL
      WHERE "JobRun"."status" = 'FAILED' OR ("JobRun"."status" = 'RUNNING' AND "JobRun"."startedAt" < now() - ${staleAfter}::interval)`;
  return changed === 1;
}

export async function finishPeriodJob(businessId: string, job: string, period: string, error?: string): Promise<void> {
  await db.jobRun.updateMany({
    where: { businessId, job, period },
    data: { status: error ? "FAILED" : "SUCCEEDED", finishedAt: new Date(), error: error?.slice(0, 500) ?? null },
  });
}
