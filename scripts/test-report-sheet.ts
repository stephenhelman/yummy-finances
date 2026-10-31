// Runs apps-script/Code.gs (the real file) against an in-memory fake of the Sheets API to prove the month tab, the YTD tab and
// the section/subtotal/net layout come out as the accountant's template. No Google services involved.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildReport, type ReportCategory } from "../src/lib/report/pnl";
import { reportToPayload } from "../src/lib/report/payload";
import { GROUP_ORDER, TEMPLATE } from "../src/lib/report/template";
import { computeRevenue } from "../src/lib/revenue";

type Cell = string | number;
class FakeSheet {
  rows: Cell[][] = [];
  constructor(public name: string) {}
  clear() { this.rows = []; }
  getLastRow() { return this.rows.length; }
  getSheetId() { return 1; }
  getName() { return this.name; }
  getRange(r: number, c: number, nr = 1, nc = 1) {
    const rows = this.rows;
    const base: Record<string, unknown> = {
      setValues(v: Cell[][]) { v.forEach((row, i) => { rows[r - 1 + i] = rows[r - 1 + i] ?? []; row.forEach((x, j) => (rows[r - 1 + i][c - 1 + j] = x)); }); return this; },
      getValues() { return Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => rows[r - 1 + i]?.[c - 1 + j] ?? "")); },
    };
    const self: unknown = new Proxy(base, { get: (t, k: string) => (k in t ? t[k] : () => self) }); // every formatting call chains
    return self as never;
  }
  setColumnWidth() {} setHiddenGridlines() {} setFrozenRows() {} setFrozenColumns() {}
}
class FakeBook {
  sheets: FakeSheet[] = [];
  getSheets() { return this.sheets; }
  getSheetByName(n: string) { return this.sheets.find((s) => s.name === n) ?? null; }
  insertSheet(n: string, at?: number) { const s = new FakeSheet(n); if (at === 0) this.sheets.unshift(s); else this.sheets.push(s); return s; }
  deleteSheet(s: FakeSheet) { this.sheets = this.sheets.filter((x) => x !== s); }
}

const src = readFileSync("apps-script/Code.gs", "utf8");
const load = new Function("SpreadsheetApp", `${src}\nreturn { writeMonthTab_, rebuildYtd_ };`) as (s: unknown) => { writeMonthTab_: (...a: unknown[]) => FakeSheet; rebuildYtd_: (b: FakeBook) => void };
const api = load({ BorderStyle: { SOLID: 1 } });

const TZ = "America/Denver";
const groupSort = (g: string | null) => (g === null ? -1 : GROUP_ORDER.indexOf(g));
const cats: ReportCategory[] = TEMPLATE.map((c, i) => ({ id: c.key, key: c.key, name: c.name, groupName: c.group, groupSort: groupSort(c.group), treatment: c.treatment, showWhenZero: true, archived: false, sortOrder: i }));
const payment = (amount: number, tax: number) => ({ amountCents: amount, taxCents: tax, tipCents: 0, isCash: false, tenderLabel: "Credit Card", result: "SUCCESS", excluded: false, saleTime: new Date("2026-09-10T18:00:00Z") });
const mk = (month: string, sales: number, rent: number, wages = 0) =>
  buildReport({
    label: month, salesTaxInRevenue: false, discountsCents: 100, categories: cats,
    revenue: computeRevenue({ month, timezone: TZ, payments: [payment(sales + 80, 80)].map((p) => ({ ...p, saleTime: new Date(`${month}-10T18:00:00Z`) })), refunds: [] }),
    txns: [{ amountCents: rent, kind: "EXPENSE", categoryId: "rent", reviewStatus: "REVIEWED", normalizedMerchant: "R", raw: "R" }, ...(wages ? [{ amountCents: wages, kind: "EXPENSE" as const, categoryId: "wages", reviewStatus: "REVIEWED" as const, normalizedMerchant: "W", raw: "W" }] : [])],
  });

const book = new FakeBook();
for (const [month, sales, rent, wages] of [["2026-08", 10_000, 4_000, 3_000], ["2026-09", 12_000, 4_100, 6_000]] as const) {
  const report = mk(month, sales, rent, wages);
  const payload = reportToPayload(report);
  api.writeMonthTab_(book, month, "Yummy", { ...payload, year: 2026, month: Number(month.slice(5)) }, report.warnings, report.cashNotes);
}
api.rebuildYtd_(book);
const tab = book.getSheetByName("2026-09")!;
const labels = tab.rows.map((r) => String(r[0] ?? "").trim()).filter(Boolean);
const idx = (l: string) => labels.indexOf(l);

