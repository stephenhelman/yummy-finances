import { classify } from "@/lib/rules/engine";
import type { Decision, Kind, RuleDef, TxnInput } from "@/lib/rules/types";

// applyRules: runs the normalizer, the pair matcher and the rules over stored transactions and writes the
// classification back. Rules of the road:
//   - never overwrites categorySource = MANUAL (a person's choice), and manual rows do not take part in pairing
//   - only touches rows whose month is not locked (a locked month's snapshot already counted them). The exception
//     is a LATE row (arrived after its month locked): it belongs to the open month's adjustments, so it is classified
//   - idempotent: a second run over the same data writes nothing
//   - one database statement per distinct result, so large backfills stay well under the transaction limit

export type CategorySourceValue = "NONE" | "RULE" | "PAIR" | "MANUAL";
export type ReviewStatusValue = "NEEDS_REVIEW" | "AUTO" | "REVIEWED";

export type StoredTxn = {
  id: string;
  plaidTransactionId: string;
  date: string; // YYYY-MM-DD
  amountCents: number;
  raw: string;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  account: TxnInput["account"];
  // current classification
  kind: Kind | null;
  categoryId: string | null;
  categorySource: CategorySourceValue;
  ruleId: string | null;
  pairId: string | null;
  reviewStatus: ReviewStatusValue;
  confirmed: boolean;
  normalizedMerchant: string | null;
  // late-adjustment state
  isLate: boolean;
  adjustmentMonth: string | null;
};

/** Everything applyRules writes for a transaction. */
export type Patch = {
  kind: Kind | null;
  categoryId: string | null;
  categorySource: Exclude<CategorySourceValue, "MANUAL">;
  ruleId: string | null;
  pairId: string | null;
  reviewStatus: Exclude<ReviewStatusValue, "REVIEWED">;
  confirmed: boolean;
  normalizedMerchant: string | null;
};

export interface RulesStore {
  /** Active rules (the engine id is the database id) and the category id for each name. */
  loadRules(): Promise<{ rules: RuleDef[]; categoryIdByName: Map<string, string> }>;
  /** Posted, non-removed, non-superseded transactions on INCLUDED accounts, with their stored classification. */
  loadTransactions(range: { from: string; to: string } | null): Promise<StoredTxn[]>;
  /** Dates of the given Plaid transactions in any state (a removed row still marks where something changed). */
  datesOf(plaidTransactionIds: string[]): Promise<string[]>;
  lockedMonths(): Promise<Set<string>>;
  /** Writes `patch` to these transactions. Must itself refuse to touch MANUAL rows. */
  writePatch(ids: string[], patch: Patch): Promise<void>;
  /**
   * Rows that were never processed (no source, no normalized key) must not carry a kind. Before the engine existed the
   * kind column defaulted to EXPENSE, and rows the engine does not look at (pending, removed, superseded) kept it.
   * Clears those; returns how many. Never touches a processed or manual row.
   */
  clearUnprocessedKinds(): Promise<number>;
}

export type ApplyScope = { all: true } | { plaidTransactionIds: string[] };

export type ApplyResult = {
  considered: number; // rows in the write window
  changed: number;
  unchanged: number;
  skippedManual: number;
  skippedLocked: number;
  needsReview: number; // rows in the write window that are (still) in the review queue
  window: { from: string; to: string } | null;
  legacyCleared: number; // never-processed rows whose leftover default kind was cleared (full runs only)
};

export const PAIR_WINDOW_DAYS = 5;

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function toInput(t: StoredTxn): TxnInput {
  return { id: t.id, date: t.date, amountCents: t.amountCents, raw: t.raw, pfcPrimary: t.pfcPrimary, pfcDetailed: t.pfcDetailed, account: t.account };
}

