// Rehearses the category release (template seed + mapping + rules + apply) against the configured (dev) database inside a
// transaction that is ALWAYS rolled back. It first rewinds dev to what PRODUCTION looks like right after `db:deploy` and before
// the release (no template, legacy categories live), adds a locked month, then runs the release twice. Refuses unless DIRECT_URL
// is the allowlisted dev endpoint. Usage: npm run rehearse:category-release
import "dotenv/config";
import { checkGuard } from "../src/lib/predeploy-guard";
import { db } from "../src/lib/db";
import { prismaReleaseDeps, runRulesRelease } from "../src/lib/rules/release";

const ROLLBACK = "rehearsal-rollback";
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); console.log(`ok  ${msg}`); };

async function main() {
  const g = checkGuard({ target: "dev", directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`not the dev database: ${g.reason}`);
  console.log(`DB endpoint: ${g.endpoint}  (everything is rolled back)`);
  const business = await db.business.findFirstOrThrow();

  try {
    await db.$transaction(async (tx) => {
      // ---- rewind to prod's state after db:deploy, before the release
      await tx.$executeRawUnsafe(`UPDATE "Category" SET "archived" = false, "showWhenZero" = true, "groupId" = NULL, "quickPickOrder" = NULL WHERE "key" IS NULL`);
      await tx.$executeRawUnsafe(`UPDATE "Category" SET "key" = NULL, "groupId" = NULL, "quickPickOrder" = NULL WHERE "name" IN ('Rent', 'Utilities')`);
      await tx.$executeRawUnsafe(`DELETE FROM "Category" WHERE "key" IS NOT NULL`);
      await tx.$executeRawUnsafe(`DELETE FROM "CategoryGroup"`);
      // a locked month: its rows must not move
      await tx.$executeRawUnsafe(`INSERT INTO "MonthSnapshot"("id","businessId","month","status","dataJson","inputsHash","lockedAt","updatedAt") VALUES ('rehearsal-lock','${business.id}','2026-01','LOCKED','{}','x',now(),now())`);

      const snapshot = async () => {
        const [m] = await tx.$queryRaw<{ ids: string }[]>`SELECT string_agg("id", ',' ORDER BY "id") ids FROM "BankTransaction" WHERE "categorySource" = 'MANUAL'`;
        const [e] = await tx.$queryRaw<{ cents: bigint }[]>`SELECT COALESCE(sum("amountCents"),0) cents FROM "BankTransaction" WHERE "kind" IN ('EXPENSE','VENDOR_REFUND') AND "date" >= '2026-02-01'`;
        const [l] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "BankTransaction" WHERE "date" < '2026-02-01' AND "date" >= '2026-01-01'`;
        const [jan] = await tx.$queryRaw<{ h: string }[]>`SELECT md5(string_agg("id" || coalesce("categoryId",'-') || coalesce("kind"::text,'-') || "categorySource"::text, ',' ORDER BY "id")) h FROM "BankTransaction" WHERE "date" >= '2026-01-01' AND "date" < '2026-02-01'`;
        return { manual: m.ids, expenseCents: Number(e.cents), janRows: Number(l.n), janHash: jan.h };
      };
      const before = await snapshot();
      console.log(`before: ${before.manual.split(",").length} MANUAL rows, ${before.janRows} rows in the locked month`);

      const first = await runRulesRelease(prismaReleaseDeps(tx, business.id, "rehearsal"));
      console.log("\nRELEASE 1:", JSON.stringify({ template: first.template, mapping: first.mapping, rules: first.rules, applied: first.applied }));
      const second = await runRulesRelease(prismaReleaseDeps(tx, business.id, "rehearsal"));
      console.log("RELEASE 2:", JSON.stringify({ template: second.template, mapping: second.mapping, rules: second.rules, applied: second.applied }));
      must(second.alreadyUpToDate, "a second release changes nothing (idempotent)");
      must(first.template.legacyArchived > 0 && first.template.created > 0, "the first release seeded the template and archived the legacy categories");
      must(first.mapping.rulesMoved > 0 && first.mapping.manualMoved > 0, "the first release moved rules and manual picks");

      const after = await snapshot();
      must(after.manual === before.manual, "every MANUAL pick is still MANUAL (same set of rows)");
      must(after.expenseCents === before.expenseCents, "total expense dollars outside the locked month are unchanged (only the lines moved)");
      must(after.janHash === before.janHash, "the locked month's rows are byte-for-byte untouched");
      must(first.mapping.manualSkippedLocked >= 0, `manual rows skipped for the locked month: ${first.mapping.manualSkippedLocked}`);

      const [r1] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "Rule" r JOIN "Category" c ON c."id" = r."categoryId" WHERE c."key" IS NULL AND c."archived" AND r."active"`;
      must(Number(r1.n) === 0, "no active rule still points at a legacy category");
      const [r2] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "BankTransaction" t JOIN "Category" c ON c."id" = t."categoryId" WHERE c."key" IS NULL AND c."archived" AND t."date" >= '2026-02-01'`;
      must(Number(r2.n) === 0, "no transaction outside the locked month still sits on a legacy category");
      const [r3] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "BankTransaction" WHERE "categorySource" = 'MANUAL' AND "categoryId" IS NULL AND "kind" IN ('OWNER_DRAW','OWNER_CONTRIBUTION') AND NOT ("date" >= '2026-01-01' AND "date" < '2026-02-01')`;
      must(Number(r3.n) === 0, "every Personal pick outside the locked month now has the Personal: Misc category");
      const [r4] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "Category" WHERE "quickPickOrder" IS NOT NULL`;
      must(Number(r4.n) === 5, "the five default quick picks exist");
      const [r5] = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) n FROM "AuditLog" WHERE "action" = 'rules_backfill' AND "actor" = 'rehearsal' AND "payload"->>'rulesMoved' IS NOT NULL`;
      must(Number(r5.n) === 2, "each release leaves its counts in the audit log");
      throw new Error(ROLLBACK);
    }, { timeout: 600_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back: dev is unchanged");
  }
}
main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
