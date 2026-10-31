import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CATEGORY_MAP, KIND_DEFAULT, RULE_MAP, keyOf, manualTarget, mapDef, ruleTarget } from "../src/lib/report/mapping";
import { TEMPLATE } from "../src/lib/report/template";
import { ALL_RULES } from "../src/lib/rules/all";
import { PLANNED_CATEGORY_CHANGES } from "../src/lib/rules/categories";
import { validateRule } from "../src/lib/rules/types";

const templateNames = new Set(TEMPLATE.map((c) => c.name));
const templateKeys = new Set(TEMPLATE.map((c) => c.key));

// every destination is a real template category
for (const [from, t] of Object.entries(CATEGORY_MAP)) assert.ok(templateNames.has(t.to), `CATEGORY_MAP "${from}" -> unknown template category "${t.to}"`);
for (const [key, t] of Object.entries(RULE_MAP)) assert.ok(templateNames.has(t.to), `RULE_MAP ${key} -> unknown template category "${t.to}"`);
for (const [kind, t] of Object.entries(KIND_DEFAULT)) if (t) assert.ok(templateNames.has(t.to), `KIND_DEFAULT ${kind} -> unknown "${t.to}"`);
for (const t of [...Object.values(CATEGORY_MAP), ...Object.values(RULE_MAP)]) assert.ok(templateKeys.has(keyOf(t.to)), `key for "${t.to}" exists`);

// every category the original seed ever created is accounted for, so nothing can fall through
const seedText = readFileSync("prisma/seed.ts", "utf8");
const block = seedText.slice(seedText.indexOf("const CATEGORIES"), seedText.indexOf("async function main"));
const legacy = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((n) => !["REVENUE", "COGS", "OPEX", "OTHER", "NON_PL"].includes(n));
assert.ok(legacy.length >= 30, `found the legacy category list (${legacy.length})`);
for (const n of legacy) assert.ok(n in CATEGORY_MAP, `legacy category "${n}" has a mapping`);
for (const r of PLANNED_CATEGORY_CHANGES.renames) assert.ok(r.from in CATEGORY_MAP, `pre-rename name "${r.from}" is mapped too`);

// the code-defined rules: after mapDef none points at a legacy category, the result is still a valid rule, and mapping twice is a no-op
const legacyOnly = new Set(Object.keys(CATEGORY_MAP).filter((n) => !templateNames.has(n)));
for (const def of ALL_RULES) {
  const m = mapDef(def);
  assert.ok(!m.categoryName || !legacyOnly.has(m.categoryName), `${def.id} still points at legacy "${m.categoryName}"`);
  assert.ok(!m.categoryName || templateNames.has(m.categoryName), `${def.id} -> "${m.categoryName}" is a template category`);
  assert.deepEqual(validateRule(m), [], `${def.id} stays a valid rule after mapping`);
  assert.deepEqual(mapDef(m), m, `${def.id}: mapDef is idempotent`);
  assert.equal(m.kind, def.kind, "mapping never changes what kind of money a rule is");
}
const byId = (id: string) => mapDef(ALL_RULES.find((r) => r.id === id)!);
assert.equal(byId("seed:owner-draw-3831").categoryName, "Other Transfers");
assert.equal(byId("seed:owner-draw-3831").kind, "OWNER_DRAW", "CHK 3831 moves stay owner draws; only their report line changes");
assert.equal(byId("seed:davo-sales-tax").categoryName, "Sales Tax");
assert.equal(byId("seed:firstlight-fcu").categoryName, "Payments");
assert.equal(byId("seed:firstlight-fcu").kind, "LOAN_PAYMENT", "the loan keeps its kind (cash notes), reports under Payments");
assert.equal(byId("seed:chase-card-payment").categoryName, "Payments");
assert.equal(byId("seed:transfer-between-boa").categoryName, "Other Transfers");
assert.equal(byId("user:wix:purchase").categoryName, "Other Expenses: Web Domain Expense");
assert.equal(byId("user:att:refund").categoryName, "Telephone: AT&T Internet");
assert.equal(byId("user:farmers-insurance:purchase").categoryName, "Dues & Subscriptions");
assert.equal(byId("user:homebase-subscription:purchase").categoryName, "Dues & Subscriptions");
assert.equal(byId("seed:clover-app").categoryName, "Dues & Subscriptions");
assert.equal(byId("seed:clover-fees").categoryName, "Bank Charges");
assert.equal(byId("seed:bankcard-discount").categoryName, "Bank Charges");
assert.equal(byId("user:overdraft-fee:purchase").categoryName, "Bank Charges");
assert.equal(byId("seed:chase-interest").categoryName, "Other Interest");
assert.equal(byId("seed:payroll-homebase").categoryName, "Wages and Benefits");
for (const id of ["seed:creamland:purchase", "seed:sj-mexican:purchase", "user:el-paso-produce:purchase", "user:alta-dena-dairy:refund"]) assert.equal(byId(id).categoryName, "Purchase", `${id}: produce and distributors and candy -> Purchase`);
for (const id of ["seed:walmart:purchase", "seed:webstaurant:refund"]) assert.equal(byId(id).categoryName, "Materials & Supplies");
assert.equal(byId("seed:clover-settlement").categoryName, undefined, "reconciliation kinds stay without a category");
assert.equal(byId("seed:cash-atm-deposit").categoryName, undefined);
assert.equal(byId("seed:checks-rent").categoryName, "Rent");
assert.equal(byId("seed:el-paso-electric:purchase").categoryName, "Utilities");

