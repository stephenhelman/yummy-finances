import assert from "node:assert/strict";
import { computeRevenue } from "../src/lib/revenue";
import { discountsForMonth, mapOrder, type DiscountPayment } from "../src/lib/report/discounts";
import { buildReport, type ReportCategory, type ReportTxn } from "../src/lib/report/pnl";
import { COMPUTED_LINES, DEFAULT_LINE_BY_KIND, GROUP_ORDER, KEY, TEMPLATE, deriveKind } from "../src/lib/report/template";
import { validateRule, type RuleDef } from "../src/lib/rules/types";

const TZ = "America/Denver";

// ---- template ---------------------------------------------------------------------------------------------------------
{
  const names = TEMPLATE.map((c) => c.name);
  assert.equal(new Set(names).size, names.length, "names are unique");
  assert.equal(new Set(TEMPLATE.map((c) => c.key)).size, TEMPLATE.length, "keys are unique");
  const expenseOrder = TEMPLATE.filter((c) => c.treatment === "PNL_EXPENSE").map((c) => c.name);
  assert.deepEqual(expenseOrder.slice(0, 5), ["Wages and Benefits", "Rent", "Purchase", "Materials & Supplies", "Other Interest"], "exact template order");
  assert.equal(expenseOrder.at(-1), "Telephone: AT&T Internet");
  assert.equal(TEMPLATE.filter((c) => c.group === "Sales/Food").length, 13);
  assert.equal(TEMPLATE.filter((c) => c.group === "Other Direct Selling").length, 15);
  assert.deepEqual(TEMPLATE.filter((c) => c.group === "Other").map((c) => c.name), ["Payments", "Donations", "Sales Tax", "Other Transfers"]);
  assert.deepEqual(TEMPLATE.filter((c) => c.group === "Personal").map((c) => c.name), ["Personal: Food", "Personal: Misc"]);
  assert.ok(!TEMPLATE.some((c) => /unclassified|Uncategorized/i.test(c.name)), "computed lines are not categories");
  assert.deepEqual(TEMPLATE.filter((c) => c.quickPick).sort((a, b) => a.quickPick! - b.quickPick!).map((c) => c.name), ["Personal: Misc", "Wages and Benefits", "Purchase", "Materials & Supplies", "Repairs"], "default quick picks");
  assert.deepEqual(GROUP_ORDER, ["Sales/Food", "Other Direct Selling", "Other", "Personal"]);
  assert.equal(TEMPLATE.filter((c) => c.treatment === "PNL_INCOME").length, 1);
  for (const c of TEMPLATE) if (c.treatment === "NON_PL") assert.ok(c.nonPlKind, `${c.name} has a kind`);
}

// ---- category -> kind ------------------------------------------------------------------------------------------------
{
  const cat = (key: string) => { const c = TEMPLATE.find((t) => t.key === key)!; return { name: c.name, treatment: c.treatment, nonPlKind: c.nonPlKind ?? null }; };
  const kind = (key: string, cents: number) => { const r = deriveKind(cat(key), cents); return r.ok ? r.kind : r.error; };
  assert.equal(kind("purchase", 5000), "EXPENSE");
  assert.equal(kind("purchase", -5000), "VENDOR_REFUND");
  assert.equal(kind(KEY.PERSONAL_MISC, 5000), "OWNER_DRAW");
  assert.equal(kind(KEY.PERSONAL_MISC, -5000), "OWNER_CONTRIBUTION");
  assert.equal(kind(KEY.PAYMENTS, 5000), "CARD_PAYMENT");
  assert.equal(kind(KEY.PAYMENTS, -5000), "CARD_PAYMENT");
  assert.equal(kind(KEY.OTHER_TRANSFERS, 5000), "INTERNAL_TRANSFER");
  assert.equal(kind(KEY.SALES_TAX, 5000), "SALES_TAX_REMITTANCE");
  assert.equal(kind(KEY.OTHER_INCOME, -5000), "OTHER_INCOME");
  assert.match(String(kind(KEY.OTHER_INCOME, 5000)), /only applies to money coming in/);
  assert.equal(kind(KEY.DONATIONS, 5000), "DONATION", "donations have their own kind, not owner draw");
  assert.match(String(kind(KEY.DONATIONS, -5000)), /only for money going out/);
  assert.equal(DEFAULT_LINE_BY_KIND.DONATION, KEY.DONATIONS);
  assert.match(JSON.stringify(deriveKind({ name: "X", treatment: "NON_PL", nonPlKind: null }, 100)), /no kind set/);
  assert.equal((deriveKind({ name: "Old", treatment: "PNL_EXPENSE", nonPlKind: null, archived: true }, 100) as { ok: false }).ok, false, "archived categories can't be picked");
  // a rule can never produce Other Income: no bank inflow becomes income automatically
  const rule: RuleDef = { id: "r", name: "n", pattern: "X", matchType: "EXACT", target: "normalized", direction: "in", kind: "OTHER_INCOME", priority: 1, confirmed: true, source: "USER" };
  assert.ok(validateRule(rule).some((e) => /never by a rule/.test(e)));
  assert.equal(DEFAULT_LINE_BY_KIND.LOAN_PAYMENT, KEY.PAYMENTS);
}

