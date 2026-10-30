import type { AccountScope, Direction, Kind, MatchType, PatternTarget, RuleDef, RuleSource } from "@/lib/rules/types";

// Conversion between code-defined rules (RuleDef) and the shape stored in the Rule table. Pure.

export type RuleRow = {
  key: string; // stable identity: the RuleDef id, e.g. "seed:creamland:purchase"
  name: string;
  pattern: string;
  matchType: MatchType;
  target: "NORMALIZED" | "RAW";
  direction: "IN" | "OUT" | "ANY";
  accounts: AccountScope[] | null;
  amountMinCents: number | null;
  amountMaxCents: number | null;
  kind: Kind;
  categoryId: string | null;
  priority: number;
  confirmed: boolean;
  source: RuleSource;
  active: boolean;
  note: string | null;
};

export function defToRow(def: RuleDef, categoryIdByName: ReadonlyMap<string, string>): RuleRow {
  let categoryId: string | null = null;
  if (def.categoryName) {
    categoryId = categoryIdByName.get(def.categoryName) ?? null;
    if (!categoryId) throw new Error(`Rule ${def.id}: category "${def.categoryName}" does not exist (run the seed to apply the category changes)`);
  }
  return {
    key: def.id,
    name: def.name,
    pattern: def.pattern,
    matchType: def.matchType,
    target: def.target === "raw" ? "RAW" : "NORMALIZED",
    direction: def.direction === "in" ? "IN" : def.direction === "out" ? "OUT" : "ANY",
    accounts: def.accounts?.length ? def.accounts : null,
    amountMinCents: def.amountMinCents ?? null,
    amountMaxCents: def.amountMaxCents ?? null,
    kind: def.kind,
    categoryId,
    priority: def.priority,
    confirmed: def.confirmed,
    source: def.source,
    active: true,
    note: def.note ?? null,
  };
}

/** A stored rule as the engine wants it. The engine's rule id is the database id, so decisions can reference the row. */
export function rowToDef(row: RuleRow & { id: string }, categoryNameById: ReadonlyMap<string, string>): RuleDef {
  const direction: Direction = row.direction === "IN" ? "in" : row.direction === "OUT" ? "out" : "any";
  const target: PatternTarget = row.target === "RAW" ? "raw" : "normalized";
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    matchType: row.matchType,
    target,
    direction,
    accounts: row.accounts ?? undefined,
    amountMinCents: row.amountMinCents ?? undefined,
    amountMaxCents: row.amountMaxCents ?? undefined,
    kind: row.kind,
    categoryName: row.categoryId ? categoryNameById.get(row.categoryId) : undefined,
    priority: row.priority,
    confirmed: row.confirmed,
    source: row.source,
    note: row.note ?? undefined,
  };
}

/**
 * What to write when syncing a code-defined rule onto an existing row: the definition wins, except that a
 * person's decisions stick. A rule someone confirmed stays confirmed (never un-confirmed by a re-seed), and a
 * rule someone switched off stays off.
 */
export function mergeForUpsert(existing: Pick<RuleRow, "confirmed" | "active"> | null, next: RuleRow): RuleRow {
  if (!existing) return next;
  return { ...next, confirmed: existing.confirmed || next.confirmed, active: existing.active };
}