// stored rules and manual picks: the rules of the road
const legacySet = (n: string) => legacyOnly.has(n);
assert.equal(ruleTarget({ key: "user:always:x", kind: "EXPENSE", categoryName: "Supplies" }, legacySet)?.to, "Materials & Supplies");
assert.equal(ruleTarget({ key: "user:always:x", kind: "EXPENSE", categoryName: "Materials & Supplies" }, legacySet), null, "already a template category: a later decision, never moved");
assert.equal(ruleTarget({ key: "user:wix:purchase", kind: "EXPENSE", categoryName: "Purchase" }, legacySet), null, "a rule someone re-pointed after the template existed keeps their choice");
assert.equal(ruleTarget({ key: "zelle:x:out", kind: "EXPENSE", categoryName: "Wages" }, legacySet)?.to, "Wages and Benefits");
assert.equal(ruleTarget({ key: "user:always:z", kind: "OWNER_DRAW", categoryName: null }, legacySet)?.to, "Personal: Misc");
assert.equal(ruleTarget({ key: "seed:clover-settlement", kind: "CLOVER_SETTLEMENT", categoryName: null }, legacySet), null);
assert.equal(ruleTarget({ key: "user:always:unknown", kind: "EXPENSE", categoryName: "Not A Category" }, () => true), null, "an unknown legacy name is left alone, not guessed");

assert.equal(manualTarget({ kind: "EXPENSE", categoryName: "Wages" }, legacySet)?.to, "Wages and Benefits");
assert.equal(manualTarget({ kind: "EXPENSE", categoryName: "Dairy & ingredients" }, legacySet)?.to, "Purchase");
assert.equal(manualTarget({ kind: "VENDOR_REFUND", categoryName: "Payroll service fees" }, legacySet)?.to, "Dues & Subscriptions");
assert.equal(manualTarget({ kind: "OWNER_DRAW", categoryName: null }, legacySet)?.to, "Personal: Misc", "a Personal pick");
assert.equal(manualTarget({ kind: "OWNER_CONTRIBUTION", categoryName: null }, legacySet)?.to, "Personal: Misc");
assert.equal(manualTarget({ kind: "EXPENSE", categoryName: "Rent" }, legacySet), null, "Rent is already the template line");
assert.equal(manualTarget({ kind: "INTERNAL_TRANSFER", categoryName: null }, legacySet), null, "nothing to move");
// a manual pick is never moved by a merchant rule: manualTarget has no access to rule keys, only category and kind
assert.equal(manualTarget.length, 2);

console.log("mapping: all checks passed");