// ---- discounts ------------------------------------------------------------------------------------------------------------
{
  const line = (price: number, mods: number[] = [], discounts: object[] = []) => ({ id: "l", price, modifications: { elements: mods.map((amount) => ({ amount })) }, discounts: { elements: discounts } });
  const order = (lines: object[], discounts: object[] = [], extra: object = {}) => ({ id: "o1", createdTime: Date.parse("2026-09-10T18:00:00Z"), clientCreatedTime: Date.parse("2026-09-10T18:00:01Z"), testMode: false, lineItems: { elements: lines }, discounts: { elements: discounts }, ...extra });

  const o = mapOrder(order([line(500, [50, 25]), line(300)], [{ name: "Rewards", percentage: 5 }, { name: "Cash Discount", amount: -26 }]));
  assert.equal(o.subtotalCents, 875, "price + modifier amounts");
  assert.deepEqual(o.discountNames, ["Rewards 5%", "Cash Discount"]);
  assert.ok(o.hasDiscount);
  assert.ok(!mapOrder(order([line(100)])).hasDiscount);
  assert.deepEqual(mapOrder(order([line(100, [], [{ name: "Free item", percentage: 100 }])])).discountNames, ["Free item 100%"], "line-level discounts count");
  assert.equal(mapOrder(order([])).subtotalCents, 0);
  assert.throws(() => mapOrder({ id: "bad" } as never), /missing createdTime/);

  const pay = (orderId: string | null, amount: number, tax: number, iso: string, extra: Partial<DiscountPayment> = {}): DiscountPayment => ({ orderId, amountCents: amount, taxCents: tax, result: "SUCCESS", excluded: false, saleTime: new Date(iso), ...extra });
  const orders = new Map([
    ["a", { subtotalCents: 1000, hasDiscount: true }], // paid 900 before tax -> discount 100
    ["b", { subtotalCents: 700, hasDiscount: true }], // split tender: 300 + 300 before tax -> 100, counted once
    ["c", { subtotalCents: 500, hasDiscount: false }], // no discount objects: ignored even if the numbers differ
    ["d", { subtotalCents: 400, hasDiscount: true }], // paid MORE than listed: anomaly
    ["e", { subtotalCents: 800, hasDiscount: true }], // paid in October
  ]);
  const payments = [
    pay("a", 975, 75, "2026-09-05T18:00:00Z"),
    pay("b", 324, 24, "2026-09-06T18:00:00Z"), pay("b", 324, 24, "2026-09-06T18:05:00Z"),
    pay("c", 400, 0, "2026-09-07T18:00:00Z"),
    pay("d", 500, 0, "2026-09-08T18:00:00Z"),
    pay("e", 700, 0, "2026-10-02T18:00:00Z"),
    pay("zzz", 100, 0, "2026-09-09T18:00:00Z"), // no order detail stored
    pay("a", 999, 0, "2026-09-05T19:00:00Z", { result: "FAIL", excluded: true }), // failed retry: ignored
    pay(null, 100, 0, "2026-09-09T18:00:00Z"),
  ];
  const sep = discountsForMonth({ month: "2026-09", timezone: TZ, orders, payments });
  assert.deepEqual(sep, { discountCents: 100 + 100, discountedOrders: 2, ordersMissing: 1, anomalies: 1 });
  assert.equal(discountsForMonth({ month: "2026-10", timezone: TZ, orders, payments }).discountCents, 100, "by the payment's month");
  // idempotent / pure: same inputs, same answer
  assert.deepEqual(discountsForMonth({ month: "2026-09", timezone: TZ, orders, payments }), sep);
}

