import type { PrismaClient } from "@/generated/prisma/client";
import { CATEGORY_MAP, keyOf, manualTarget, ruleTarget } from "@/lib/report/mapping";
import { isFrozen } from "@/lib/rules/apply";
import { KINDS, type Kind } from "@/lib/rules/types";

// Applies the mapping (src/lib/report/mapping.ts) to a database. IDEMPOTENT: a second run finds nothing left to move. It only
// ever touches:
//   - rules whose category is still a legacy one (or that have none) -> their template category
//   - MANUAL transactions on a legacy category (or a "Personal" pick with none) -> the equivalent template category, still MANUAL
// Rule-based rows are not moved here: the rules move, and the rules release then re-applies them. Rows in locked months are
// never touched. Needs the template to exist (run seedTemplate first); refuses otherwise.

type Client = Pick<PrismaClient, "category" | "rule" | "bankTransaction" | "monthSnapshot">;
const KIND_SET = new Set<string>(KINDS);

export type MappingResult = { rulesMoved: number; manualMoved: number; manualSkippedLocked: number };

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export async function applyMapping(client: Client, businessId: string): Promise<MappingResult> {
  const cats = await client.category.findMany({ where: { businessId } });
  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const idByKey = new Map(cats.filter((c) => c.key).map((c) => [c.key!, c.id]));
  // "legacy" = an old seed category: archived and without a template key. Rent and Utilities were adopted into the template (they have keys).
  const legacyNames = new Set(cats.filter((c) => !c.key && c.archived).map((c) => c.name));
  const isLegacy = (name: string) => legacyNames.has(name);
  const destination = (to: string): string => {
    const id = idByKey.get(keyOf(to));
    if (!id) throw new Error(`Category "${to}" does not exist (run the template seed first)`);
    return id;
  };

  const result: MappingResult = { rulesMoved: 0, manualMoved: 0, manualSkippedLocked: 0 };

  // ---- rules
  for (const r of await client.rule.findMany({ where: { businessId } })) {
    if (!KIND_SET.has(r.kind)) continue;
    const t = ruleTarget({ key: r.key, kind: r.kind as Kind, categoryName: r.categoryId ? nameById.get(r.categoryId) ?? null : null }, isLegacy);
    if (!t) continue;
    const id = destination(t.to);
    if (r.categoryId === id) continue;
    await client.rule.update({ where: { id: r.id }, data: { categoryId: id } });
    result.rulesMoved++;
  }

  // ---- a person's own picks
  const [rows, snaps] = await Promise.all([
    client.bankTransaction.findMany({
      where: { businessId, categorySource: "MANUAL", OR: [{ categoryId: { in: cats.filter((c) => !c.key && c.archived).map((c) => c.id) } }, { categoryId: null, kind: { in: ["OWNER_DRAW", "OWNER_CONTRIBUTION"] } }] },
      select: { id: true, kind: true, categoryId: true, date: true, isLate: true, adjustmentMonth: true },
    }),
    client.monthSnapshot.findMany({ where: { businessId, status: "LOCKED" }, select: { month: true } }),
  ]);
  const locked = new Set(snaps.map((s) => s.month));
  const byDest = new Map<string, string[]>();
  for (const row of rows) {
    if (isFrozen({ date: row.date.toISOString().slice(0, 10), isLate: row.isLate, adjustmentMonth: row.adjustmentMonth }, locked)) {
      result.manualSkippedLocked++;
      continue;
    }
    const t = manualTarget({ kind: row.kind && KIND_SET.has(row.kind) ? (row.kind as Kind) : null, categoryName: row.categoryId ? nameById.get(row.categoryId) ?? null : null }, isLegacy);
    if (!t) continue;
    const id = destination(t.to);
    (byDest.get(id) ?? byDest.set(id, []).get(id)!).push(row.id);
  }
  for (const [id, ids] of byDest) {
    for (const part of chunks(ids, 500)) await client.bankTransaction.updateMany({ where: { businessId, id: { in: part }, categorySource: "MANUAL" }, data: { categoryId: id } });
    result.manualMoved += ids.length;
  }
  return result;
}

export { CATEGORY_MAP };
