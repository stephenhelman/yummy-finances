// Live check of the snapshot trigger on the configured DB. Everything runs in
// a transaction that is always rolled back, leaving no rows behind.
import "dotenv/config";
import assert from "node:assert/strict";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";

const ROLLBACK = "rollback-sentinel";

async function main() {
  const db = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DIRECT_URL! }) });
  try {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "Business"(id,name,timezone,"ownerEmail","updatedAt") VALUES ('t1','t','UTC','o@x.com',now())`);
      await tx.$executeRawUnsafe(`INSERT INTO "MonthSnapshot"(id,"businessId",month,status,"dataJson","inputsHash","lockedAt","updatedAt") VALUES ('s1','t1','2026-01','LOCKED','{"v":1}','h',now(),now())`);
      // A failed statement aborts a Postgres transaction, so each negative check uses a savepoint.
      for (const [label, sql] of [
        ["update dataJson", `UPDATE "MonthSnapshot" SET "dataJson"='{"v":2}' WHERE id='s1'`],
        ["delete", `DELETE FROM "MonthSnapshot" WHERE id='s1'`],
        ["unlock", `UPDATE "MonthSnapshot" SET status='DRAFT' WHERE id='s1'`],
      ] as const) {
        await tx.$executeRawUnsafe("SAVEPOINT sp");
        await assert.rejects(tx.$executeRawUnsafe(sql), /locked|immutable|deleted/i, label);
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT sp");
      }
      await tx.$executeRawUnsafe(`UPDATE "MonthSnapshot" SET "emailId"='e1' WHERE id='s1'`);
      console.log("trigger enforced on live DB");
      throw new Error(ROLLBACK);
    });
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes(ROLLBACK)) throw e;
  } finally {
    const left = await db.business.count({ where: { id: "t1" } });
    assert.equal(left, 0, "test rows must not persist");
    await db.$disconnect();
  }
  console.log("rolled back, no residue");
}
main().catch((e) => { console.error(e); process.exit(1); });
