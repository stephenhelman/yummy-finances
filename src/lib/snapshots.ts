import { Prisma } from "@/generated/prisma/client";
import type { MonthSnapshot } from "@/generated/prisma/client";
import { db } from "@/lib/db";

export type LockResult = {
  snapshot: MonthSnapshot;
  /** true if this call performed the lock; false if the month was already locked. */
  created: boolean;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Locks a month by writing its snapshot. Idempotent and never overwrites:
 * if the month is already LOCKED the existing snapshot is returned untouched,
 * even if the new data differs. (The DB trigger enforces the same rule.)
 */
export async function lockMonth(args: {
  businessId: string;
  month: string;
  data: Prisma.InputJsonValue;
  inputsHash: string;
}): Promise<LockResult> {
  const { businessId, month, data, inputsHash } = args;
  if (!MONTH_RE.test(month)) throw new Error(`Invalid month: ${month}`);

  const existing = await db.monthSnapshot.findUnique({
    where: { businessId_month: { businessId, month } },
  });
  if (existing?.status === "LOCKED") return { snapshot: existing, created: false };

  const lockedAt = new Date();
  try {
    if (!existing) {
      const snapshot = await db.monthSnapshot.create({
        data: { businessId, month, status: "LOCKED", dataJson: data, inputsHash, lockedAt },
      });
      return { snapshot, created: true };
    }
    // Existing DRAFT: promote atomically; the status guard stops a concurrent lock from being overwritten.
    const { count } = await db.monthSnapshot.updateMany({
      where: { id: existing.id, status: "DRAFT" },
      data: { status: "LOCKED", dataJson: data, inputsHash, lockedAt },
    });
    const snapshot = await db.monthSnapshot.findUniqueOrThrow({ where: { id: existing.id } });
    return { snapshot, created: count === 1 };
  } catch (e) {
    // Lost a create race on (businessId, month): the other writer's snapshot wins.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const snapshot = await db.monthSnapshot.findUniqueOrThrow({
        where: { businessId_month: { businessId, month } },
      });
      return { snapshot, created: false };
    }
    throw e;
  }
}

/** Delivery-state updates are the only writes allowed on a locked snapshot. */
export async function recordDelivery(
  snapshotId: string,
  delivery: { pdfBlobKey?: string; emailSentAt?: Date; emailId?: string },
): Promise<void> {
  await db.monthSnapshot.update({ where: { id: snapshotId }, data: delivery });
}