// ---- report ---------------------------------------------------------------------------------------------------------------
const groupSort = (g: string | null) => (g === null ? -1 : GROUP_ORDER.indexOf(g));
const CATS: ReportCategory[] = TEMPLATE.map((c, i) => ({ id: c.key, key: c.key, name: c.name, groupName: c.group, groupSort: groupSort(c.group), treatment: c.treatment, showWhenZero: true, archived: false, sortOrder: i }));

const payment = (amount: number, tax: number, cash = false, tip = 0) => ({ amountCents: amount, taxCents: tax, tipCents: tip, isCash: cash, tenderLabel: cash ? "Cash" : "Credit Card", result: "SUCCESS", excluded: false, saleTime: new Date("2026-09-10T18:00:00Z") });
const refund = (amount: number, tax: number) => ({ amountCents: amount, taxCents: tax, isCash: false, tenderLabel: "Credit Card", status: "SUCCESS", voided: false, saleTime: new Date("2026-09-12T18:00:00Z") });
// sales: card 10_825 (tax 825) + cash 5_413 (tax 413, tip 0) ; refund 1_082 (tax 82)
const revenue = computeRevenue({ month: "2026-09", timezone: TZ, payments: [payment(10_825, 825, false, 500), payment(5_413, 413, true)], refunds: [refund(1_082, 82)] });
assert.equal(revenue.grossSales.total, 10_000 + 5_000);
assert.equal(revenue.taxOnPayments.total, 1_238);
assert.equal(revenue.taxOnRefunds.total, 82);

const tx = (amountCents: number, key: string, extra: Partial<ReportTxn> = {}): ReportTxn => ({ amountCents, kind: "EXPENSE", categoryId: key, reviewStatus: "REVIEWED", normalizedMerchant: "X", raw: "X", ...extra });
const txns: ReportTxn[] = [
  tx(4_000, "purchase"), tx(-500, "purchase", { kind: "VENDOR_REFUND" }), // a vendor refund reduces the line
  tx(2_500, "wages"), tx(1_500, "rent"),
  tx(300, "bank-charges"), tx(700, "other-expenses-storage"),
  tx(1_000, "payments", { kind: "CARD_PAYMENT" }), tx(250, KEY.DONATIONS, { kind: "DONATION" }),
  tx(900, KEY.SALES_TAX, { kind: "SALES_TAX_REMITTANCE" }),
  tx(600, KEY.PERSONAL_MISC, { kind: "OWNER_DRAW" }), tx(-100, KEY.PERSONAL_MISC, { kind: "OWNER_CONTRIBUTION" }),
  tx(-800, KEY.OTHER_INCOME, { kind: "OTHER_INCOME" }),
  { amountCents: 2_000, kind: "INTERNAL_TRANSFER", categoryId: null, reviewStatus: "AUTO", normalizedMerchant: "TRANSFER", raw: "TRANSFER" }, // a pair match: no category
  { amountCents: -9_000, kind: "CLOVER_SETTLEMENT", categoryId: null, reviewStatus: "AUTO", normalizedMerchant: "CLOVER", raw: "CLOVER" }, // reconciliation only
  { amountCents: -3_000, kind: "CASH_DEPOSIT", categoryId: null, reviewStatus: "AUTO", normalizedMerchant: "DEPOSIT", raw: "DEPOSIT" },
  { amountCents: 5_000, kind: "LOAN_PAYMENT", categoryId: "payments", reviewStatus: "AUTO", normalizedMerchant: "FIRSTLIGHT", raw: "FIRSTLIGHT" },
  // the review queue
  { amountCents: 1_100, kind: null, categoryId: null, reviewStatus: "NEEDS_REVIEW", normalizedMerchant: "ZELLE PAYMENT TO ANA RUIZ", raw: "Zelle payment to ANA RUIZ" },
  { amountCents: -300, kind: "OTHER_INFLOW", categoryId: null, reviewStatus: "NEEDS_REVIEW", normalizedMerchant: "ZELLE PAYMENT FROM ANA RUIZ", raw: "x" },
  { amountCents: 430_000, kind: null, categoryId: null, reviewStatus: "NEEDS_REVIEW", normalizedMerchant: "CHECK", raw: "CHECK 1234" },
  { amountCents: 777, kind: null, categoryId: null, reviewStatus: "NEEDS_REVIEW", normalizedMerchant: "MYSTERY SHOP", raw: "MYSTERY SHOP" },
  { amountCents: -650, kind: "OTHER_INFLOW", categoryId: null, reviewStatus: "NEEDS_REVIEW", normalizedMerchant: "DEPOSIT 99", raw: "x" },
];
const base = { label: "2026-09", revenue, discountsCents: 400, categories: CATS, txns };
const lineOf = (r: ReturnType<typeof buildReport>, label: string) => [...r.expenses.groups, ...r.below.groups].flatMap((g) => g.lines).find((l) => l.label === label);

