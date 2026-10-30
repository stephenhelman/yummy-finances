import type { PrismaClient } from "@/generated/prisma/client";

// "Classification pending": until the rules backfill has run for a database, the kind/category columns are not
// trustworthy (rows written before the engine existed carry a leftover default). The backfill writes a marker when it
// finishes; anything that READS transaction classification must check it first.

export const BACKFILL_ACTION = "rules_backfill";

type AuditClient = Pick<PrismaClient, "auditLog">;

export class ClassificationPendingError extends Error {
  constructor() {
    super("Transactions have not been categorized yet (the rules backfill has not run).");
    this.name = "ClassificationPendingError";
  }
}

/** When the backfill last completed, or null if it never has. */
export async function backfillCompletedAt(client: AuditClient, businessId: string): Promise<Date | null> {
  const row = await client.auditLog.findFirst({ where: { businessId, action: BACKFILL_ACTION }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  return row?.createdAt ?? null;
}

export async function classificationReady(client: AuditClient, businessId: string): Promise<boolean> {
  return (await backfillCompletedAt(client, businessId)) !== null;
}

/** Call before reading kind / category / reviewStatus. Throws ClassificationPendingError until the backfill has run. */
export async function requireClassification(client: AuditClient, businessId: string): Promise<void> {
  if (!(await classificationReady(client, businessId))) throw new ClassificationPendingError();
}

export async function markBackfillComplete(client: AuditClient, businessId: string, actor: string, counts: Record<string, number>): Promise<void> {
  await client.auditLog.create({ data: { businessId, actor, action: BACKFILL_ACTION, entity: "rules", payload: counts } });
}
