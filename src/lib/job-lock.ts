import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";

const PERIOD = "lock";

/**
 * Claims a per-business lock kept in JobRun. Returns false if another holder has it. A lock older
 * than `staleAfter` (a Postgres interval, e.g. "10 minutes") is taken over, so a crash or a closed
 * tab can't block the work forever. (One upsert whose WHERE only matches a finished or stale row.)
 */
export async function claimLock(businessId: string, job: string, staleAfter: string): Promise<boolean> {
  const changed = await db.$executeRaw`
    INSERT INTO "JobRun" ("id", "businessId", "job", "period", "status", "startedAt")
    VALUES (${randomUUID()}, ${businessId}, ${job}, ${PERIOD}, 'RUNNING', now())
    ON CONFLICT ("businessId", "job", "period") DO UPDATE
      SET "status" = 'RUNNING', "startedAt" = now(), "finishedAt" = NULL, "error" = NULL
      WHERE "JobRun"."status" <> 'RUNNING' OR "JobRun"."startedAt" < now() - ${staleAfter}::interval`;
  return changed === 1;
}

/** Releases a lock; a no-op if it was never claimed. */
export async function releaseLock(businessId: string, job: string): Promise<void> {
  await db.jobRun.updateMany({
    where: { businessId, job, period: PERIOD, status: "RUNNING" },
    data: { status: "SUCCEEDED", finishedAt: new Date() },
  });
}