{
  const r = buildReport({ ...base, salesTaxInRevenue: false });
  // revenue
  assert.deepEqual(r.revenue.lines.map((l) => [l.label, l.cents]), [
    ["Total Revenue/Sales", 15_000 + 400], ["Less: Sales Returns", 1_000], ["Less: Discounts and Allowances", 400], ["Other Income", 800],
  ]);
  assert.equal(r.revenue.grossRevenueCents, 15_400 - 1_000 - 400 + 800);
  // expenses in template order, with group subtotals and the top-level lines first
  assert.deepEqual(r.expenses.groups.map((g) => g.name), [null, "Sales/Food", "Other Direct Selling"]);
  assert.deepEqual(r.expenses.groups[0].lines.map((l) => l.label), ["Wages and Benefits", "Rent"]);
  assert.equal(r.expenses.groups[1].lines.length, 13, "every Sales/Food line shows, even at $0");
  assert.equal(r.expenses.groups[2].lines.length, 15);
  assert.equal(lineOf(r, "Uniforms")!.cents, 0);
  assert.equal(lineOf(r, "Purchase")!.cents, 3_500, "vendor refund reduces it");
  assert.equal(lineOf(r, "Wages and Benefits")!.cents, 2_500);
  assert.equal(lineOf(r, "Other Expenses: STORAGE")!.cents, 700);
  assert.equal(r.expenses.groups[1].subtotalCents, 3_500 + 300);
  assert.equal(r.expenses.totalCents, 2_500 + 1_500 + 3_800 + 700);
  assert.equal(r.netIncomeCents, r.revenue.grossRevenueCents - r.expenses.totalCents, "no gross-profit line: net = gross revenue - total expenses");
  assert.ok(!lineOf(r, "Sales Tax") || r.below.groups.some((g) => g.lines.some((l) => l.label === "Sales Tax")), "sales tax stays below the line");
  // below the P&L
  const other = r.below.groups.find((g) => g.name === "Other")!;
  assert.deepEqual(other.lines.map((l) => l.label), ["Payments", "Donations", "Sales Tax", "Other Transfers", COMPUTED_LINES.ZELLE, COMPUTED_LINES.CHECKS]);
  assert.equal(other.lines.find((l) => l.label === "Payments")!.cents, 1_000 + 5_000, "card payments and the loan payment");
  assert.equal(other.lines.find((l) => l.label === "Other Transfers")!.cents, 2_000, "a pair match with no category reports under its kind's default line");
  assert.equal(other.lines.find((l) => l.label === "Donations")!.cents, 250);
  assert.equal(r.below.groups.find((g) => g.name === "Personal")!.lines.find((l) => l.label === "Personal: Misc")!.cents, 500, "donations do not inflate Personal (owner draw)");
  assert.equal(other.lines.find((l) => l.label === "Sales Tax")!.cents, 900);
  assert.equal(other.lines.find((l) => l.label === COMPUTED_LINES.ZELLE)!.cents, 1_100 - 300, "net of the unclassified Zelle rows, both directions");
  assert.equal(other.lines.find((l) => l.label === COMPUTED_LINES.CHECKS)!.cents, 430_000);
  assert.equal(r.below.uncategorized.cents, 777);
  assert.equal(r.below.uncategorized.count, 1);
  const personal = r.below.groups.find((g) => g.name === "Personal")!;
  assert.deepEqual(personal.lines.map((l) => [l.label, l.cents]), [["Personal: Food", 0], ["Personal: Misc", 500]]);
  // nothing from the review queue or the below-the-line groups leaks into Net Income
  assert.ok(!r.expenses.groups.flatMap((g) => g.lines).some((l) => l.computed));
  // Clover settlements and cash deposits never appear as a line or as revenue
  assert.ok(![...r.expenses.groups, ...r.below.groups].flatMap((g) => g.lines).some((l) => l.cents === 9_000 || l.cents === 3_000));
  // notes and warnings
  assert.match(r.cashNotes[0], /Sales tax: collected \$11\.56, remitted \$9\.00 \(still owed \$2\.56\)/); // 1238 - 82 collected
  assert.match(r.cashNotes[1], /Tips: \$5\.00/);
  assert.ok(r.cashNotes.some((n) => /Loan payments: \$50\.00 in 1 payment/.test(n) && /Interest portion/.test(n)));
  assert.ok(r.cashNotes.some((n) => /Cash: \$30\.00 deposited vs \$54\.13 cash collected/.test(n)));
  assert.ok(r.warnings.some((w) => /\$4,315\.77 in 4 unreviewed bank transactions is not in Net Income/.test(w)), r.warnings.join("|"));
  assert.ok(r.warnings.some((w) => /\$6\.50 in 1 unclassified deposit is not counted/.test(w)));
}

