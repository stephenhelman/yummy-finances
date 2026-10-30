import type { PrismaClient } from "@/generated/prisma/client";
import { applyRules, type ApplyResult, type StoredTxn } from "@/lib/rules/apply";
import { ALL_RULES } from "@/lib/rules/all";
import { applyCategoryChanges, type CategoryChangeResult } from "@/lib/rules/category-store";
import { persistRules, prismaRulesStore, type PersistResult } from "@/lib/rules/prisma-store";
import { markBackfillComplete } from "@/lib/rules/readiness";
import { summarize, type Summary, type SummaryRow } from "@/lib/rules/summary";

// The "rules release": everything needed to bring a database up to the current rules, in the one safe order:
//   1. planned category changes (rename / addition)       idempotent, touches only the categories named in categories.ts
//   2. persist the code-defined rules                     never un-confirms or re-enables an existing rule
//   3. apply the rules to every transaction               never overwrites manual rows, never touches locked months
//   4. write the "backfill complete" marker               only after 1-3 succeeded
// Safe to run any number of times. Returns counts only (no descriptors, no ids).

export type ReleaseDeps = {
  applyCategoryChanges(): Promise<CategoryChangeResult>;
  persistRules(): Promise<PersistResult & { total: number }>;
  applyRules(): Promise<ApplyResult>;
  loadSummaryRows(): Promise<SummaryRow[]>;
  markComplete(counts: Record<string, number>): Promise<void>;
};

export type ReleaseResult = {
  categories: CategoryChangeResult;
  rules: PersistResult & { total: number };
  applied: Pick<ApplyResult, "considered" | "changed" | "unchanged" | "skippedManual" | "skippedLocked" | "needsReview" | "legacyCleared">;
  summary: {
    months: number;
    outflowCount: number;
    outflowCents: number;
    autoClassifiedPct: number;
    pnlClassifiedPct: number;
    confirmedPct: number;
    reviewOutCount: number;
    reviewOutCents: number;
    reviewInCount: number;
    reviewInCents: number;
  };
  /** Nothing changed anywhere: this run was a no-op (what a second call should report). */
  alreadyUpToDate: boolean;
};

const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);

export function releaseSummary(s: Summary, months: number): ReleaseResult["summary"] {
  return {
    months,
    outflowCount: s.outflowCount,
    outflowCents: s.outflowCents,
    autoClassifiedPct: pct(s.outflowCents - s.reviewOutCents, s.outflowCents),
    pnlClassifiedPct: pct(s.expenseCents, s.expenseCents + s.reviewOutCents),
    confirmedPct: pct(s.confirmedAutoCents, s.outflowCents),
    reviewOutCount: s.reviewOutCount,
    reviewOutCents: s.reviewOutCents,
    reviewInCount: s.reviewInCount,
    reviewInCents: s.reviewInCents,
  };
}

export async function runRulesRelease(deps: ReleaseDeps): Promise<ReleaseResult> {
  const categories = await deps.applyCategoryChanges();
  const rules = await deps.persistRules();
  const applied = await deps.applyRules();
  const rows = await deps.loadSummaryRows();
  const months = [...new Set(rows.map((r) => r.date.slice(0, 7)))];
  const result: ReleaseResult = {
    categories,
    rules,
    applied: {
      considered: applied.considered, changed: applied.changed, unchanged: applied.unchanged, skippedManual: applied.skippedManual,
      skippedLocked: applied.skippedLocked, needsReview: applied.needsReview, legacyCleared: applied.legacyCleared,
    },
    summary: releaseSummary(summarize(rows, months), months.length),
    alreadyUpToDate: categories.renamed + categories.added + rules.created + rules.updated + applied.changed + applied.legacyCleared === 0,
  };
  await deps.markComplete({ rules: rules.total, changed: applied.changed, considered: applied.considered });
  return result;
}

type ReleaseClient = Pick<PrismaClient, "rule" | "category" | "bankTransaction" | "monthSnapshot" | "auditLog">;

/** Rows as the summary wants them, from what is STORED. */
export async function storedSummaryRows(client: Pick<PrismaClient, "rule" | "category" | "bankTransaction" | "monthSnapshot">, businessId: string): Promise<SummaryRow[]> {
  const store = prismaRulesStore(client, businessId);
  const [{ categoryIdByName }, stored] = await Promise.all([store.loadRules(), store.loadTransactions(null)]);
  const nameById = new Map([...categoryIdByName].map(([n, id]) => [id, n]));
  const status = (t: StoredTxn): SummaryRow["status"] => (t.reviewStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : t.confirmed ? "AUTO" : "AUTO_UNCONFIRMED");
  return stored.map((t) => ({ date: t.date, amountCents: t.amountCents, kind: t.kind, status: status(t), categoryName: t.categoryId ? nameById.get(t.categoryId) ?? null : null }));
}

export function prismaReleaseDeps(client: ReleaseClient, businessId: string, actor = "rules-release"): ReleaseDeps {
  return {
    applyCategoryChanges: () => applyCategoryChanges(client, businessId),
    persistRules: async () => ({ ...(await persistRules(client, businessId, ALL_RULES)), total: ALL_RULES.length }),
    applyRules: () => applyRules(prismaRulesStore(client, businessId), { all: true }),
    loadSummaryRows: () => storedSummaryRows(client, businessId),
    markComplete: (counts) => markBackfillComplete(client, businessId, actor, counts),
  };
}
