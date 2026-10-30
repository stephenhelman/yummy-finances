// Rehearses the FIRST production rules release against the configured (dev) database, inside a transaction that is
// ALWAYS rolled back. It first resets the database to what prod looks like right after `migrate deploy`: no rules, the
// old category name, no classification, legacy default kinds, no backfill marker. Then it runs the release twice.
// Refuses unless PLAID_ENV=sandbox (the dev signature). Usage: npm run rehearse:release
import "dotenv/config";
import { db } from "../src/lib/db";
import { prismaReleaseDeps, runRulesRelease } from "../src/lib/rules/release";

const ROLLBACK = "rehearsal-rollback";

async function main() {
  if (process.env.PLAID_ENV !== "sandbox") throw new Error("rehearse:release only runs with PLAID_ENV=sandbox (dev)");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}  (everything is rolled back)`);
  const business = await db.business.findFirstOrThrow();
  try {
    await db.$transaction(async (tx) => {
      // ---- put the database into the "just migrated" state
      await tx.$executeRawUnsafe(`UPDATE "BankTransaction" SET "kind" = NULL, "categoryId" = NULL, "categorySource" = 'NONE', "ruleId" = NULL, "pairId" = NULL, "reviewStatus" = 'NEEDS_REVIEW', "confirmed" = false, "normalizedMerchant" = NULL`);
      await tx.$executeRawUnsafe(`UPDATE "BankTransaction" SET "kind" = 'EXPENSE' WHERE "pending" = true OR "removedAt" IS NOT NULL OR "supersededAt" IS NOT NULL`); // the migration's leftover default
      await tx.$executeRawUnsafe(`DELETE FROM "Rule"`);
      await tx.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "action" = 'rules_backfill'`);
      await tx.$executeRawUnsafe(`DELETE FROM "Category" WHERE "name" = 'Candy & toppings'`);
      await tx.$executeRawUnsafe(`UPDATE "Category" SET "name" = 'Ingredients and dairy' WHERE "name" = 'Dairy & ingredients'`);
      const [pre] = await tx.$queryRaw<{ rules: bigint; classified: bigint; legacy: bigint }[]>`SELECT (SELECT count(*) FROM "Rule") rules, (SELECT count(*) FROM "BankTransaction" WHERE "categorySource" <> 'NONE') classified, (SELECT count(*) FROM "BankTransaction" WHERE "kind" IS NOT NULL) legacy`;
      console.log(`starting state: rules ${pre.rules}, classified rows ${pre.classified}, rows with a leftover kind ${pre.legacy}`);

      const first = await runRulesRelease(prismaReleaseDeps(tx, business.id, "rehearsal"));
      console.log("\nRELEASE 1:", JSON.stringify(first));
      const second = await runRulesRelease(prismaReleaseDeps(tx, business.id, "rehearsal"));
      console.log("\nRELEASE 2 (must change nothing):", JSON.stringify(second));
      console.log(`\nsecond call is a no-op: ${second.alreadyUpToDate ? "YES" : "NO  <-- NOT IDEMPOTENT"}`);
      if (!second.alreadyUpToDate) process.exitCode = 1;
      throw new Error(ROLLBACK);
    }, { timeout: 600_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back: dev is unchanged");
  }
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