/** Decision -> what to store. `confirmed` means a confirmed rule, a pair, a system rule or a person decided it. */
export function patchFor(d: Decision, categoryIdByName: ReadonlyMap<string, string>): Patch {
  let categoryId: string | null = null;
  if (d.categoryName) {
    categoryId = categoryIdByName.get(d.categoryName) ?? null;
    if (!categoryId) throw new Error(`Category "${d.categoryName}" does not exist (run the seed)`);
  }
  const pair = d.via === "pair" && d.pairedWith ? [d.txnId, d.pairedWith].sort()[0] : null;
  return {
    kind: d.kind,
    categoryId,
    categorySource: d.via === "pair" ? "PAIR" : d.via === "default" ? "NONE" : "RULE",
    ruleId: d.via === "rule" ? d.ruleId : null, // system rules have no Rule row
    pairId: pair,
    reviewStatus: d.status === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : "AUTO",
    confirmed: d.status === "AUTO",
    normalizedMerchant: d.normalized,
  };
}

const PATCH_FIELDS: (keyof Patch)[] = ["kind", "categoryId", "categorySource", "ruleId", "pairId", "reviewStatus", "confirmed", "normalizedMerchant"];
const samePatch = (t: StoredTxn, p: Patch) => PATCH_FIELDS.every((f) => (t as unknown as Record<string, unknown>)[f] === p[f]);

/** A row whose month is locked is frozen, unless it is a late row whose adjustment month is still open. */
export function isFrozen(t: Pick<StoredTxn, "date" | "isLate" | "adjustmentMonth">, locked: ReadonlySet<string>): boolean {
  if (!locked.has(t.date.slice(0, 7))) return false;
  return !(t.isLate && t.adjustmentMonth && !locked.has(t.adjustmentMonth));
}

export async function applyRules(store: RulesStore, scope: ApplyScope): Promise<ApplyResult> {
  const [{ rules, categoryIdByName }, locked] = await Promise.all([store.loadRules(), store.lockedMonths()]);

  // Write window: everything within the pair window of what changed. Load window: wider, so a row at the
  // edge of the write window still sees the other side of its pair.
  let write: { from: string; to: string } | null = null;
  let load: { from: string; to: string } | null = null;
  if ("plaidTransactionIds" in scope) {
    const dates = (await store.datesOf(scope.plaidTransactionIds)).sort();
    if (!dates.length) return { considered: 0, changed: 0, unchanged: 0, skippedManual: 0, skippedLocked: 0, needsReview: 0, window: null, legacyCleared: 0 };
    write = { from: addDays(dates[0], -PAIR_WINDOW_DAYS), to: addDays(dates[dates.length - 1], PAIR_WINDOW_DAYS) };
    load = { from: addDays(write.from, -PAIR_WINDOW_DAYS), to: addDays(write.to, PAIR_WINDOW_DAYS) };
  }

  const rows = await store.loadTransactions(load);
  const inWrite = (t: StoredTxn) => !write || (t.date >= write.from && t.date <= write.to);
  const manual = rows.filter((t) => t.categorySource === "MANUAL");
  const classifiable = rows.filter((t) => t.categorySource !== "MANUAL");
  const decisions = new Map(classify(classifiable.map(toInput), rules, { pairWindowDays: PAIR_WINDOW_DAYS }).map((d) => [d.txnId, d]));

  const result: ApplyResult = { considered: 0, changed: 0, unchanged: 0, skippedManual: manual.filter(inWrite).length, skippedLocked: 0, needsReview: 0, window: write, legacyCleared: 0 };
  const groups = new Map<string, { patch: Patch; ids: string[] }>();

  for (const t of classifiable) {
    if (!inWrite(t)) continue;
    result.considered++;
    if (isFrozen(t, locked)) {
      result.skippedLocked++;
      continue;
    }
    const patch = patchFor(decisions.get(t.id)!, categoryIdByName);
    if (patch.reviewStatus === "NEEDS_REVIEW") result.needsReview++;
    if (samePatch(t, patch)) {
      result.unchanged++;
      continue;
    }
    result.changed++;
    const key = JSON.stringify(patch);
    (groups.get(key) ?? groups.set(key, { patch, ids: [] }).get(key)!).ids.push(t.id);
  }
  result.considered += result.skippedManual;

  for (const { patch, ids } of groups.values()) await store.writePatch(ids, patch);
  if (!write) result.legacyCleared = await store.clearUnprocessedKinds(); // after the writes: processed rows now have a normalized key
  return result;
}
