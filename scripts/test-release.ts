import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { PrismaClient } from "../src/generated/prisma/client";
import { rulesReadinessCheck } from "../src/lib/preflight-env";
import { applyCategoryChanges } from "../src/lib/rules/category-store";
import { BACKFILL_ACTION, ClassificationPendingError, backfillCompletedAt, classificationReady, markBackfillComplete, requireClassification } from "../src/lib/rules/readiness";
import { releaseSummary, runRulesRelease, type ReleaseDeps } from "../src/lib/rules/release";
import { summarize, type SummaryRow } from "../src/lib/rules/summary";

const zeroApply = { considered: 10, changed: 0, unchanged: 10, skippedManual: 0, skippedLocked: 0, needsReview: 3, window: null, legacyCleared: 0 };
const rows: SummaryRow[] = [
  { date: "2026-05-01", amountCents: 10000, kind: "EXPENSE", status: "AUTO", categoryName: "Supplies" },
  { date: "2026-05-02", amountCents: 20000, kind: "EXPENSE", status: "AUTO_UNCONFIRMED", categoryName: "Rent" },
  { date: "2026-05-03", amountCents: 10000, kind: null, status: "NEEDS_REVIEW", categoryName: null },
  { date: "2026-06-03", amountCents: -5000, kind: "OTHER_INFLOW", status: "NEEDS_REVIEW", categoryName: null },
  { date: "2026-06-04", amountCents: 40000, kind: "OWNER_DRAW", status: "AUTO", categoryName: null },
];

function deps(log: string[], over: Partial<ReleaseDeps> = {}): ReleaseDeps {
  return {
    applyCategoryChanges: async () => { log.push("categories"); return { renamed: 0, added: 0 }; },
    seedTemplate: async () => { log.push("template"); return { groups: 0, created: 0, adopted: 0, unchanged: 37, legacyArchived: 0 }; },
    persistRules: async () => { log.push("persist"); return { created: 0, updated: 0, unchanged: 57, total: 57 }; },
    applyMapping: async () => { log.push("mapping"); return { rulesMoved: 0, manualMoved: 0, manualSkippedLocked: 0 }; },
    applyRules: async () => { log.push("apply"); return zeroApply; },
    loadSummaryRows: async () => { log.push("summary"); return rows; },
    markComplete: async () => { log.push("marker"); },
    ...over,
  };
}

// every leaf of a result must be a number or boolean: counts only, no descriptors, ids or tokens
function onlyCounts(v: unknown, path = "result"): void {
  if (typeof v === "number" || typeof v === "boolean") return;
  assert.ok(v && typeof v === "object", `${path} is not a count: ${typeof v}`);
  for (const [k, x] of Object.entries(v)) onlyCounts(x, `${path}.${k}`);
}

