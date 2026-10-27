import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { syncCloverMonth, type CloverSyncReport } from "@/lib/clover/sync";
import { currentMonth } from "@/lib/dates";
import { formatDateTime } from "@/lib/format";
import { getPlaid, itemsFor, plaidErrorSummary } from "@/lib/plaid";
import { syncPlaidItem } from "@/lib/plaid/sync";
import { syncBanks, type BankSyncResult } from "@/lib/plaid/sync-all";
import { summarizeSync, type SyncSummary } from "@/lib/sync-summary";

const JOB = "sync-now";
const LOCK_PERIOD = "lock";
const STALE_AFTER = "10 minutes"; // a crashed run can't block syncing forever

/**
 * Claims the manual-sync lock atomically. Returns false if another run is in progress.
 * (One upsert whose WHERE only matches a finished or stale row.)
 */
export async function claimSyncLock(businessId: string): Promise<boolean> {
  const changed = await db.$executeRaw`
    INSERT INTO "JobRun" ("id", "businessId", "job", "period", "status", "startedAt")
    VALUES (${randomUUID()}, ${businessId}, ${JOB}, ${LOCK_PERIOD}, 'RUNNING', now())
    ON CONFLICT ("businessId", "job", "period") DO UPDATE
      SET "status" = 'RUNNING', "startedAt" = now(), "finishedAt" = NULL, "error" = NULL
      WHERE "JobRun"."status" <> 'RUNNING' OR "JobRun"."startedAt" < now() - ${STALE_AFTER}::interval`;
  return changed === 1;
}

export async function releaseSyncLock(businessId: string, error?: string): Promise<void> {
  await db.jobRun.update({
    where: { businessId_job_period: { businessId, job: JOB, period: LOCK_PERIOD } },
    data: { status: error ? "FAILED" : "SUCCEEDED", finishedAt: new Date(), error: error?.slice(0, 500) ?? null },
  });
}

export type ManualSyncResult = {
  plaid: { ok: true; banks: BankSyncResult[] } | { ok: false; error: string }; // banks is empty when none is connected
  clover: { ok: true; report: CloverSyncReport } | { ok: false; error: string };
};

/** Plaid transactions for every connected bank, then Clover for the current month plus its two-month lookback. Failures are independent. */
export async function runManualSync(business: { id: string; timezone: string }): Promise<ManualSyncResult> {
  const out: ManualSyncResult = { plaid: { ok: false, error: "not run" }, clover: { ok: false, error: "not run" } };

  try {
    const { env } = getPlaid();
    const items = await itemsFor(business.id, env);
    out.plaid = { ok: true, banks: await syncBanks(items, (id) => syncPlaidItem(id), plaidErrorSummary) };
  } catch (e) {
    out.plaid = { ok: false, error: plaidErrorSummary(e) }; // message only: never the SDK error object
  }

  try {
    const month = currentMonth(new Date(), business.timezone);
    out.clover = { ok: true, report: await syncCloverMonth({ businessId: business.id, timezone: business.timezone, month }) };
  } catch (e) {
    out.clover = { ok: false, error: e instanceof Error ? e.message : "Clover sync failed" };
  }
  return out;
}

const RESULT_ACTION = "sync_result";

/** Runs a manual sync, records a plain-language summary (shown on the dashboard) and returns both. */
export async function runAndRecordManualSync(business: { id: string; timezone: string }, actor: string) {
  const result = await runManualSync(business);
  const now = new Date();
  const summary = summarizeSync(result, now, formatDateTime(now, business.timezone));
  await db.auditLog.create({
    data: { businessId: business.id, actor, action: RESULT_ACTION, entity: "sync", payload: summary as unknown as object },
  });
  return { result, summary };
}

export async function getLastSyncSummary(businessId: string): Promise<SyncSummary | null> {
  const row = await db.auditLog.findFirst({ where: { businessId, action: RESULT_ACTION }, orderBy: { createdAt: "desc" } });
  return (row?.payload as unknown as SyncSummary | null) ?? null;
}

/** When Clover last synced successfully through the app, or null. */
export async function getLastCloverSyncAt(businessId: string): Promise<Date | null> {
  const row = await db.auditLog.findFirst({
    where: { businessId, action: RESULT_ACTION, payload: { path: ["cloverOk"], equals: true } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}
