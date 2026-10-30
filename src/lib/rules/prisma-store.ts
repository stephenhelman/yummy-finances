import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { RulesStore, StoredTxn, Patch } from "@/lib/rules/apply";
import { defToRow, mergeForUpsert, rowToDef, type RuleRow } from "@/lib/rules/convert";
import { KINDS, type Kind, type RuleDef } from "@/lib/rules/types";

// Prisma implementations of the rules store and of rule persistence. Both take a client so they can run
// against a transaction (the rehearsal script runs them inside a transaction that is always rolled back).

type Client = Pick<PrismaClient, "rule" | "category" | "bankTransaction" | "monthSnapshot">;

const KIND_SET = new Set<string>(KINDS);
/** Legacy kinds (TRANSFER, IGNORE) from before the engine are not engine kinds: treat as unclassified. */
const asKind = (k: string | null): Kind | null => (k && KIND_SET.has(k) ? (k as Kind) : null);
const day = (d: Date) => d.toISOString().slice(0, 10);
const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export function prismaRulesStore(client: Client, businessId: string): RulesStore {
  return {
    async loadRules() {
      const [rows, cats] = await Promise.all([
        client.rule.findMany({ where: { businessId, active: true } }),
        client.category.findMany({ where: { businessId }, select: { id: true, name: true } }),
      ]);
      const nameById = new Map(cats.map((c) => [c.id, c.name]));
      // A rule with a legacy kind (TRANSFER, IGNORE) is not something the engine understands: skip it.
      const rules = rows
        .filter((r) => KIND_SET.has(r.kind))
        .map((r) => rowToDef({ ...r, kind: r.kind as Kind, accounts: (r.accounts as RuleRow["accounts"]) ?? null }, nameById));
      return { rules, categoryIdByName: new Map(cats.map((c) => [c.name, c.id])) };
    },

    async loadTransactions(range) {
      const rows = await client.bankTransaction.findMany({
        where: {
          businessId,
          pending: false,
          removedAt: null,
          supersededAt: null,
          account: { included: true },
          ...(range ? { date: { gte: new Date(`${range.from}T00:00:00Z`), lte: new Date(`${range.to}T00:00:00Z`) } } : {}),
        },
        include: { account: { include: { plaidItem: { select: { institutionName: true } } } } },
        orderBy: [{ date: "asc" }, { id: "asc" }],
      });
      return rows.map((r): StoredTxn => ({
        id: r.id,
        plaidTransactionId: r.plaidTransactionId,
        date: day(r.date),
        amountCents: r.amountCents,
        raw: r.rawDescription,
        pfcPrimary: r.pfcPrimary,
        pfcDetailed: r.pfcDetailed,
        account: { id: r.accountId, institution: r.account.plaidItem.institutionName ?? "Bank", mask: r.account.mask ?? "", type: r.account.type ?? "" },
        kind: asKind(r.kind),
        categoryId: r.categoryId,
        categorySource: r.categorySource,
        ruleId: r.ruleId,
        pairId: r.pairId,
        reviewStatus: r.reviewStatus,
        confirmed: r.confirmed,
        normalizedMerchant: r.normalizedMerchant,
        isLate: r.isLate,
        adjustmentMonth: r.adjustmentMonth,
      }));
    },

    async datesOf(plaidTransactionIds) {
      const out: string[] = [];
      for (const part of chunks(plaidTransactionIds, 1000)) {
        const rows = await client.bankTransaction.findMany({ where: { businessId, plaidTransactionId: { in: part } }, select: { date: true } });
        out.push(...rows.map((r) => day(r.date)));
      }
      return out;
    },

    async lockedMonths() {
      const rows = await client.monthSnapshot.findMany({ where: { businessId, status: "LOCKED" }, select: { month: true } });
      return new Set(rows.map((r) => r.month));
    },

    async clearUnprocessedKinds() {
      const { count } = await client.bankTransaction.updateMany({
        where: { businessId, kind: { not: null }, categorySource: "NONE", normalizedMerchant: null, ruleId: null, pairId: null },
        data: { kind: null },
      });
      return count;
    },

    async writePatch(ids: string[], patch: Patch) {
      for (const part of chunks(ids, 500)) {
        await client.bankTransaction.updateMany({
          // the MANUAL guard is repeated here so a row a person just categorized can never be overwritten, even in a race
          where: { id: { in: part }, businessId, categorySource: { not: "MANUAL" } },
          data: { ...patch },
        });
      }
    },
  };
}

export type PersistResult = { created: number; updated: number; unchanged: number };

/** Upserts code-defined rules by (business, key). A person's confirmations and switch-offs stick (see mergeForUpsert). */
export async function persistRules(client: Pick<PrismaClient, "rule" | "category">, businessId: string, defs: readonly RuleDef[]): Promise<PersistResult> {
  const cats = await client.category.findMany({ where: { businessId }, select: { id: true, name: true } });
  const idByName = new Map(cats.map((c) => [c.name, c.id]));
  const existing = new Map((await client.rule.findMany({ where: { businessId } })).map((r) => [r.key, r]));
  const result: PersistResult = { created: 0, updated: 0, unchanged: 0 };

  for (const def of defs) {
    const row = defToRow(def, idByName);
    const prev = existing.get(def.id);
    const merged = mergeForUpsert(prev ?? null, row);
    const data = { ...merged, accounts: merged.accounts ?? Prisma.JsonNull };
    if (!prev) {
      await client.rule.create({ data: { businessId, ...data } });
      result.created++;
      continue;
    }
    const same =
      JSON.stringify([prev.name, prev.pattern, prev.matchType, prev.target, prev.direction, prev.accounts ?? null, prev.amountMinCents, prev.amountMaxCents, prev.kind, prev.categoryId, prev.priority, prev.confirmed, prev.source, prev.active, prev.note]) ===
      JSON.stringify([merged.name, merged.pattern, merged.matchType, merged.target, merged.direction, merged.accounts, merged.amountMinCents, merged.amountMaxCents, merged.kind, merged.categoryId, merged.priority, merged.confirmed, merged.source, merged.active, merged.note]);
    if (same) result.unchanged++;
    else {
      await client.rule.update({ where: { businessId_key: { businessId, key: def.id } }, data });
      result.updated++;
    }
  }
  return result;
}
