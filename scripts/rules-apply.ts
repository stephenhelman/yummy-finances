// Usage: npm run rules:apply [-- --rehearse]
// Applies the persisted rules (normalizer + pair matcher + rules) to ALL posted, live transactions on included
// accounts in the configured database, then prints the same summary as the dry run and checks that what is
// STORED equals a fresh in-memory classification (the dry-run result) row by row.
//   --rehearse   does everything inside a transaction that is ALWAYS rolled back: nothing is stored.
// Never overwrites manual categorizations; never touches locked months. Safe to re-run (idempotent).
import "dotenv/config";
import { db } from "../src/lib/db";
import { applyRules, type StoredTxn } from "../src/lib/rules/apply";
import { classify } from "../src/lib/rules/engine";
import { ALL_RULES } from "../src/lib/rules/all";
import { mapDef } from "../src/lib/report/mapping";
import { prismaRulesStore } from "../src/lib/rules/prisma-store";
import { markBackfillComplete } from "../src/lib/rules/readiness";
import { summarize, summaryLines, type SummaryRow } from "../src/lib/rules/summary";

const ROLLBACK = "rehearsal-rollback";
type Client = Parameters<typeof prismaRulesStore>[0];

async function run(client: Client, businessId: string, rehearse: boolean) {
  const store = prismaRulesStore(client, businessId);
  const result = await applyRules(store, { all: true });
  console.log(`\napplyRules (${rehearse ? "REHEARSAL, will be rolled back" : "stored"}): considered ${result.considered}, changed ${result.changed}, unchanged ${result.unchanged}, skipped manual ${result.skippedManual}, skipped locked ${result.skippedLocked}, still needing review ${result.needsReview}, legacy default kinds cleared ${result.legacyCleared}`);

  // second pass: idempotence
  const again = await applyRules(store, { all: true });
  console.log(`second run: changed ${again.changed} (must be 0)${again.changed === 0 ? "" : "  <-- NOT IDEMPOTENT"}`);

  // what is stored now
  const [{ categoryIdByName, rules }, stored] = await Promise.all([store.loadRules(), store.loadTransactions(null)]);
  const nameById = new Map([...categoryIdByName].map(([n, id]) => [id, n]));
  const storedStatus = (t: StoredTxn): SummaryRow["status"] => (t.reviewStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : t.confirmed ? "AUTO" : "AUTO_UNCONFIRMED");
  const rows: SummaryRow[] = stored.map((t) => ({ date: t.date, amountCents: t.amountCents, kind: t.kind, status: storedStatus(t), categoryName: t.categoryId ? nameById.get(t.categoryId) ?? null : null }));
  console.log(`\nStored results (${stored.length} transactions, ${rules.length} active rules):`);
  for (const line of summaryLines(summarize(rows))) console.log("  " + line);

  // stored vs a fresh classification with the rules defined in code (this is the dry-run result)
  const fresh = new Map(classify(stored.filter((t) => t.categorySource !== "MANUAL").map((t) => ({ id: t.id, date: t.date, amountCents: t.amountCents, raw: t.raw, pfcPrimary: t.pfcPrimary, pfcDetailed: t.pfcDetailed, account: t.account })), ALL_RULES.map(mapDef)).map((d) => [d.txnId, d]));
  const diffs: string[] = [];
  let compared = 0;
  for (const t of stored) {
    const d = fresh.get(t.id);
    if (!d) continue;
    compared++;
    const wantSource = d.via === "pair" ? "PAIR" : d.via === "default" ? "NONE" : "RULE";
    const wantPair = d.via === "pair" && d.pairedWith ? [t.id, d.pairedWith].sort()[0] : null;
    const got = [t.kind, t.categoryId ? nameById.get(t.categoryId) ?? null : null, storedStatus(t), t.categorySource, t.pairId];
    const want = [d.kind, d.categoryName, d.status, wantSource, wantPair];
    if (JSON.stringify(got) !== JSON.stringify(want)) diffs.push(`${t.date} ${t.raw.slice(0, 40)}: stored ${JSON.stringify(got)} vs dry-run ${JSON.stringify(want)}`);
  }
  console.log(`\nStored vs dry-run: compared ${compared} rows, ${diffs.length} differences${diffs.length ? "  <-- MISMATCH" : ""}`);
  for (const d of diffs.slice(0, 10)) console.log("  " + d);
  if (diffs.length || again.changed) process.exitCode = 1;
}

async function main() {
  const rehearse = process.argv.includes("--rehearse");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}${rehearse ? "  (rehearsal: nothing is stored)" : ""}`);
  const business = await db.business.findFirstOrThrow();
  if (!rehearse) {
    await run(db, business.id, false);
    if (!process.exitCode) {
      await markBackfillComplete(db, business.id, "rules-apply-script", { script: 1 });
      console.log("\nbackfill marker written: classification is now marked ready for this database");
    }
    return;
  }
  try {
    await db.$transaction(async (tx) => {
      await run(tx, business.id, true);
      throw new Error(ROLLBACK);
    }, { timeout: 300_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back: nothing was stored");
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
