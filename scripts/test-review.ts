import assert from "node:assert/strict";
import type { Patch, StoredTxn } from "../src/lib/rules/apply";
import { rowToDef, type RuleRow } from "../src/lib/rules/convert";
import { ALL_RULES } from "../src/lib/rules/all";
import { defToRow } from "../src/lib/rules/convert";
import type { RuleDef } from "../src/lib/rules/types";
import { normalizeDescriptor } from "../src/lib/rules/normalize";
import { pickableGroups, quickPicks, resolveChoice, type CategoryOption } from "../src/lib/review/choices";
import { GROUP_ORDER, TEMPLATE } from "../src/lib/report/template";
import { ACTIONS, changeRule, classifyManually, confirmRule, describeUndo, labelRecipient, ruleKeyFor, setRuleActive, undoLast, type AuditRecord, type ClassifyStore, type RuleRecord, type TxnState } from "../src/lib/review/service";
import { byNewest, filterTxns, monthCounts, pickNext, prettyMerchant, prettyPfc, reviewQueue, reviewSummary, type TxnView } from "../src/lib/review/view";

// ---- fixture -----------------------------------------------------------------------------------------------
const CATS: CategoryOption[] = TEMPLATE.map((c, i) => ({
  id: c.key, name: c.name, key: c.key, groupName: c.group, groupSort: c.group === null ? -1 : GROUP_ORDER.indexOf(c.group), treatment: c.treatment, nonPlKind: c.nonPlKind ?? null,
  showWhenZero: true, archived: false, quickPickOrder: c.quickPick ?? null, sortOrder: i,
}));
const catId = (n: string) => CATS.find((c) => c.name === n)!.id;
const nameById = new Map(CATS.map((c) => [c.id, c.name]));
const idByName = new Map(CATS.map((c) => [c.name, c.id]));
const ACCT = { id: "a1", institution: "Bank of America", mask: "2879", type: "depository" };

type Row = StoredTxn;
let seq = 0;
const row = (raw: string, cents: number, date = "2026-10-05", extra: Partial<Row> = {}): Row => {
  const id = `t${++seq}`;
  return { id, plaidTransactionId: `p${seq}`, date, amountCents: cents, raw, pfcPrimary: null, pfcDetailed: null, account: ACCT, kind: null, categoryId: null, categorySource: "NONE", ruleId: null, pairId: null, reviewStatus: "NEEDS_REVIEW", confirmed: false, normalizedMerchant: normalizeDescriptor(raw), isLate: false, adjustmentMonth: null, ...extra };
};

class Mem implements ClassifyStore {
  audits: (AuditRecord & { entity: string })[] = [];
  rules: RuleRecord[] = [];
  nextRule = 0;
  constructor(public rows: Row[], public locked = new Set<string>(), seedRules: RuleDef[] = []) {
    for (const d of seedRules) this.rules.push({ id: `rule${++this.nextRule}`, ...defToRow(d, idByName) });
  }
  async loadRules() {
    const defs = this.rules.filter((r) => r.active).map((r) => rowToDef(r, nameById));
    return { rules: defs, categoryIdByName: idByName };
  }
  async loadTransactions() { return this.rows.map((r) => ({ ...r })); }
  async datesOf() { return this.rows.map((r) => r.date); }
  async lockedMonths() { return this.locked; }
  async clearUnprocessedKinds() { return 0; }
  async writePatch(ids: string[], patch: Patch) {
    for (const r of this.rows) if (ids.includes(r.id) && r.categorySource !== "MANUAL") Object.assign(r, patch);
  }
  async getTxn(id: string) { const r = this.rows.find((x) => x.id === id); return r ? { ...r } : null; }
  async categories() { return CATS; }
  async setTxnState(id: string, s: TxnState) { Object.assign(this.rows.find((x) => x.id === id)!, s); }
  async getRule(id: string) { return this.rules.find((r) => r.id === id) ?? null; }
  async getRuleByKey(key: string) { return this.rules.find((r) => r.key === key) ?? null; }
  async saveRule(row: RuleRow) {
    const i = this.rules.findIndex((r) => r.key === row.key);
    const rec = { id: i >= 0 ? this.rules[i].id : `rule${++this.nextRule}`, ...row };
    if (i >= 0) this.rules[i] = rec; else this.rules.push(rec);
    return rec;
  }
  async audit(action: string, entity: string, payload: Record<string, unknown>) {
    // payloads are stored as JSON in the database: round-trip to prove they survive it
    this.audits.push({ id: `au${this.audits.length + 1}`, action, entity, payload: JSON.parse(JSON.stringify(payload)), createdAt: new Date() });
  }
  async lastClassifyAudit() { return [...this.audits].reverse().find((a) => a.action === ACTIONS.classify || a.action === ACTIONS.undo) ?? null; }
  get(id: string) { return this.rows.find((r) => r.id === id)!; }
}

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => { assert.ok(r.ok, `expected ok, got ${JSON.stringify(r)}`); return r as Extract<T, { ok: true }>; };
const err = (r: { ok: boolean; error?: string }, re: RegExp) => { assert.ok(!r.ok && re.test(r.error ?? ""), `expected failure ${re}, got ${JSON.stringify(r)}`); };

