// Exercises the review service against the real schema on the configured (dev) database, inside a transaction that is
// ALWAYS rolled back: classify with "Always", undo, a refused CHECK rule, and every read the screens use.
// Refuses unless PLAID_ENV=sandbox and DIRECT_URL is the allowlisted dev endpoint. Usage: npm run rehearse:review
import "dotenv/config";
import { createHash } from "node:crypto";
import { checkGuard } from "../src/lib/predeploy-guard";
import { db } from "../src/lib/db";
import { prismaClassifyStore } from "../src/lib/review/prisma-store";
import { loadAccounts, loadCategories, loadPeople, loadRuleViews, loadTxnViews, reviewBadgeCount } from "../src/lib/review/queries";
import { classifyManually, undoLast } from "../src/lib/review/service";
import { queueSince, reviewQueue } from "../src/lib/review/view";
import { currentMonth } from "../src/lib/dates";
import { requireClassification } from "../src/lib/rules/readiness";

const ROLLBACK = "rehearsal-rollback";
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); console.log(`ok  ${msg}`); };

async function main() {
  if (process.env.PLAID_ENV !== "sandbox") throw new Error("rehearse:review only runs with PLAID_ENV=sandbox (dev)");
  const g = checkGuard({ target: "dev", directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`not the dev database: ${g.reason}`);
  console.log(`DB endpoint: ${g.endpoint}  (everything is rolled back)`);
  const business = await db.business.findFirstOrThrow();

  try {
    await db.$transaction(async (tx) => {
      await requireClassification(tx, business.id);
      const store = prismaClassifyStore(tx, business.id, "rehearsal");
      const fingerprint = async () => {
        const rows = await tx.bankTransaction.findMany({ select: { id: true, kind: true, categoryId: true, categorySource: true, ruleId: true, pairId: true, reviewStatus: true, confirmed: true, normalizedMerchant: true }, orderBy: { id: "asc" } });
        return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
      };

      // reads the screens use
      const views = await loadTxnViews(tx, business.id, { reviewOnly: true });
      const since = queueSince(currentMonth(new Date(), business.timezone));
      const queue = reviewQueue(views, since);
      const [cats, accounts, rules, people, badge] = await Promise.all([loadCategories(tx, business.id), loadAccounts(tx, business.id), loadRuleViews(tx, business.id), loadPeople(tx, business.id), reviewBadgeCount(tx, business.id, since)]);
      console.log(`queue ${queue.length} items, badge ${badge}, ${cats.length} categories, ${accounts.length} accounts, ${rules.length} rules, ${people.to.length}+${people.from.length} people`);
      must(badge === queue.length, "badge count equals the review queue");

      const supplies = cats.find((c) => c.key === "materials-and-supplies")!;
      // the review queue may be empty (a finished review): any editable, non-MANUAL transaction works for a rehearsal
      const everything = queue.length ? [] : await loadTxnViews(tx, business.id, { month: since.slice(0, 4) + "-" + currentMonth(new Date(), business.timezone).slice(5) });
      const pool = [...queue, ...everything].filter((t) => !t.locked && t.categorySource !== "MANUAL");
      const target = pool.find((t) => t.direction === "out" && !t.isCheck);
      if (!target) throw new Error("no editable non-check outflow to rehearse with");
      const check = pool.find((t) => t.isCheck);

      const before = await fingerprint();
      const res = await classifyManually(store, { txnId: target.id, value: `cat:${supplies.id}`, always: true });
      must(res.ok, "classify with Always succeeds");
      if (res.ok) console.log(`    rule saved: ${res.rulesSaved}, other rows changed: ${res.reapplied?.changed}, skipped manual ${res.reapplied?.skippedManual}, skipped locked ${res.reapplied?.skippedLocked}`);
      const row = await tx.bankTransaction.findUniqueOrThrow({ where: { id: target.id } });
      must(row.categorySource === "MANUAL" && row.reviewStatus === "REVIEWED" && row.categoryId === supplies.id, "the clicked row is MANUAL / REVIEWED / Supplies");
      const audit = await tx.auditLog.findFirst({ where: { businessId: business.id, action: "txn.classify" }, orderBy: { createdAt: "desc" } });
      const ruleKey = ((audit?.payload as { rules?: { key: string }[] } | null)?.rules ?? [])[0]?.key; // "user:always:…" or "zelle:…" for a Zelle row
      const rule = ruleKey ? await tx.rule.findUnique({ where: { businessId_key: { businessId: business.id, key: ruleKey } } }) : null;
      must(rule?.confirmed && rule.active && rule.source === "USER", `a confirmed, active USER rule was created (${ruleKey})`);
      must(audit?.actor === "rehearsal", "the change is in the audit log with its actor");
      must((await fingerprint()) !== before, "classification changed");

      const undone = await undoLast(store);
      must(undone.ok, "undo succeeds");
      must((await fingerprint()) === before, "undo restored every classification column of every row exactly");

      if (check) {
        const refused = await classifyManually(store, { txnId: check.id, value: `cat:${cats.find((c) => c.key === "wages")!.id}`, always: true });
        must(!refused.ok && /Checks have no payee/.test(refused.error), "a CHECK row can't create a rule");
      } else console.log("skip (no CHECK row in the review queue)");

      throw new Error(ROLLBACK);
    }, { timeout: 300_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back: dev is unchanged");
  }
}

main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
