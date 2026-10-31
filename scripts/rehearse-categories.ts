// Exercises the category admin operations against the real schema on the configured (dev) database, inside a transaction that
// is ALWAYS rolled back. Refuses unless DIRECT_URL is the allowlisted dev endpoint. Usage: npm run rehearse:categories
import "dotenv/config";
import { checkGuard } from "../src/lib/predeploy-guard";
import { db } from "../src/lib/db";
import { addCategory, addGroup, archiveCategory, mergeCategories, previewMerge, renameCategory, reorderCategory, reorderGroup, restoreCategory, setQuickPick, setShowWhenZero, moveToGroup } from "../src/lib/review/category-admin";
import { loadCategories, loadCategoryStats, loadGroups } from "../src/lib/review/queries";
import { loadReport } from "../src/lib/report/load";

const ROLLBACK = "rehearsal-rollback";
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); console.log(`ok  ${msg}`); };

async function main() {
  const g = checkGuard({ target: "dev", directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`not the dev database: ${g.reason}`);
  console.log(`DB endpoint: ${g.endpoint}  (everything is rolled back)`);
  const business = await db.business.findFirstOrThrow();
  const b = business.id, who = "rehearsal";

  try {
    await db.$transaction(async (tx) => {
      const cats = await loadCategories(tx, b);
      const groups = await loadGroups(tx, b);
      console.log(`${cats.filter((c) => !c.archived).length} active categories, ${cats.filter((c) => c.archived).length} archived, ${groups.length} groups`);
      const sales = groups.find((x) => x.name === "Sales/Food")!;
      must(cats.find((c) => c.key === "wages")?.quickPickOrder === 2 && cats.find((c) => c.key === "personal-misc")?.quickPickOrder === 1, "default quick picks are seeded");

      // add / duplicate / rename
      const added = await addCategory(tx, b, who, { name: "Ice Machine", treatment: "PNL_EXPENSE", nonPlKind: null, groupId: sales.id });
      must(added.ok, "add a category");
      const added2 = await addCategory(tx, b, who, { name: "Ice Machine Parts", treatment: "PNL_EXPENSE", nonPlKind: null, groupId: sales.id });
      if (!added.ok || !added2.ok) throw new Error("add failed");
      must(!(await addCategory(tx, b, who, { name: "ice machine", treatment: "PNL_EXPENSE", nonPlKind: null, groupId: null })).ok, "duplicate names are refused");
      must((await renameCategory(tx, b, who, added2.id, "Ice Parts")).ok, "rename");
      must(!(await renameCategory(tx, b, who, added2.id, "Rent")).ok, "rename onto an existing name is refused");

      // reorder within the group
      const order = async () => (await loadCategories(tx, b)).filter((c) => c.groupName === "Sales/Food" && !c.archived).sort((p, q) => p.sortOrder - q.sortOrder).map((c) => c.name);
      const before = await order();
      must((await reorderCategory(tx, b, who, added2.id, "up")).ok, "reorder up");
      const after = await order();
      must(after.indexOf("Ice Parts") === before.indexOf("Ice Parts") - 1 && new Set((await loadCategories(tx, b)).filter((c) => c.groupName === "Sales/Food").map((c) => c.sortOrder)).size === after.length, "moved up one place, sort orders still distinct");

      // show-when-zero and a zero line really disappears from the report
      must((await setShowWhenZero(tx, b, who, added.id, false)).ok, "hide when zero");

      // move group / group reorder
      must((await moveToGroup(tx, b, who, added.id, null)).ok, "move to top level (an expense may be top-level)");
      must(!(await moveToGroup(tx, b, who, cats.find((c) => c.key === "payments")!.id, null)).ok, "a Not-in-P&L line can't leave its group");
      must((await moveToGroup(tx, b, who, added.id, sales.id)).ok, "move back into a group");
      must((await addGroup(tx, b, who, "Seasonal")).ok && !(await addGroup(tx, b, who, "seasonal")).ok, "add a group, duplicate refused");
      const gs = await loadGroups(tx, b);
      must((await reorderGroup(tx, b, who, gs.find((x) => x.name === "Seasonal")!.id, "up")).ok, "reorder a group");

      // quick picks
      const picks = async () => (await loadCategories(tx, b)).filter((c) => c.quickPickOrder !== null).sort((p, q) => p.quickPickOrder! - q.quickPickOrder!).map((c) => c.key ?? c.name);
      must((await setQuickPick(tx, b, who, added.id, "add")).ok && (await picks()).at(-1) === "Ice Machine", "add a quick pick (end of the list)");
      must(!(await setQuickPick(tx, b, who, added2.id, "add")).ok === ((await picks()).length >= 6), "limit of 6");
      must((await setQuickPick(tx, b, who, added.id, "remove")).ok && !(await picks()).includes("Ice Machine"), "remove a quick pick");

      // archive: unused ok, used refused, keyed refused
      must((await archiveCategory(tx, b, who, added.id)).ok, "archive an unused category");
      must((await restoreCategory(tx, b, who, added.id)).ok, "restore it");
      const used = [...(await loadCategoryStats(tx, b, "2026"))].filter(([, s]) => s.count > 0).map(([id]) => id);
      const usedCat = (await loadCategories(tx, b)).find((c) => used.includes(c.id) && !c.key)!;
      if (usedCat) must(!(await archiveCategory(tx, b, who, usedCat.id)).ok, `a category in use ("${usedCat.name}") can't be archived`);
      must(!(await archiveCategory(tx, b, who, cats.find((c) => c.key === "rent")!.id)).ok, "a keyed template line can't be archived");

      // merge: pick a used legacy category into a same-treatment active one
      const legacy = (await loadCategories(tx, b)).filter((c) => c.archived && c.treatment === "PNL_EXPENSE" && used.includes(c.id));
      if (legacy.length) {
        const from = legacy[0];
        const target = cats.find((c) => c.key === "purchase")!;
        const prev = await previewMerge(tx, b, from.id, target.id);
        if (!prev.ok) throw new Error(prev.error);
        console.log(`    merge "${from.name}" -> Purchase: ${prev.plan.transactionsOpen} open, ${prev.plan.transactionsLocked} locked, ${prev.plan.rules} rules`);
        const locked = await tx.monthSnapshot.count({ where: { businessId: b, status: "LOCKED" } });
        const merged = await mergeCategories(tx, b, who, from.id, target.id);
        must(merged.ok, "merge succeeds");
        const left = await tx.bankTransaction.count({ where: { businessId: b, categoryId: from.id } });
        must(left === prev.plan.transactionsLocked, "only rows in locked months stay behind");
        must((await tx.rule.count({ where: { businessId: b, categoryId: from.id } })) === 0, "its rules moved");
        must((await tx.monthSnapshot.count({ where: { businessId: b, status: "LOCKED" } })) === locked, "locked snapshots untouched");
      } else console.log("skip merge (no used legacy expense category)");
      must(!(await previewMerge(tx, b, cats.find((c) => c.key === "rent")!.id, cats.find((c) => c.key === "personal-misc")!.id)).ok, "merging across treatments is refused");

      // every action above is audited
      const audits = await tx.auditLog.count({ where: { businessId: b, actor: who, action: { startsWith: "category." } } });
      must(audits >= 10, `category changes are audited (${audits} entries)`);

      // the report still builds from this data
      const rep = await loadReport(business, "2026-09");
      must(rep.report.expenses.groups.length > 0, `report builds (${rep.status}, ${rep.source}, net ${rep.report.netIncomeCents})`);
      throw new Error(ROLLBACK);
    }, { timeout: 300_000, maxWait: 30_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
    console.log("\nrolled back: dev is unchanged");
  }
}
main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
