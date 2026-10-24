// Applies every migration to an in-memory Postgres (PGlite) and exercises the
// snapshot immutability trigger. No external database needed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

async function rejects(p: Promise<unknown>, re: RegExp, msg: string) {
  await assert.rejects(p, re, msg);
}

async function main() {
  const db = new PGlite();
  const dir = join(process.cwd(), "prisma/migrations");
  for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) {
    await db.exec(readFileSync(join(dir, m, "migration.sql"), "utf8"));
    console.log(`applied ${m}`);
  }

  await db.exec(`INSERT INTO "Business"(id,name,timezone,"ownerEmail","updatedAt") VALUES ('b1','t','America/New_York','o@x.com',now())`);
  await db.exec(`INSERT INTO "MonthSnapshot"(id,"businessId",month,status,"dataJson","inputsHash","updatedAt") VALUES ('s1','b1','2026-08','DRAFT','{"v":1}','h1',now())`);

  // DRAFT is editable
  await db.exec(`UPDATE "MonthSnapshot" SET "dataJson"='{"v":2}' WHERE id='s1'`);
  // Locking requires lockedAt
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET status='LOCKED' WHERE id='s1'`), /requires lockedAt/, "lock w/o lockedAt");
  await db.exec(`UPDATE "MonthSnapshot" SET status='LOCKED',"lockedAt"=now() WHERE id='s1'`);

  // LOCKED: data columns immutable
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET "dataJson"='{"v":3}' WHERE id='s1'`), /immutable/, "dataJson");
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET "inputsHash"='zzz' WHERE id='s1'`), /immutable/, "inputsHash");
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET status='DRAFT' WHERE id='s1'`), /immutable/, "unlock");
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET month='2026-09' WHERE id='s1'`), /immutable/, "month");
  await rejects(db.exec(`UPDATE "MonthSnapshot" SET "lockedAt"=now() WHERE id='s1'`), /immutable/, "lockedAt");
  await rejects(db.exec(`DELETE FROM "MonthSnapshot" WHERE id='s1'`), /cannot be deleted/, "delete");
  await rejects(db.exec(`TRUNCATE "MonthSnapshot"`), /cannot be truncated/, "truncate");

  // Delivery columns stay writable
  await db.exec(`UPDATE "MonthSnapshot" SET "emailSentAt"=now(),"emailId"='e1',"pdfBlobKey"='k' WHERE id='s1'`);
  const r = await db.query<{ dataJson: { v: number }; emailId: string }>(`SELECT "dataJson","emailId" FROM "MonthSnapshot" WHERE id='s1'`);
  assert.deepEqual(r.rows[0], { dataJson: { v: 2 }, emailId: "e1" });

  // Unique (businessId, month)
  await rejects(
    db.exec(`INSERT INTO "MonthSnapshot"(id,"businessId",month,"dataJson","inputsHash","updatedAt") VALUES ('s2','b1','2026-08','{}','h',now())`),
    /duplicate key|unique/i,
    "unique month",
  );
  await db.close();
  console.log("migrations + snapshot trigger ok");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