async function main() {
  // ---- choices: the owner picks a category, the kind is derived ------------------------------------------------------------
  {
    const out = resolveChoice("cat:personal-misc", 5000, CATS), inn = resolveChoice("cat:personal-misc", -5000, CATS);
    assert.ok(out.ok && out.choice.kind === "OWNER_DRAW" && out.choice.categoryName === "Personal: Misc");
    assert.ok(inn.ok && inn.choice.kind === "OWNER_CONTRIBUTION");
    const wages = resolveChoice("cat:wages", 5000, CATS);
    assert.ok(wages.ok && wages.choice.kind === "EXPENSE" && wages.choice.categoryName === "Wages and Benefits");
    const refund = resolveChoice("cat:purchase", -5000, CATS);
    assert.ok(refund.ok && refund.choice.kind === "VENDOR_REFUND", "an expense category on an inflow is a vendor refund");
    assert.ok(!resolveChoice("cat:other-income", 5000, CATS).ok, "income is for money coming in");
    const income = resolveChoice("cat:other-income", -5000, CATS);
    assert.ok(income.ok && income.choice.kind === "OTHER_INCOME", "the one manual route to P&L income");
    const tax = resolveChoice("cat:sales-tax", 5000, CATS), pay = resolveChoice("cat:payments", -5000, CATS), xfer = resolveChoice("cat:other-transfers", 5000, CATS), gift = resolveChoice("cat:donations", 5000, CATS);
    assert.ok(tax.ok && tax.choice.kind === "SALES_TAX_REMITTANCE" && pay.ok && pay.choice.kind === "CARD_PAYMENT" && xfer.ok && xfer.choice.kind === "INTERNAL_TRANSFER" && gift.ok && gift.choice.kind === "DONATION");
    assert.ok(!resolveChoice("cat:donations", -5000, CATS).ok);
    assert.ok(!resolveChoice("bogus", 5000, CATS).ok && !resolveChoice("cat:nope", 5000, CATS).ok && !resolveChoice("kind:CARD_PAYMENT", 5000, CATS).ok, "only categories are choices");
    assert.ok(!resolveChoice("cat:purchase", 5000, CATS.map((c) => (c.id === "purchase" ? { ...c, archived: true } : c))).ok, "archived categories can't be picked");
    assert.deepEqual(quickPicks(CATS, 5000).map((p) => p.label), ["Personal: Misc", "Wages and Benefits", "Purchase", "Materials & Supplies", "Repairs"], "default quick picks, in order");
    assert.deepEqual(quickPicks(CATS, -5000).map((p) => p.label), ["Personal: Misc", "Refund: Wages and Benefits", "Refund: Purchase", "Refund: Materials & Supplies", "Refund: Repairs"]);
    const custom = CATS.map((c) => (c.id === "rent" ? { ...c, quickPickOrder: 1 } : c.id === "personal-misc" ? { ...c, quickPickOrder: null } : c));
    assert.equal(quickPicks(custom, 5000)[0].label, "Rent", "quick picks are configurable");
    const groups = pickableGroups(CATS, 5000);
    assert.deepEqual(groups.map((g) => g.group), ["Expenses", "Sales/Food", "Other Direct Selling", "Other", "Personal"], "grouped as on the report; income is not offered for an outflow");
    assert.equal(groups[0].items[0].name, "Wages and Benefits");
    assert.ok(pickableGroups(CATS, -5000).some((g) => g.group === "Income"));
  }

  // ---- 1. Personal maps direction; manual stamping ----------------------------------------------------------
  {
    const out = row("VENMO CASHOUT", 12000), inn = row("ZELLE PAYMENT FROM MOM", -9000, "2026-10-06");
    const s = new Mem([out, inn]);
    ok(await classifyManually(s, { txnId: out.id, value: "cat:personal-misc", always: false }));
    ok(await classifyManually(s, { txnId: inn.id, value: "cat:personal-misc", always: false }));
    assert.equal(s.get(out.id).kind, "OWNER_DRAW");
    assert.equal(s.get(inn.id).kind, "OWNER_CONTRIBUTION");
    for (const id of [out.id, inn.id]) {
      const r = s.get(id);
      assert.equal(r.categorySource, "MANUAL"); assert.equal(r.reviewStatus, "REVIEWED"); assert.equal(r.confirmed, true); assert.equal(r.categoryId, "personal-misc", "Personal is a category too");
    }
    assert.equal(s.audits.filter((a) => a.action === ACTIONS.classify).length, 2, "every manual change is audited");
    const c = row("SOME VENDOR", 4000);
    ok(await classifyManually(new Mem([c]), { txnId: c.id, value: "cat:materials-and-supplies", always: false }));
    err(await classifyManually(new Mem([]), { txnId: "nope", value: "cat:materials-and-supplies", always: false }), /wasn't found/);
  }

  // ---- 2. Always: confirmed rule, applied to others, never to manual or locked rows ---------------------------
  {
    const target = row("CREAMLAND DAIRY 4412", 8000, "2026-10-08");
    const other = row("CREAMLAND DAIRY 9911", 6500, "2026-09-20");
    const manual = row("CREAMLAND DAIRY 1234", 5000, "2026-09-21", { kind: "EXPENSE", categoryId: catId("Materials & Supplies"), categorySource: "MANUAL", reviewStatus: "REVIEWED", confirmed: true });
    const lockedRow = row("CREAMLAND DAIRY 7777", 7000, "2026-07-14");
    const refund = row("CREAMLAND DAIRY 5555", -2000, "2026-09-25");
    const unrelated = row("PAPER GOODS CO", 3000, "2026-09-22");
    const s = new Mem([target, other, manual, lockedRow, refund, unrelated], new Set(["2026-07"]));
    const lockedBefore = JSON.stringify(s.get(lockedRow.id)), manualBefore = JSON.stringify(s.get(manual.id));

    const res = ok(await classifyManually(s, { txnId: target.id, value: "cat:purchase", always: true }));
    assert.equal(res.rulesSaved, 1);
    const rule = s.rules.find((r) => r.key === "user:always:creamland:out")!;
    assert.ok(rule && rule.confirmed && rule.active && rule.source === "USER" && rule.kind === "EXPENSE" && rule.categoryId === catId("Purchase") && rule.direction === "OUT");
    assert.equal(s.get(target.id).categorySource, "MANUAL", "the clicked row is the person's own decision");
    assert.equal(s.get(other.id).kind, "EXPENSE"); assert.equal(s.get(other.id).categoryId, catId("Purchase")); assert.equal(s.get(other.id).confirmed, true); assert.equal(s.get(other.id).categorySource, "RULE");
    assert.equal(JSON.stringify(s.get(manual.id)), manualBefore, "manual row untouched");
    assert.equal(JSON.stringify(s.get(lockedRow.id)), lockedBefore, "locked-month row untouched");
    assert.equal(s.get(refund.id).kind, "OTHER_INFLOW", "an outflow rule does not claim the inflow");
    assert.equal(s.get(unrelated.id).reviewStatus, "NEEDS_REVIEW");
    assert.ok(res.reapplied && res.reapplied.changed >= 1 && res.reapplied.skippedManual >= 1 && res.reapplied.skippedLocked >= 1);

    // doing it again for the same merchant updates the same rule rather than adding a second one
    const t2 = row("CREAMLAND DAIRY 0001", 1000, "2026-10-09");
    s.rows.push(t2);
    ok(await classifyManually(s, { txnId: t2.id, value: "cat:materials-and-supplies", always: true }));
    assert.equal(s.rules.filter((r) => r.key === "user:always:creamland:out").length, 1);
    assert.equal(s.rules.find((r) => r.key === "user:always:creamland:out")!.categoryId, catId("Materials & Supplies"));
  }

  // ---- 3. CHECK rows cannot create rules ---------------------------------------------------------------------
  {
    assert.equal(ruleKeyFor({ normalizedMerchant: "CHECK", raw: "CHECK #1234" }), null);
    assert.equal(ruleKeyFor({ normalizedMerchant: null, raw: "Check 4411" }), null);
    assert.equal(ruleKeyFor({ normalizedMerchant: "CHECK 4411", raw: "x" }), null);
    const chk = row("CHECK 4411", 430000, "2026-10-02", {});
    const s = new Mem([chk]);
    err(await classifyManually(s, { txnId: chk.id, value: "cat:wages", always: true }), /Checks have no payee/);
    assert.equal(s.get(chk.id).categorySource, "NONE", "a refused request changes nothing");
    assert.equal(s.rules.length, 0);
    assert.equal(s.audits.length, 0);
    ok(await classifyManually(s, { txnId: chk.id, value: "cat:wages", always: false }));
    assert.equal(s.get(chk.id).categoryId, catId("Wages and Benefits"));
    assert.equal(s.rules.length, 0, "per-transaction only");
  }

  // ---- Zelle "Always" creates a recipient rule --------------------------------------------------------------
  {
    const z1 = row("Zelle payment to MIGUEL LOPEZ Conf# abc", 25000, "2026-10-10", { normalizedMerchant: "ZELLE PAYMENT TO MIGUEL LOPEZ" });
    const z2 = row("Zelle payment to MIGUEL LOPEZ Conf# def", 24000, "2026-09-10", { normalizedMerchant: "ZELLE PAYMENT TO MIGUEL LOPEZ" });
    const z3 = row("Zelle scheduled payment to MIGUEL LOPEZ Conf# ghi", 24500, "2026-08-10", { normalizedMerchant: "ZELLE SCHEDULED PAYMENT TO MIGUEL LOPEZ" });
    const s = new Mem([z1, z2, z3]);
    ok(await classifyManually(s, { txnId: z1.id, value: "cat:wages", always: true }));
    assert.equal(s.rules[0].key, "zelle:miguel-lopez:out");
    assert.ok(s.rules[0].confirmed && s.rules[0].source === "USER");
    assert.equal(s.get(z2.id).categoryId, catId("Wages and Benefits")); assert.equal(s.get(z3.id).categoryId, catId("Wages and Benefits"));
    const odd = row("Zelle payment to ANA RUIZ Conf# x", 1000, "2026-10-11", { normalizedMerchant: "ZELLE PAYMENT TO ANA RUIZ" });
    s.rows.push(odd);
    err(await classifyManually(s, { txnId: odd.id, value: "cat:payments", always: true }), /For Zelle payments a rule can only be/);
  }

  // ---- 5. locked months reject edits -------------------------------------------------------------------------
  {
    const lockedRow = row("MYSTERY", 1000, "2026-07-14");
    const s = new Mem([lockedRow], new Set(["2026-07"]));
    err(await classifyManually(s, { txnId: lockedRow.id, value: "cat:materials-and-supplies", always: false }), /locked/);
    err(await classifyManually(s, { txnId: lockedRow.id, value: "cat:materials-and-supplies", always: true }), /locked/);
    assert.equal(s.get(lockedRow.id).categorySource, "NONE"); assert.equal(s.rules.length, 0); assert.equal(s.audits.length, 0);
    // a late row (dated in a locked month, adjustment month open) is editable
    const late = row("LATE ONE", 2000, "2026-07-30", { isLate: true, adjustmentMonth: "2026-10" });
    s.rows.push(late);
    ok(await classifyManually(s, { txnId: late.id, value: "cat:materials-and-supplies", always: false }));
    // undo is refused if the month got locked since
    s.locked.add("2026-10");
    const t = row("X", 3000, "2026-10-03"); s.locked.delete("2026-10"); s.rows.push(t);
    ok(await classifyManually(s, { txnId: t.id, value: "cat:materials-and-supplies", always: false }));
    s.locked.add("2026-10");
    err(await undoLast(s), /locked/);
    assert.equal(s.get(t.id).categorySource, "MANUAL", "refused undo changes nothing");
  }

  // ---- 6. undo restores prior state --------------------------------------------------------------------------
  {
    const s0 = new Mem([]);
    err(await undoLast(s0), /Nothing to undo/);
    assert.equal(await describeUndo(s0), null);

    const seedRule: RuleDef = { id: "seed:x", name: "Seeded", pattern: "PAPER GOODS", matchType: "STARTS_WITH", target: "normalized", direction: "out", kind: "EXPENSE", categoryName: "Materials & Supplies", priority: 100, confirmed: false, source: "SEED" };
    const plain = row("PAPER GOODS CO", 3000, "2026-10-02", { normalizedMerchant: "PAPER GOODS CO", kind: "EXPENSE", categoryId: catId("Materials & Supplies"), categorySource: "RULE", ruleId: "rule1", reviewStatus: "AUTO", confirmed: false });
    const s = new Mem([plain], new Set(), [seedRule]);
    const before = JSON.stringify(s.get(plain.id));
    ok(await classifyManually(s, { txnId: plain.id, value: "cat:personal-misc", always: false }));
    assert.notEqual(JSON.stringify(s.get(plain.id)), before);
    assert.deepEqual(await describeUndo(s), { label: "PAPER GOODS CO → Personal: Misc" });
    ok(await undoLast(s));
    assert.equal(JSON.stringify(s.get(plain.id)), before, "exactly the prior state, including the unconfirmed rule attribution");
    assert.equal(await describeUndo(s), null, "the undo itself is not undoable");
    err(await undoLast(s), /Nothing to undo/);

    // undo of an "Always": the rule is switched off and the rows it classified go back
    const a = row("SCOOP SUPPLY", 5000, "2026-10-03", { normalizedMerchant: "SCOOP SUPPLY" });
    const b = row("SCOOP SUPPLY", 6000, "2026-09-03", { normalizedMerchant: "SCOOP SUPPLY" });
    const s2 = new Mem([a, b]);
    ok(await classifyManually(s2, { txnId: a.id, value: "cat:materials-and-supplies", always: true }));
    assert.equal(s2.get(b.id).categoryId, catId("Materials & Supplies"));
    ok(await undoLast(s2));
    assert.equal(s2.get(a.id).categorySource, "NONE"); assert.equal(s2.get(a.id).reviewStatus, "NEEDS_REVIEW");
    assert.equal(s2.get(b.id).reviewStatus, "NEEDS_REVIEW", "the other row is back in the queue");
    assert.equal(s2.get(b.id).categoryId, null);
    assert.equal(s2.rules[0].active, false);
    // undo of an Always that UPDATED an existing rule puts the old rule back
    const c = row("SCOOP SUPPLY", 1000, "2026-10-04", { normalizedMerchant: "SCOOP SUPPLY" });
    s2.rows.push(c);
    s2.rules[0].active = true; s2.rules[0].categoryId = catId("Materials & Supplies");
    ok(await classifyManually(s2, { txnId: c.id, value: "cat:repairs", always: true }));
    assert.equal(s2.rules[0].categoryId, catId("Repairs"));
    ok(await undoLast(s2));
    assert.equal(s2.rules[0].categoryId, catId("Materials & Supplies")); assert.equal(s2.rules[0].active, true);
  }

  // ---- 4. recipient labeling re-applies -----------------------------------------------------------------------
  {
    const mk = (d: string, c: number, name = "MIGUEL LOPEZ") => row(`Zelle payment to ${name} Conf# ${d}`, c, d, {});
    const p1 = mk("2026-10-02", 20000), p2 = mk("2026-09-02", 21000), p3 = mk("2026-08-02", 22000), lockedP = mk("2026-07-02", 23000);
    const manual = mk("2026-06-02", 24000); manual.categorySource = "MANUAL"; manual.kind = "OWNER_DRAW"; manual.reviewStatus = "REVIEWED"; manual.confirmed = true;
    const other = mk("2026-10-03", 9000, "ANA RUIZ");
    const s = new Mem([p1, p2, p3, lockedP, manual, other], new Set(["2026-07"]));
    const lockedBefore = JSON.stringify(s.get(lockedP.id));

    let r = ok(await labelRecipient(s, { name: "Miguel Lopez", label: "STAFF" }));
    assert.equal(r.reapplied.changed, 3);
    for (const t of [p1, p2, p3]) { assert.equal(s.get(t.id).kind, "EXPENSE"); assert.equal(s.get(t.id).categoryId, catId("Wages and Benefits")); assert.equal(s.get(t.id).reviewStatus, "AUTO"); assert.ok(s.get(t.id).confirmed); }
    assert.equal(JSON.stringify(s.get(lockedP.id)), lockedBefore); assert.equal(s.get(manual.id).kind, "OWNER_DRAW"); assert.equal(s.get(other.id).reviewStatus, "NEEDS_REVIEW");

    r = ok(await labelRecipient(s, { name: "Miguel Lopez", label: "FAMILY" }));
    assert.equal(s.get(p1.id).kind, "OWNER_DRAW"); assert.equal(s.get(p1.id).categoryId, "personal-misc", "family payments report under Personal: Misc");
    const inn = row("Zelle payment from MIGUEL LOPEZ Conf# z", -5000, "2026-10-12", { normalizedMerchant: "ZELLE PAYMENT FROM MIGUEL LOPEZ" }); s.rows.push(inn);
    await labelRecipient(s, { name: "Miguel Lopez", label: "FAMILY" });
    assert.equal(s.get(inn.id).kind, "OWNER_CONTRIBUTION");

    // Vendor needs a real P&L category
    err(await labelRecipient(s, { name: "Miguel Lopez", label: "VENDOR" }), /Pick a category/);
    err(await labelRecipient(s, { name: "Miguel Lopez", label: "VENDOR", vendorCategoryId: catId("Other Income") }), /Pick a category/);
    ok(await labelRecipient(s, { name: "Miguel Lopez", label: "VENDOR", vendorCategoryId: catId("Purchase") }));
    assert.equal(s.get(p1.id).categoryId, catId("Purchase"));
    assert.equal(s.get(inn.id).kind, "VENDOR_REFUND");

    // Staff after Family: the old inflow rule must not linger
    ok(await labelRecipient(s, { name: "Miguel Lopez", label: "STAFF" }));
    assert.equal(s.rules.find((x) => x.key === "zelle:miguel-lopez:in")!.active, false);
    assert.equal(s.get(inn.id).kind, "OTHER_INFLOW", "falls back to review");

    // Other = leave in review
    ok(await labelRecipient(s, { name: "Miguel Lopez", label: "OTHER" }));
    assert.equal(s.get(p1.id).reviewStatus, "NEEDS_REVIEW"); assert.equal(s.get(p1.id).kind, null);
    assert.ok(s.audits.some((a) => a.action === ACTIONS.recipient));
  }

  // ---- rules screen actions ------------------------------------------------------------------------------------
  {
    const seed: RuleDef = { id: "seed:paper", name: "Paper Goods", pattern: "PAPER GOODS", matchType: "STARTS_WITH", target: "normalized", direction: "out", kind: "EXPENSE", categoryName: "Materials & Supplies", priority: 100, confirmed: false, source: "SEED" };
    const t = row("PAPER GOODS CO", 3000, "2026-10-02", { normalizedMerchant: "PAPER GOODS CO" });
    const lockedT = row("PAPER GOODS CO", 3000, "2026-07-02", { normalizedMerchant: "PAPER GOODS CO" });
    const s = new Mem([t, lockedT], new Set(["2026-07"]), [seed]);
    await (await import("../src/lib/rules/apply")).applyRules(s, { all: true });
    assert.equal(s.get(t.id).confirmed, false, "starts unconfirmed");

    ok(await confirmRule(s, "rule1"));
    assert.equal(s.rules[0].confirmed, true); assert.equal(s.get(t.id).confirmed, true); assert.equal(s.get(t.id).reviewStatus, "AUTO");
    assert.equal(s.get(lockedT.id).confirmed, false, "locked month untouched");

    // changing a seed rule creates a USER override and switches the seed off (a re-seed must not undo it)
    const r = ok(await changeRule(s, "rule1", "cat:purchase"));
    assert.equal(s.rules.length, 2);
    assert.equal(s.rules[0].active, false);
    assert.ok(s.rules[1].key === "user:override:seed:paper" && s.rules[1].source === "USER" && s.rules[1].confirmed && s.rules[1].categoryId === catId("Purchase"));
    assert.equal(s.get(t.id).categoryId, catId("Purchase")); assert.equal(r.reapplied.changed, 1);
    // editing the override edits it in place
    ok(await changeRule(s, "rule2", "cat:repairs"));
    assert.equal(s.rules.length, 2); assert.equal(s.rules[1].categoryId, catId("Repairs"));
    err(await changeRule(s, "rule2", "cat:other-income"), /only applies|only for money/);
    err(await changeRule(s, "nope", "cat:purchase"), /wasn't found/);

    ok(await setRuleActive(s, "rule2", false));
    assert.equal(s.get(t.id).reviewStatus, "NEEDS_REVIEW", "disabling a rule sends its rows back to review");
    ok(await setRuleActive(s, "rule2", true));
    assert.equal(s.get(t.id).categoryId, catId("Repairs"));
    for (const a of ["rule.confirm", "rule.change", "rule.active"]) assert.ok(s.audits.some((x) => x.action === a), `${a} audited`);
  }

  // ---- list logic ---------------------------------------------------------------------------------------------------
  {
    const v = (id: string, date: string, cents: number, o: Partial<TxnView> = {}): TxnView => ({ id, date, month: date.slice(0, 7), amountCents: cents, direction: cents > 0 ? "out" : "in", merchant: id, raw: id, account: "BoA", accountId: "a1", hint: null, kind: null, categoryId: null, categoryName: null, categorySource: "NONE", reviewStatus: "NEEDS_REVIEW", confirmed: false, ruleName: null, locked: false, isCheck: false, ...o });
    const all = [v("a", "2026-10-02", 1000), v("b", "2026-10-09", 2000), v("c", "2026-09-30", -500), v("d", "2026-07-01", 900, { locked: true }), v("e", "2026-10-09", 700, { reviewStatus: "AUTO", confirmed: false, categorySource: "RULE", kind: "EXPENSE", categoryName: "Materials & Supplies", categoryId: "s" })];
    const q = reviewQueue(all);
    assert.deepEqual(q.map((t) => t.id), ["b", "a", "c"], "newest first; locked and classified rows excluded");
    assert.deepEqual(reviewQueue(all, "2026-10").map((t) => t.id), ["b", "a"], "months before `since` are out of scope");
    assert.deepEqual(monthCounts(q), [{ month: "2026-10", count: 2, cents: 3000 }, { month: "2026-09", count: 1, cents: 500 }]);
    const oct = q.filter((t) => t.month === "2026-10");
    assert.equal(pickNext(oct, null)?.id, "b"); assert.equal(pickNext(oct, "b")?.id, "a"); assert.equal(pickNext(oct, "a")?.id, "b", "wraps"); assert.equal(pickNext(oct, "gone")?.id, "b"); assert.equal(pickNext([], null), null);
    assert.deepEqual(reviewSummary(q, "2026-10", "2026"), { monthCount: 2, monthCents: 3000, yearCount: 3 });
    assert.deepEqual(filterTxns(all, { unconfirmed: true }).map((t) => t.id), ["e"]);
    assert.deepEqual(filterTxns(all, { needsReview: true, q: "A" }).map((t) => t.id), ["a"]);
    assert.deepEqual(filterTxns(all, { categoryId: "s" }).map((t) => t.id), ["e"]);
    assert.ok(byNewest(all[0], all[1]) > 0);
    assert.equal(prettyMerchant("ZELLE PAYMENT TO MIGUEL LOPEZ"), "Zelle Payment To Miguel Lopez");
    assert.equal(prettyMerchant("ATT BILL PAYMENT"), "Att Bill Payment");
    assert.equal(prettyPfc("FOOD_AND_DRINK", "FOOD_AND_DRINK_RESTAURANT"), "Food and drink · restaurant");
    assert.equal(prettyPfc(null, null), null);
  }

  void ALL_RULES;
  console.log("review: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
