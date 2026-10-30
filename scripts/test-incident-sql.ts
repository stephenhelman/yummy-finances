// Exercises incident/inspect-reiblast.sql and incident/cleanup-reiblast.sql against an
// in-memory Postgres (PGlite) that imitates the incident state. No external database.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const m1 = read("prisma/migrations/0001_init/migration.sql");
const m2 = read("prisma/migrations/0002_full_schema/migration.sql");
const sha = (p: string) => createHash("sha256").update(readFileSync(join(process.cwd(), p))).digest("hex");
const inspect = read("incident/inspect-reiblast.sql");
const cleanup = read("incident/cleanup-reiblast.sql");
// What actually ran before the failure: everything up to the failing CREATE TABLE "JobRun".
const ran2 = m2.slice(0, m2.indexOf('CREATE TABLE "JobRun"'));

async function reiblast(opts: { applyYummy: boolean; migrationRows?: boolean } = { applyYummy: true }) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE _prisma_migrations (id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL,
      finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
      started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count int NOT NULL DEFAULT 0);
    INSERT INTO _prisma_migrations(id, checksum, migration_name, finished_at) VALUES ('r1','abc','reiblast_init', now());
    CREATE TYPE "ReiStatus" AS ENUM ('A','B');
    CREATE TABLE "JobRun" (id text PRIMARY KEY, kind text, status "ReiStatus");
    CREATE TABLE "User" (id text PRIMARY KEY, email text);
    INSERT INTO "JobRun" VALUES ('j1','x','A'); INSERT INTO "User" VALUES ('u1','a@b.c');`);
  if (opts.applyYummy) {
    await db.exec(m1);
    await db.exec(ran2);
    await db.exec(`INSERT INTO _prisma_migrations(id, checksum, migration_name, finished_at, applied_steps_count) VALUES ('y1','${sha("prisma/migrations/0001_init/migration.sql")}','0001_init', now(), 1)`);
    await db.exec(`INSERT INTO _prisma_migrations(id, checksum, migration_name, applied_steps_count) VALUES ('y2','${sha("prisma/migrations/0002_full_schema/migration.sql")}','0002_full_schema', 0)`);
  }
  return db;
}
const names = async (db: PGlite, kind: "r" | "e") =>
  (kind === "r"
    ? await db.query<{ n: string }>(`SELECT relname AS n FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1`)
    : await db.query<{ n: string }>(`SELECT typname AS n FROM pg_type WHERE typnamespace='public'::regnamespace AND typtype='e' ORDER BY 1`)
  ).rows.map((r) => r.n);

async function main() {
  // A: statement-by-statement state. Inspect sees Yummy objects; cleanup removes exactly them.
  {
    const db = await reiblast();
    const res = await db.exec(inspect);
    const flat = res.flatMap((r) => r.rows) as Record<string, unknown>[];
    assert.equal(flat.filter((r) => r.status === "YUMMY_MATCH").length, 11 + 8, "all 19 pre-JobRun objects match");
    assert.equal(flat.filter((r) => r.status === "SHAPE_MISMATCH").length, 0);
    assert.ok(!flat.some((r) => r.status === "EXISTS (not ours)"), "never-ran objects absent");
    await db.exec(cleanup);
    assert.deepEqual(await names(db, "r"), ["JobRun", "User", "_prisma_migrations"]);
    assert.deepEqual(await names(db, "e"), ["ReiStatus"]);
    const mig = await db.query<{ migration_name: string }>(`SELECT migration_name FROM _prisma_migrations`);
    assert.deepEqual(mig.rows.map((r) => r.migration_name), ["reiblast_init"]);
    assert.equal((await db.query(`SELECT * FROM "JobRun"`)).rows.length, 1);
    await db.exec(cleanup); // idempotent
    console.log("ok A: partial 0002 cleaned, REIblast untouched, re-run is a no-op");
  }
  // B: 0002 rolled back entirely (only 0001 present). Nothing from 0002, cleanup still fine.
  {
    const db = await reiblast({ applyYummy: false });
    await db.exec(m1);
    await db.exec(`INSERT INTO _prisma_migrations(id, checksum, migration_name, finished_at) VALUES ('y1','${sha("prisma/migrations/0001_init/migration.sql")}','0001_init', now())`);
    await db.exec(cleanup);
    assert.deepEqual(await names(db, "r"), ["JobRun", "User", "_prisma_migrations"]);
    console.log("ok B: rolled-back 0002 handled");
  }
  // C: a REIblast table named like ours but with other columns -> abort, nothing changes.
  {
    const db = await reiblast();
    await db.exec(`DROP TABLE "LoginToken"; CREATE TABLE "LoginToken" (id text PRIMARY KEY, userId text)`);
    const before = await names(db, "r");
    await assert.rejects(db.exec(cleanup), /LoginToken exists but is not the Yummy table/);
    await db.exec("ROLLBACK"); // an aborted script leaves its transaction open
    assert.deepEqual(await names(db, "r"), before);
    assert.equal((await db.query(`SELECT * FROM _prisma_migrations`)).rows.length, 3);
    console.log("ok C: shape mismatch aborts, nothing dropped");
  }
  // D: too many rows -> abort.
  {
    const db = await reiblast();
    for (let i = 0; i < 11; i++) await db.exec(`INSERT INTO "Business"(id,name,timezone,"ownerEmail","updatedAt") VALUES ('b${i}','n','UTC','o@x.com',now())`);
    await assert.rejects(db.exec(cleanup), /Business has 11 rows/);
    await db.exec("ROLLBACK"); // an aborted script leaves its transaction open
    assert.ok((await names(db, "r")).includes("PlaidItem"));
    console.log("ok D: row-count guard aborts");
  }
  // E: shared enum (REIblast column uses a Yummy-named enum with identical labels) -> abort.
  {
    const db = await reiblast();
    await db.exec(`CREATE TABLE "Other2" (id text, s "SnapshotStatus")`);
    await assert.rejects(db.exec(cleanup), /enum public.SnapshotStatus is used by 1 column/);
    await db.exec("ROLLBACK"); // an aborted script leaves its transaction open
    console.log("ok E: shared enum aborts");
  }
  // F: foreign checksum on a same-named migration row -> abort.
  {
    const db = await reiblast();
    await db.exec(`UPDATE _prisma_migrations SET checksum='deadbeef' WHERE migration_name='0001_init'`);
    await assert.rejects(db.exec(cleanup), /checksum that is not Yummy/);
    await db.exec("ROLLBACK"); // an aborted script leaves its transaction open
    console.log("ok F: foreign checksum aborts");
  }
  // G: the cleanup never mentions JobRun in executable SQL; inspect is read-only.
  const exec = cleanup.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.ok(!/JobRun/.test(exec), "cleanup SQL must not reference JobRun");
  assert.ok(!/AuditLog/.test(exec), "cleanup SQL must not reference AuditLog");
  assert.ok(!/CASCADE/i.test(exec), "no CASCADE");
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(inspect.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n").replace(/ARRAY\[[^\]]*\]/g, "")), "inspect has no writes");
  console.log("ok G: static checks");
}
main().catch((e) => { console.error(e); process.exit(1); });
