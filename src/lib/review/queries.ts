import type { PrismaClient } from "@/generated/prisma/client";
import { KINDS, type Kind } from "@/lib/rules/types";
import { summarizeRecipients, type RecipientRow, type ZelleItem } from "@/lib/rules/zelle";
import { isFrozen } from "@/lib/rules/apply";
import { requireClassification } from "@/lib/rules/readiness";
import { loadCategoryOptions } from "@/lib/review/prisma-store";
import { viewOf, type TxnView } from "@/lib/review/view";

// Reads for the review screens. Every read of classification enforces requireClassification itself (see
// src/lib/rules/readiness.ts): it throws ClassificationPendingError until the rules backfill has run.

type Client = Pick<PrismaClient, "bankTransaction" | "category" | "rule" | "monthSnapshot" | "bankAccount" | "auditLog">;

const KIND_SET = new Set<string>(KINDS);
const day = (d: Date) => d.toISOString().slice(0, 10);

export type LoadOpts = { month?: string; reviewOnly?: boolean };

/** Posted transactions on included accounts as display rows. `month` limits to one month; `reviewOnly` to the review queue. */
export async function loadTxnViews(client: Client, businessId: string, opts: LoadOpts = {}): Promise<TxnView[]> {
  await requireClassification(client, businessId);
  const [rows, cats, rules, snaps] = await Promise.all([
    client.bankTransaction.findMany({
      where: {
        businessId, pending: false, removedAt: null, supersededAt: null, account: { included: true },
        ...(opts.reviewOnly ? { reviewStatus: "NEEDS_REVIEW" as const } : {}),
        ...(opts.month ? { date: { gte: new Date(`${opts.month}-01T00:00:00Z`), lt: nextMonthStart(opts.month) } } : {}),
      },
      include: { account: { include: { plaidItem: { select: { institutionName: true } } } } },
      orderBy: [{ date: "desc" }, { id: "asc" }],
    }),
    client.category.findMany({ where: { businessId }, select: { id: true, name: true } }),
    client.rule.findMany({ where: { businessId }, select: { id: true, name: true } }),
    client.monthSnapshot.findMany({ where: { businessId, status: "LOCKED" }, select: { month: true } }),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const ruleName = new Map(rules.map((r) => [r.id, r.name]));
  const locked = new Set(snaps.map((s) => s.month));
  return rows.map((r) =>
    viewOf(
      {
        id: r.id, date: day(r.date), amountCents: r.amountCents, raw: r.rawDescription, normalizedMerchant: r.normalizedMerchant,
        pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed,
        account: { id: r.accountId, institution: r.account.plaidItem.institutionName ?? "Bank", mask: r.account.mask ?? "" },
        kind: r.kind && KIND_SET.has(r.kind) ? (r.kind as Kind) : null, categoryId: r.categoryId, categorySource: r.categorySource,
        reviewStatus: r.reviewStatus, confirmed: r.confirmed, isLate: r.isLate, adjustmentMonth: r.adjustmentMonth,
      },
      { categoryName: (id) => catName.get(id), ruleName: r.ruleId ? ruleName.get(r.ruleId) ?? null : null, locked },
    ),
  );
}

function nextMonthStart(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
}

export async function loadAccounts(client: Client, businessId: string) {
  const rows = await client.bankAccount.findMany({ where: { businessId, included: true }, include: { plaidItem: { select: { institutionName: true } } }, orderBy: { createdAt: "asc" } });
  return rows.map((a) => ({ id: a.id, label: `${a.plaidItem.institutionName ?? "Bank"} ••${a.mask ?? "????"}` }));
}

export async function loadCategories(client: Client, businessId: string) {
  return loadCategoryOptions(client, businessId);
}

// ---- rules screen --------------------------------------------------------------------------------

export type RuleView = {
  id: string;
  key: string;
  name: string;
  pattern: string;
  direction: "IN" | "OUT" | "ANY";
  kind: Kind;
  categoryName: string | null;
  confirmed: boolean;
  active: boolean;
  source: "SEED" | "USER";
  matches: number;
  totalCents: number; // absolute dollars across matches
};

export async function loadRuleViews(client: Client, businessId: string): Promise<RuleView[]> {
  await requireClassification(client, businessId);
  const [rules, cats, agg] = await Promise.all([
    client.rule.findMany({ where: { businessId } }),
    client.category.findMany({ where: { businessId }, select: { id: true, name: true } }),
    // only rows a rule actually classified (a manual row has no ruleId)
    client.bankTransaction.findMany({ where: { businessId, ruleId: { not: null }, removedAt: null, supersededAt: null }, select: { ruleId: true, amountCents: true } }),
  ]);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const stats = new Map<string, { n: number; cents: number }>();
  for (const r of agg) {
    const s = stats.get(r.ruleId!) ?? stats.set(r.ruleId!, { n: 0, cents: 0 }).get(r.ruleId!)!;
    s.n++;
    s.cents += Math.abs(r.amountCents);
  }
  return rules
    .filter((r) => KIND_SET.has(r.kind))
    .map((r) => ({
      id: r.id, key: r.key, name: r.name || r.pattern, pattern: r.pattern, direction: r.direction, kind: r.kind as Kind,
      categoryName: r.categoryId ? catName.get(r.categoryId) ?? null : null, confirmed: r.confirmed, active: r.active, source: r.source,
      matches: stats.get(r.id)?.n ?? 0, totalCents: stats.get(r.id)?.cents ?? 0,
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || b.totalCents - a.totalCents || a.name.localeCompare(b.name));
}

// ---- people --------------------------------------------------------------------------------------

export type PersonLabel = { label: "STAFF" | "FAMILY" | "VENDOR"; categoryName: string | null } | null;
export type PersonView = RecipientRow & { current: PersonLabel };

/** Zelle people, live from the stored transactions, with the label their recipient rule currently gives them. */
export async function loadPeople(client: Client, businessId: string): Promise<{ to: PersonView[]; from: PersonView[] }> {
  await requireClassification(client, businessId);
  const [txns, rules, cats] = await Promise.all([
    client.bankTransaction.findMany({
      where: { businessId, pending: false, removedAt: null, supersededAt: null, account: { included: true }, rawDescription: { contains: "zelle", mode: "insensitive" } },
      select: { date: true, amountCents: true, rawDescription: true, account: { select: { mask: true, plaidItem: { select: { institutionName: true } } } } },
    }),
    client.rule.findMany({ where: { businessId, key: { startsWith: "zelle:" }, active: true } }),
    client.category.findMany({ where: { businessId }, select: { id: true, name: true } }),
  ]);
  const items: ZelleItem[] = txns.map((t) => ({ raw: t.rawDescription, date: day(t.date), cents: t.amountCents, account: `${t.account.plaidItem.institutionName ?? "Bank"} ••${t.account.mask ?? "????"}` }));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const byKey = new Map(rules.map((r) => [r.key, r]));

  const label = (name: string): PersonLabel => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const out = byKey.get(`zelle:${slug}:out`);
    if (!out) return byKey.get(`zelle:${slug}:in`) ? { label: "FAMILY", categoryName: null } : null;
    if (out.kind === "OWNER_DRAW") return { label: "FAMILY", categoryName: null };
    const c = out.categoryId ? catName.get(out.categoryId) ?? null : null;
    return c === "Wages" ? { label: "STAFF", categoryName: c } : { label: "VENDOR", categoryName: c };
  };
  const withLabel = (rows: RecipientRow[]): PersonView[] => rows.map((r) => ({ ...r, current: label(r.name) }));
  return { to: withLabel(summarizeRecipients(items, "to")), from: withLabel(summarizeRecipients(items, "from")) };
}

/** Lean count of rows waiting for review (unlocked months only) for the nav badge. */
export async function reviewBadgeCount(client: Client, businessId: string, sinceMonth?: string): Promise<number> {
  await requireClassification(client, businessId);
  const [rows, snaps] = await Promise.all([
    client.bankTransaction.findMany({
      where: { businessId, pending: false, removedAt: null, supersededAt: null, account: { included: true }, reviewStatus: "NEEDS_REVIEW", ...(sinceMonth ? { date: { gte: new Date(`${sinceMonth}-01T00:00:00Z`) } } : {}) },
      select: { date: true, isLate: true, adjustmentMonth: true },
    }),
    client.monthSnapshot.findMany({ where: { businessId, status: "LOCKED" }, select: { month: true } }),
  ]);
  const locked = new Set(snaps.map((s) => s.month));
  return rows.filter((r) => !isFrozen({ date: day(r.date), isLate: r.isLate, adjustmentMonth: r.adjustmentMonth }, locked)).length;
}

// ---- categories screen ------------------------------------------------------------------------------------------

export type CategoryStat = { count: number; cents: number };

/** Per category: transactions this year and their net dollars (money out positive). Read-only. */
export async function loadCategoryStats(client: Client, businessId: string, year: string): Promise<Map<string, CategoryStat>> {
  await requireClassification(client, businessId);
  const rows = await client.bankTransaction.groupBy({
    by: ["categoryId"],
    where: { businessId, categoryId: { not: null }, pending: false, removedAt: null, supersededAt: null, date: { gte: new Date(`${year}-01-01T00:00:00Z`), lt: new Date(`${Number(year) + 1}-01-01T00:00:00Z`) } },
    _count: { _all: true },
    _sum: { amountCents: true },
  });
  return new Map(rows.map((r) => [r.categoryId!, { count: r._count._all, cents: r._sum.amountCents ?? 0 }]));
}

export async function loadGroups(client: Pick<PrismaClient, "categoryGroup">, businessId: string) {
  const rows = await client.categoryGroup.findMany({ where: { businessId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  return rows.map((g) => ({ id: g.id, name: g.name, sortOrder: g.sortOrder }));
}