// sales tax in revenue: same net, Sales Tax becomes an expense line equal to tax collected
{
  const ex = buildReport({ ...base, salesTaxInRevenue: false });
  const inc = buildReport({ ...base, salesTaxInRevenue: true });
  assert.equal(inc.netIncomeCents, ex.netIncomeCents, "same net either way");
  assert.equal(inc.revenue.lines[0].cents, ex.revenue.lines[0].cents + 1_238, "Total Sales includes tax collected");
  assert.equal(inc.revenue.lines[1].cents, ex.revenue.lines[1].cents + 82, "returns include their tax");
  assert.equal(lineOf(inc, "Sales Tax")!.cents, 1_156, "expense line = tax collected for the period");
  assert.ok(inc.expenses.groups.some((g) => g.lines.some((l) => l.label === "Sales Tax")));
  assert.ok(!inc.below.groups.some((g) => g.lines.some((l) => l.label === "Sales Tax")), "no longer below the line");
  assert.equal(inc.expenses.totalCents, ex.expenses.totalCents + 1_156);
  assert.match(inc.cashNotes[0], /collected \$11\.56, remitted \$9\.00/, "cash notes still show collected vs remitted");
}

// showWhenZero / archived
{
  const cats = CATS.map((c) => (c.key === "uniforms" ? { ...c, showWhenZero: false } : c.key === "printing" ? { ...c, archived: true } : c.key === "travel" ? { ...c, archived: true } : c));
  const r = buildReport({ ...base, categories: cats, txns: [...txns, tx(1_234, "travel")], salesTaxInRevenue: false });
  assert.equal(lineOf(r, "Uniforms"), undefined, "showWhenZero off hides a $0 line");
  assert.equal(lineOf(r, "Printing"), undefined, "an archived $0 category is gone");
  assert.equal(lineOf(r, "Travel")!.cents, 1_234, "an archived category with history still shows, so old months stay right");
  const hidden = buildReport({ ...base, categories: cats.map((c) => (c.key === "uniforms" ? { ...c, showWhenZero: false } : c)), txns: [...txns, tx(50, "uniforms")], salesTaxInRevenue: false });
  assert.equal(lineOf(hidden, "Uniforms")!.cents, 50, "showWhenZero off still shows a non-zero line");
}

// empty month: the whole template still prints at $0
{
  const empty = computeRevenue({ month: "2026-02", timezone: TZ, payments: [], refunds: [] });
  const r = buildReport({ label: "2026-02", revenue: empty, discountsCents: 0, categories: CATS, txns: [], salesTaxInRevenue: false });
  assert.equal(r.netIncomeCents, 0);
  assert.equal(r.expenses.groups.flatMap((g) => g.lines).length, TEMPLATE.filter((c) => c.treatment === "PNL_EXPENSE").length);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.below.uncategorized.cents, 0);
}

// missing order detail is surfaced, never silent
{
  const r = buildReport({ ...base, ordersMissing: 3, discountAnomalies: 1, salesTaxInRevenue: false });
  assert.ok(r.warnings.some((w) => /3 paid orders have no order detail/.test(w)));
  assert.ok(r.warnings.some((w) => /1 order was paid more/.test(w)));
}

console.log("report: all checks passed");
