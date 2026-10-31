import { applyRules, isFrozen, type ApplyResult, type ReviewStatusValue, type RulesStore, type StoredTxn } from "@/lib/rules/apply";
import { defToRow, rowToDef, type RuleRow } from "@/lib/rules/convert";
import { normalizeDescriptor } from "@/lib/rules/normalize";
import { directionOf, validateRule, type Kind, type RuleDef } from "@/lib/rules/types";
import { extractZelleCounterparty, zelleRecipientRules, type RecipientLabel } from "@/lib/rules/zelle";
import { resolveChoice, type CategoryOption, type Choice } from "@/lib/review/choices";
import { KEY } from "@/lib/report/template";

// Manual changes: classify one transaction (optionally "always for this merchant"), undo the last one, and the
// rule / recipient edits behind the Rules screen. Everything goes through ClassifyStore so it is testable without a
// database. Every change writes an audit entry. Locked months are read-only: a frozen row is never written.

export type TxnState = {
  kind: Kind | null;
  categoryId: string | null;
  categorySource: "NONE" | "RULE" | "PAIR" | "MANUAL";
  ruleId: string | null;
  pairId: string | null;
  reviewStatus: ReviewStatusValue;
  confirmed: boolean;
};

export type RuleRecord = RuleRow & { id: string };
export type AuditRecord = { id: string; action: string; payload: unknown; createdAt: Date };

export interface ClassifyStore extends RulesStore {
  getTxn(id: string): Promise<StoredTxn | null>;
  categories(): Promise<CategoryOption[]>;
  /** Writes the classification of ONE row, MANUAL or not (this is the person's override path). */
  setTxnState(id: string, state: TxnState): Promise<void>;
  getRule(id: string): Promise<RuleRecord | null>;
  getRuleByKey(key: string): Promise<RuleRecord | null>;
  /** Create or overwrite by key. */
  saveRule(rule: RuleRow): Promise<RuleRecord>;
  /** Attributed to the acting person by the store. */
  audit(action: string, entity: string, payload: Record<string, unknown>): Promise<void>;
  /** Most recent txn.classify / txn.undo entry. */
  lastClassifyAudit(): Promise<AuditRecord | null>;
}

export const ACTIONS = { classify: "txn.classify", undo: "txn.undo", ruleConfirm: "rule.confirm", ruleChange: "rule.change", ruleActive: "rule.active", recipient: "recipient.label" } as const;

export type Failure = { ok: false; error: string };
const fail = (error: string): Failure => ({ ok: false, error });

const stateOf = (t: StoredTxn): TxnState => ({ kind: t.kind, categoryId: t.categoryId, categorySource: t.categorySource, ruleId: t.ruleId, pairId: t.pairId, reviewStatus: t.reviewStatus, confirmed: t.confirmed });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const LOCKED_MSG = "That month is locked, so it can't be changed.";

/** Slim result of a re-apply, for display ("12 other transactions changed"). */
export type Reapplied = Pick<ApplyResult, "changed" | "skippedManual" | "skippedLocked" | "needsReview">;
const slimApply = (a: ApplyResult): Reapplied => ({ changed: a.changed, skippedManual: a.skippedManual, skippedLocked: a.skippedLocked, needsReview: a.needsReview });
const reapply = async (store: ClassifyStore) => slimApply(await applyRules(store, { all: true }));

// ---------------------------------------------------------------------------------------------
// classify one transaction
// ---------------------------------------------------------------------------------------------