async function main() {
  // ===== release: order, counts, idempotence =====
  {
    const log: string[] = [];
    const first = await runRulesRelease(deps(log, {
      applyCategoryChanges: async () => { log.push("categories"); return { renamed: 1, added: 1 }; },
      persistRules: async () => { log.push("persist"); return { created: 57, updated: 0, unchanged: 0, total: 57 }; },
      applyRules: async () => { log.push("apply"); return { ...zeroApply, changed: 10, unchanged: 0, legacyCleared: 2 }; },
    }));
    assert.deepEqual(log, ["categories", "template", "persist", "mapping", "apply", "summary", "marker"], "the one safe order: seed and mapping back to back, marker last");
    assert.equal(first.alreadyUpToDate, false);
    assert.deepEqual(first.categories, { renamed: 1, added: 1 });
    assert.deepEqual(first.rules, { created: 57, updated: 0, unchanged: 0, total: 57 });
    onlyCounts(first);

    const log2: string[] = [];
    const second = await runRulesRelease(deps(log2));
    assert.equal(second.alreadyUpToDate, true, "a second call reports that nothing changed");
    assert.deepEqual([second.categories, second.rules.created, second.rules.updated, second.applied.changed, second.applied.legacyCleared], [{ renamed: 0, added: 0 }, 0, 0, 0, 0]);
    onlyCounts(second);
    // a rules-only change makes it not a no-op
    assert.equal((await runRulesRelease(deps([], { persistRules: async () => ({ created: 0, updated: 1, unchanged: 56, total: 57 }) }))).alreadyUpToDate, false);
    // the template seed and the mapping count as changes too: a release that only seeded or only mapped is not a no-op
    assert.equal((await runRulesRelease(deps([], { seedTemplate: async () => ({ groups: 5, created: 35, adopted: 2, unchanged: 0, legacyArchived: 30 }) }))).alreadyUpToDate, false);
    assert.equal((await runRulesRelease(deps([], { applyMapping: async () => ({ rulesMoved: 3, manualMoved: 0, manualSkippedLocked: 0 }) }))).alreadyUpToDate, false);
    assert.equal((await runRulesRelease(deps([], { applyMapping: async () => ({ rulesMoved: 0, manualMoved: 12, manualSkippedLocked: 0 }) }))).alreadyUpToDate, false);
    // if the template seed fails nothing after it runs and no marker is written (prod never sits half-way)
    const halted: string[] = [];
    await assert.rejects(runRulesRelease(deps(halted, { seedTemplate: async () => { halted.push("template"); throw new Error("boom"); } })), /boom/);
    assert.deepEqual(halted, ["categories", "template"], "stops at the failure: no persist, no mapping, no marker");
    // a mapping failure leaves no marker either
    const halted2: string[] = [];
    await assert.rejects(runRulesRelease(deps(halted2, { applyMapping: async () => { halted2.push("mapping"); throw new Error("no template"); } })), /no template/);
    assert.ok(!halted2.includes("marker") && !halted2.includes("apply"));

    // summary numbers from the stored rows
    const s = summarize(rows, ["2026-05", "2026-06"]);
    assert.deepEqual(releaseSummary(s, 2), {
      months: 2, outflowCount: 4, outflowCents: 80000,
      autoClassifiedPct: 87.5, // 70,000 of 80,000
      pnlClassifiedPct: 75, // 30,000 expense vs 30,000 + 10,000 review
      confirmedPct: 62.5, // AUTO: 10,000 + 40,000 of 80,000
      reviewOutCount: 1, reviewOutCents: 10000, reviewInCount: 1, reviewInCents: 5000,
    });
    assert.equal(first.summary.months, 2);
    assert.equal(first.summary.outflowCount, 4);
  }

  // ===== release: failure stops the sequence; the marker is only written after a successful apply =====
  {
    const log: string[] = [];
    await assert.rejects(runRulesRelease(deps(log, { persistRules: async () => { log.push("persist"); throw new Error('Rule seed:x: category "Nope" does not exist'); } })), /does not exist/);
    assert.deepEqual(log, ["categories", "template", "persist"], "nothing after a failed persist: no apply, no marker");
    const log2: string[] = [];
    await assert.rejects(runRulesRelease(deps(log2, { applyRules: async () => { log2.push("apply"); throw new Error("db down"); } })), /db down/);
    assert.ok(!log2.includes("marker"), "no marker when the apply failed");
    const log3: string[] = [];
    await assert.rejects(runRulesRelease(deps(log3, { applyCategoryChanges: async () => { throw new Error("boom"); } })), /boom/);
    assert.deepEqual(log3, [], "a failure in step 1 runs nothing else");
  }

  // ===== readiness: the guard that keeps unclassified data from being read =====
  {
    const entries: { businessId: string; action: string; createdAt: Date; payload?: unknown; actor?: string }[] = [];
    const client = {
      auditLog: {
        findFirst: async ({ where }: { where: { businessId: string; action: string } }) => { const m = entries.filter((e) => e.businessId === where.businessId && e.action === where.action).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]; return m ? { createdAt: m.createdAt } : null; },
        create: async ({ data }: { data: { businessId: string; action: string; actor: string; payload: unknown } }) => { entries.push({ ...data, createdAt: new Date("2026-10-30T12:00:00Z") }); return data; },
      },
    } as unknown as Pick<PrismaClient, "auditLog">;
    assert.equal(await classificationReady(client, "b1"), false);
    assert.equal(await backfillCompletedAt(client, "b1"), null);
    await assert.rejects(requireClassification(client, "b1"), (e: unknown) => e instanceof ClassificationPendingError && /not been categorized/.test(e.message));
    entries.push({ businessId: "other", action: BACKFILL_ACTION, createdAt: new Date() }); // another business's marker does not count
    entries.push({ businessId: "b1", action: "something_else", createdAt: new Date() });
    assert.equal(await classificationReady(client, "b1"), false, "only this business's backfill marker counts");
    await markBackfillComplete(client, "b1", "test", { rules: 57 });
    assert.equal(await classificationReady(client, "b1"), true);
    await requireClassification(client, "b1"); // no longer throws
    assert.equal(entries.at(-1)?.action, BACKFILL_ACTION);
  }

  // ===== preflight states =====
  {
    assert.equal(rulesReadinessCheck(0, null).status, "warn");
    assert.match(rulesReadinessCheck(0, null).message, /apply-rules/);
    const noBackfill = rulesReadinessCheck(57, null);
    assert.equal(noBackfill.status, "warn");
    assert.match(noBackfill.message, /57 rules stored but the backfill has not run/);
    const ok = rulesReadinessCheck(57, new Date("2026-10-30T12:00:00Z"));
    assert.deepEqual([ok.status, ok.message], ["pass", "57 active rules; backfill completed 2026-10-30"]);
  }

  // ===== the route: auth only (the release itself is exercised on dev) =====
  {
    const route = await import("../src/app/api/admin/apply-rules/route");
    assert.equal((route as Record<string, unknown>).GET, undefined, "POST only");
    process.env.CRON_SECRET = "s".repeat(24);
    const url = "https://app.example.com/api/admin/apply-rules";
    assert.equal((await route.POST(new Request(url, { method: "POST" }))).status, 401);
    assert.equal((await route.POST(new Request(url, { method: "POST", headers: { authorization: "Bearer wrong" } }))).status, 401);
    delete process.env.CRON_SECRET;
    assert.equal((await route.POST(new Request(url, { method: "POST", headers: { authorization: "Bearer x" } }))).status, 500, "unconfigured secret refuses");
  }

  // ===== category changes: idempotent, only the named categories =====
  {
    type Cat = { id: string; businessId: string; name: string; section: string; sortOrder: number; isSystem: boolean };
    const cats: Cat[] = [
      { id: "c1", businessId: "b", name: "Ingredients and dairy", section: "COGS", sortOrder: 2, isSystem: true },
      { id: "c2", businessId: "b", name: "Other COGS", section: "COGS", sortOrder: 4, isSystem: true },
      { id: "c3", businessId: "b", name: "Rent", section: "OPEX", sortOrder: 9, isSystem: true },
      { id: "x1", businessId: "other", name: "Ingredients and dairy", section: "COGS", sortOrder: 2, isSystem: true },
    ];
    let n = 100;
    const client = {
      category: {
        findUnique: async ({ where }: { where: { businessId_name: { businessId: string; name: string } } }) => cats.find((c) => c.businessId === where.businessId_name.businessId && c.name === where.businessId_name.name) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Partial<Cat> }) => { Object.assign(cats.find((c) => c.id === where.id)!, data); },
        findFirst: async ({ where }: { where: { businessId: string; section: string } }) => cats.filter((c) => c.businessId === where.businessId && c.section === where.section).sort((a, b) => b.sortOrder - a.sortOrder)[0] ?? null,
        create: async ({ data }: { data: Omit<Cat, "id"> }) => { cats.push({ id: `c${++n}`, ...data }); },
      },
    } as unknown as Pick<PrismaClient, "category">;
    const first = await applyCategoryChanges(client, "b");
    assert.deepEqual(first, { renamed: 1, added: 1 });
    assert.equal(cats.find((c) => c.id === "c1")!.name, "Dairy & ingredients", "renamed in place (same id, so existing links survive)");
    const candy = cats.find((c) => c.name === "Candy & toppings")!;
    assert.deepEqual([candy.section, candy.sortOrder, candy.businessId], ["COGS", 5, "b"], "appended to its section");
    assert.equal(cats.find((c) => c.id === "x1")!.name, "Ingredients and dairy", "another business is untouched");
    assert.equal(cats.find((c) => c.id === "c3")!.name, "Rent", "unrelated categories untouched");
    assert.deepEqual(await applyCategoryChanges(client, "b"), { renamed: 0, added: 0 }, "idempotent");
    assert.equal(cats.length, 5);
    // when the new name already exists the old row is left alone (no silent merge)
    const both: Cat[] = [
      { id: "o", businessId: "b2", name: "Ingredients and dairy", section: "COGS", sortOrder: 1, isSystem: true },
      { id: "n", businessId: "b2", name: "Dairy & ingredients", section: "COGS", sortOrder: 2, isSystem: true },
    ];
    const c2 = { category: { ...client.category, findUnique: async ({ where }: { where: { businessId_name: { businessId: string; name: string } } }) => both.find((c) => c.businessId === where.businessId_name.businessId && c.name === where.businessId_name.name) ?? null, update: async () => { throw new Error("must not rename"); }, findFirst: async () => null, create: async ({ data }: { data: Omit<Cat, "id"> }) => { both.push({ id: "z", ...data }); } } } as unknown as Pick<PrismaClient, "category">;
    assert.deepEqual(await applyCategoryChanges(c2, "b2"), { renamed: 0, added: 1 });
  }

  // ===== guard: new code that reads transactions must check readiness (or be a known writer of classification) =====
  {
    // the rules engine itself (src/lib/rules/), the sync (which only writes raw rows) and the category mapping (a step OF the rules
    // release: it writes classification, and runs before the "backfill complete" marker exists) are the known accessors
    const allowed = (rel: string) => rel.startsWith("src/lib/rules/") || rel === "src/lib/plaid/sync.ts" || rel === "src/lib/report/mapping-store.ts";
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? (f === "generated" || f === "node_modules" ? [] : walk(p)) : /\.(ts|tsx)$/.test(f) ? [p] : []; });
    const offenders = walk(join(process.cwd(), "src"))
      .map((p) => ({ rel: relative(process.cwd(), p), text: readFileSync(p, "utf8") }))
      .filter(({ rel, text }) => /\bbankTransaction\b/.test(text) && !allowed(rel) && !/requireClassification|classificationReady/.test(text))
      .map(({ rel }) => rel);
    assert.deepEqual(offenders, [], `these files read bank transactions without checking classification readiness (use requireClassification, or add to the allowlist if they only write raw rows or are part of the rules engine): ${offenders.join(", ")}`);
  }

  console.log("release ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