// the exact template order on the month tab
const expectedOrder = ["Revenue", "Total Revenue/Sales", "Less: Sales Returns", "Less: Discounts and Allowances", "Other Income", "Gross Revenue", "Expenses", "Wages and Benefits", "Rent", "Sales/Food", "Purchase", "Total Sales/Food", "Other Direct Selling", "Total Other Direct Selling", "Total Expenses", "Net Income", "Not part of profit and loss", "Other", "Payments", "Zelle (unclassified)", "Checks (unclassified)", "Total Other", "Personal", "Personal: Misc", "Total Personal", "Uncategorized"];
let at = -1;
for (const l of expectedOrder) { const i = labels.indexOf(l, at + 1); assert.ok(i > at, `"${l}" appears in order (after index ${at}) in: ${labels.join(" | ")}`); at = i; }
assert.ok(idx("Net Income") > idx("Total Expenses") && idx("Net Income") < idx("Not part of profit and loss"), "Net Income sits right under Total Expenses, above the non-P&L groups");
const amountOf = (t: FakeSheet, label: string) => Number(t.rows.find((r) => String(r[0]).trim() === label)?.[1]);
assert.equal(amountOf(tab, "Less: Discounts and Allowances"), -1, "deductions are negative so a column adds up");
assert.equal(amountOf(tab, "Rent"), 41);
assert.equal(amountOf(tab, "Gross Revenue"), (12_000 + 100 - 100) / 100);
assert.equal(amountOf(tab, "Net Income"), (12_000 - 4_100 - 6_000) / 100);

// YTD follows the same layout, one column per month plus a total
const ytd = book.getSheetByName("YTD Summary")!;
assert.deepEqual(ytd.rows[0], ["Yummy Finances YTD", "2026-08", "2026-09", "Total"]);
const yl = ytd.rows.map((r) => String(r[0]).trim()).filter(Boolean);
let y = -1;
for (const l of ["Revenue", "Total Revenue/Sales", "Gross Revenue", "Expenses", "Wages and Benefits", "Rent", "Sales/Food", "Total Sales/Food", "Total Expenses", "Net Income", "Not part of profit and loss", "Other", "Payments", "Total Other", "Personal", "Total Personal", "Uncategorized"]) { const i = yl.indexOf(l, y + 1); assert.ok(i > y, `YTD has "${l}" in order: ${yl.join(" | ")}`); y = i; }
const ytdRow = (label: string) => ytd.rows.find((r) => String(r[0]).trim() === label)!;
assert.deepEqual(ytdRow("Rent").slice(1), [40, 41, 81]);
assert.deepEqual(ytdRow("Net Income").slice(1), [(10_000 - 4_000 - 3_000) / 100, (12_000 - 4_100 - 6_000) / 100, 30 + 19]);
assert.ok(yl.indexOf("Net Income") < yl.indexOf("Not part of profit and loss"), "YTD keeps Net Income under Total Expenses");

// ratios: shown as percentages per month, and on the YTD tab recomputed from totals (never summed)
const pctOf = (t: FakeSheet, label: string) => t.rows.find((r) => String(r[0]).trim().startsWith(label));
assert.equal(Number(pctOf(tab, "Labor %")![1]), 0.5, "Sept labor % = wages 60 / net sales 120");
assert.equal(Number(pctOf(book.getSheetByName("2026-08")!, "Labor %")![1]), 0.3);
assert.equal(Number(pctOf(tab, "Rent %")![1]), 41 / 120);
assert.equal(Number(pctOf(tab, "Prime cost %")![1]), 0.5, "no Purchase this month: prime = labor");
assert.equal(Number(tab.rows.find((r) => String(r[0]).trim() === "Net sales")![1]), 120);
const yl2 = ytd.rows.map((r) => String(r[0]).trim());
for (const l of ["Ratios", "Net sales"]) assert.ok(yl2.includes(l), `YTD has "${l}"`);
const lab = ytd.rows.find((r) => String(r[0]).trim().startsWith("Labor %"))!;
assert.deepEqual(lab.slice(1, 3), [0.3, 0.5], "the month columns carry each month's ratio");
assert.equal(lab[3], (30 + 60) / (100 + 120), "the YTD total is total wages over total net sales, not 0.3 + 0.5 and not their average (0.4)");
assert.notEqual(lab[3], 0.4);
const rentRow = ytd.rows.find((r) => String(r[0]).trim().startsWith("Rent %"))!;
assert.equal(rentRow[3], (40 + 41) / 220);
assert.ok(yl2.indexOf("Ratios") > yl2.indexOf("Uncategorized"), "ratios come last, as on the Year page");

console.log("report sheet layout: all checks passed");
