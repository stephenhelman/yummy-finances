import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { RuleRow } from "@/lib/rules/convert";
import { prismaRulesStore } from "@/lib/rules/prisma-store";
import type { StoredTxn } from "@/lib/rules/apply";
import { ACTIONS, type AuditRecord, type ClassifyStore, type RuleRecord } from "@/lib/review/service";
import { requireClassification } from "@/lib/rules/readiness";
import { KINDS, type Kind } from "@/lib/rules/types";

type Client = Pick<PrismaClient, "rule" | "category" | "bankTransaction" | "monthSnapshot" | "auditLog">;

const KIND_SET = new Set<string>(KINDS);
const asKind = (k: string | null): Kind | null => (k && KIND_SET.has(k) ? (k as Kind) : null);
const day = (d: Date) => d.toISOString().slice(0, 10);

type DbRule = Awaited<ReturnType<Client["rule"]["findFirstOrThrow"]>>;
const toRecord = (r: DbRule): RuleRecord => ({
  id: r.id, key: r.key, name: r.name, pattern: r.pattern, matchType: r.matchType, target: r.target, direction: r.direction,
  accounts: (r.accounts as RuleRow["accounts"]) ?? null, amountMinCents: r.amountMinCents, amountMaxCents: r.amountMaxCents,
  kind: r.kind as Kind, categoryId: r.categoryId, priority: r.priority, confirmed: r.confirmed, source: r.source, active: r.active, note: r.note,
});

/** The rules store plus the single-row reads and writes the review screens need. `actor` is who gets the audit entries. */
export function prismaClassifyStore(client: Client, businessId: string, actor: string): ClassifyStore {
  return {
    ...prismaRulesStore(client, businessId),

    async getTxn(id) {
      await requireClassification(client, businessId); // reading classification: enforced here, not just by the caller
      const r = await client.bankTransaction.findFirst({
        where: { id, businessId, pending: false, removedAt: null, supersededAt: null },
        include: { account: { include: { plaidItem: { select: { institutionName: true } } } } },
      });
      if (!r) return null;
      return {
        id: r.id, plaidTransactionId: r.plaidTransactionId, date: day(r.date), amountCents: r.amountCents, raw: r.rawDescription,
        pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed,
        account: { id: r.accountId, institution: r.account.plaidItem.institutionName ?? "Bank", mask: r.account.mask ?? "", type: r.account.type ?? "" },
        kind: asKind(r.kind), categoryId: r.categoryId, categorySource: r.categorySource, ruleId: r.ruleId, pairId: r.pairId,
        reviewStatus: r.reviewStatus, confirmed: r.confirmed, normalizedMerchant: r.normalizedMerchant, isLate: r.isLate, adjustmentMonth: r.adjustmentMonth,
      } satisfies StoredTxn;
    },

    async categories() {
      const rows = await client.category.findMany({ where: { businessId }, orderBy: [{ section: "asc" }, { sortOrder: "asc" }, { name: "asc" }] });
      return rows.map((c) => ({ id: c.id, name: c.name, section: c.section }));
    },

    async setTxnState(id, s) {
      const { count } = await client.bankTransaction.updateMany({
        where: { id, businessId },
        data: { kind: s.kind, categoryId: s.categoryId, categorySource: s.categorySource, ruleId: s.ruleId, pairId: s.pairId, reviewStatus: s.reviewStatus, confirmed: s.confirmed },
      });
      if (count !== 1) throw new Error("Transaction not found");
    },

    async getRule(id) {
      const r = await client.rule.findFirst({ where: { id, businessId } });
      return r ? toRecord(r) : null;
    },
    async getRuleByKey(key) {
      const r = await client.rule.findUnique({ where: { businessId_key: { businessId, key } } });
      return r ? toRecord(r) : null;
    },
    async saveRule(row) {
      const data = { ...row, accounts: row.accounts ?? Prisma.JsonNull };
      const r = await client.rule.upsert({ where: { businessId_key: { businessId, key: row.key } }, create: { businessId, ...data }, update: data });
      return toRecord(r);
    },

    async audit(action, entity, payload) {
      await client.auditLog.create({ data: { businessId, actor, action, entity, payload: payload as Prisma.InputJsonValue } });
    },
    async lastClassifyAudit() {
      const r = await client.auditLog.findFirst({ where: { businessId, action: { in: [ACTIONS.classify, ACTIONS.undo] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      return r ? ({ id: r.id, action: r.action, payload: r.payload, createdAt: r.createdAt } satisfies AuditRecord) : null;
    },
  };
}