/** The merchant key rules match on, or null when there is nothing safe to match (a payee-less check). */
export function ruleKeyFor(t: Pick<StoredTxn, "normalizedMerchant" | "raw">): string | null {
  const key = (t.normalizedMerchant ?? normalizeDescriptor(t.raw)).trim();
  if (!key || key === "CHECK" || /^CHECK( #?\d+)?$/.test(key)) return null;
  return key;
}

/** Staff and family rules name the business's own Wages / Personal categories (found by key, so renames don't break them). */
function zelleCategories(cats: readonly CategoryOption[], choice: Choice): { wagesCategory?: string; familyCategory?: string } {
  const wages = cats.find((c) => c.key === KEY.WAGES && !c.archived)?.name;
  return { wagesCategory: wages, familyCategory: choice.treatment === "PERSONAL" ? choice.categoryName : cats.find((c) => c.key === KEY.PERSONAL_MISC && !c.archived)?.name };
}

const isZelle = (key: string) => /^ZELLE (SCHEDULED )?PAYMENT (TO|FROM)\b/.test(key);

/** Rule definitions for "Always do this for <merchant>". Throws a user-safe message when no rule makes sense. */
export function alwaysRulesFor(t: StoredTxn, choice: Choice, cats: readonly CategoryOption[] = []): RuleDef[] {
  const key = ruleKeyFor(t);
  if (!key) throw new Error("Checks have no payee, so a rule can't be made for them. This one stays per-transaction.");
  const dir = directionOf(t.amountCents);

  if (isZelle(key)) {
    const cp = extractZelleCounterparty(t.raw);
    if (!cp) throw new Error("Couldn't read who that Zelle payment was with, so no rule was made.");
    let label: RecipientLabel;
    let vendorCategory: string | undefined;
    if (choice.treatment === "PERSONAL") label = "FAMILY";
    else if (choice.key === KEY.WAGES) label = "STAFF";
    else if (choice.treatment === "PNL_EXPENSE") {
      label = "VENDOR";
      vendorCategory = choice.categoryName;
    } else throw new Error("For Zelle payments a rule can only be Personal, Wages or an expense category. This one stays per-transaction.");
    return zelleRecipientRules({ name: cp.name, label, vendorCategory, ...zelleCategories(cats, choice) });
  }

  const def: RuleDef = {
    id: `user:always:${slug(key)}:${dir}`,
    name: `${key} (${choice.label})`,
    pattern: key,
    matchType: "EXACT",
    target: "normalized",
    direction: dir,
    kind: choice.kind,
    categoryName: choice.categoryName,
    priority: 50,
    confirmed: true,
    source: "USER",
    note: "Created from the review screen",
  };
  const errs = validateRule(def);
  if (errs.length) throw new Error(errs.join("; "));
  return [def];
}

export type ClassifyOutcome = { ok: true; reapplied: Reapplied | null; rulesSaved: number } | Failure;

export async function classifyManually(store: ClassifyStore, input: { txnId: string; value: string; always: boolean }): Promise<ClassifyOutcome> {
  const [txn, locked, cats] = await Promise.all([store.getTxn(input.txnId), store.lockedMonths(), store.categories()]);
  if (!txn) return fail("That transaction wasn't found.");
  if (isFrozen(txn, locked)) return fail(LOCKED_MSG);

  const resolved = resolveChoice(input.value, txn.amountCents, cats);
  if (!resolved.ok) return fail(resolved.error);
  const { choice } = resolved;
  const idByName = new Map(cats.map((c) => [c.name, c.id]));
  const categoryId = choice.categoryId;

  // Rules first: if one can't be made, nothing at all is changed.
  let defs: RuleDef[] = [];
  if (input.always) {
    try {
      defs = alwaysRulesFor(txn, choice, cats);
    } catch (e) {
      return fail((e as Error).message);
    }
  }
  const savedRules: { key: string; before: RuleRecord | null }[] = [];
  for (const def of defs) {
    const before = await store.getRuleByKey(def.id);
    await store.saveRule({ ...defToRow(def, idByName), active: true });
    savedRules.push({ key: def.id, before });
  }

  const before = stateOf(txn);
  const after: TxnState = { kind: choice.kind, categoryId, categorySource: "MANUAL", ruleId: null, pairId: null, reviewStatus: "REVIEWED", confirmed: true };
  await store.setTxnState(txn.id, after);
  await store.audit(ACTIONS.classify, "BankTransaction", { txnId: txn.id, merchant: ruleKeyFor(txn) ?? "CHECK", label: choice.label, before, after, rules: savedRules, always: input.always });

  const reapplied = defs.length ? await reapply(store) : null;
  return { ok: true, reapplied, rulesSaved: defs.length };
}

// ---------------------------------------------------------------------------------------------
// undo the last classify
// ---------------------------------------------------------------------------------------------

type ClassifyPayload = { txnId: string; label?: string; merchant?: string; before: TxnState; rules?: { key: string; before: RuleRecord | null }[] };

/** What Undo would undo right now, for the button label. */
export async function describeUndo(store: ClassifyStore): Promise<{ label: string } | null> {
  const last = await store.lastClassifyAudit();
  if (!last || last.action !== ACTIONS.classify) return null;
  const p = last.payload as ClassifyPayload;
  return { label: `${p.merchant ?? "transaction"}${p.label ? ` → ${p.label}` : ""}` };
}

export async function undoLast(store: ClassifyStore): Promise<{ ok: true; reapplied: Reapplied | null } | Failure> {
  const last = await store.lastClassifyAudit();
  if (!last || last.action !== ACTIONS.classify) return fail("Nothing to undo.");
  const p = last.payload as ClassifyPayload;

  const [txn, locked] = await Promise.all([store.getTxn(p.txnId), store.lockedMonths()]);
  if (!txn) return fail("That transaction is gone.");
  if (isFrozen(txn, locked)) return fail(LOCKED_MSG);

  for (const r of p.rules ?? []) {
    if (r.before) await store.saveRule(stripId(r.before));
    else {
      const cur = await store.getRuleByKey(r.key);
      if (cur) await store.saveRule({ ...stripId(cur), active: false }); // switched off, not deleted: rows may still point at it
    }
  }
  await store.setTxnState(p.txnId, p.before);
  await store.audit(ACTIONS.undo, "BankTransaction", { undoes: last.id, txnId: p.txnId });
  const reapplied = p.rules?.length ? await reapply(store) : null;
  return { ok: true, reapplied };
}

function stripId(r: RuleRecord): RuleRow {
  const { id: _id, ...row } = r;
  void _id;
  return row;
}

// ---------------------------------------------------------------------------------------------
// rules screen
// ---------------------------------------------------------------------------------------------

export type RuleOutcome = { ok: true; reapplied: Reapplied } | Failure;

export async function confirmRule(store: ClassifyStore, ruleId: string): Promise<RuleOutcome> {
  const rule = await store.getRule(ruleId);
  if (!rule) return fail("That rule wasn't found.");
  if (!rule.confirmed) {
    await store.saveRule({ ...stripId(rule), confirmed: true });
    await store.audit(ACTIONS.ruleConfirm, "Rule", { ruleId, key: rule.key, name: rule.name });
  }
  return { ok: true, reapplied: await reapply(store) };
}

export async function setRuleActive(store: ClassifyStore, ruleId: string, active: boolean): Promise<RuleOutcome> {
  const rule = await store.getRule(ruleId);
  if (!rule) return fail("That rule wasn't found.");
  if (rule.active !== active) {
    await store.saveRule({ ...stripId(rule), active });
    await store.audit(ACTIONS.ruleActive, "Rule", { ruleId, key: rule.key, name: rule.name, active });
  }
  return { ok: true, reapplied: await reapply(store) };
}

/**
 * Change what a rule does. A person's own rule is edited in place. A seed rule is switched off and replaced by a
 * USER override (key "user:override:<seed key>"): editing the seed row would be undone the next time the rules
 * release re-syncs the code-defined rules.
 */
export async function changeRule(store: ClassifyStore, ruleId: string, value: string): Promise<RuleOutcome> {
  const [rule, cats] = await Promise.all([store.getRule(ruleId), store.categories()]);
  if (!rule) return fail("That rule wasn't found.");

  const probe = rule.direction === "IN" ? -1 : 1; // direction decides what a pick means
  const resolved = resolveChoice(value, probe, cats);
  if (!resolved.ok) return fail(resolved.error);
  const { choice } = resolved;
  const categoryId = choice.categoryId;

  const nameById = new Map(cats.map((c) => [c.id, c.name]));
  const next: RuleRecord = { ...rule, kind: choice.kind, categoryId };
  const errs = validateRule(rowToDef(next, nameById));
  if (errs.length) return fail(errs.join("; "));

  if (rule.source === "SEED") {
    const key = `user:override:${rule.key}`;
    const existing = await store.getRuleByKey(key);
    await store.saveRule({ ...stripId(rule), key, name: `${rule.name} (changed)`, kind: choice.kind, categoryId, priority: 50, confirmed: true, source: "USER", active: true, note: `Replaces ${rule.key}` });
    await store.saveRule({ ...stripId(rule), active: false });
    await store.audit(ACTIONS.ruleChange, "Rule", { ruleId, key: rule.key, overrideKey: key, replacedExisting: !!existing, kind: choice.kind, category: choice.categoryName });
  } else {
    await store.saveRule({ ...stripId(next), confirmed: true });
    await store.audit(ACTIONS.ruleChange, "Rule", { ruleId, key: rule.key, kind: choice.kind, category: choice.categoryName });
  }
  return { ok: true, reapplied: await reapply(store) };
}

// ---------------------------------------------------------------------------------------------
// people (Zelle recipients)
// ---------------------------------------------------------------------------------------------

export type LabelInput = { name: string; label: RecipientLabel; vendorCategoryId?: string };

export async function labelRecipient(store: ClassifyStore, input: LabelInput): Promise<RuleOutcome> {
  const name = input.name.trim();
  if (!name) return fail("Missing name.");
  const cats = await store.categories();
  const idByName = new Map(cats.map((c) => [c.name, c.id]));

  let vendorCategory: string | undefined;
  if (input.label === "VENDOR") {
    const cat = cats.find((c) => c.id === input.vendorCategoryId);
    if (!cat || cat.archived || cat.treatment !== "PNL_EXPENSE") return fail("Pick a category for a vendor.");
    vendorCategory = cat.name;
  }
  const wagesCategory = cats.find((c) => c.key === KEY.WAGES && !c.archived)?.name;
  const familyCategory = cats.find((c) => c.key === KEY.PERSONAL_MISC && !c.archived)?.name;

  const wanted = zelleRecipientRules({ name, label: input.label, vendorCategory, wagesCategory, familyCategory });
  const allKeys = zelleRecipientRules({ name, label: "FAMILY" }).map((r) => r.id); // both directions
  for (const def of wanted) await store.saveRule({ ...defToRow(def, idByName), active: true });
  // a previous label may have had a rule the new one doesn't (Family has an inflow rule, Staff doesn't): switch it off
  for (const key of allKeys.filter((k) => !wanted.some((w) => w.id === k))) {
    const cur = await store.getRuleByKey(key);
    if (cur?.active) await store.saveRule({ ...stripId(cur), active: false });
  }
  await store.audit(ACTIONS.recipient, "Rule", { name, label: input.label, vendorCategory: vendorCategory ?? null });
  return { ok: true, reapplied: await reapply(store) };
}

