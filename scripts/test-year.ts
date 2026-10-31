import assert from "node:assert/strict";
import { formatWhole } from "../src/lib/money";
import { computeRatios, formatPct } from "../src/lib/report/ratios";
import { buildReport, type ReportCategory, type ReportTxn } from "../src/lib/report/pnl";
import { GROUP_ORDER, TEMPLATE } from "../src/lib/report/template";
import { buildYearTable, mergeOrdered, rowsOf, toCsv, trendSeries, type YearMonth } from "../src/lib/report/year";
import { computeRevenue } from "../src/lib/revenue";

const TZ = "America/Denver";
const groupSort = (g: string | null) => (g === null ? -1 : GROUP_ORDER.indexOf(g));
const CATS: ReportCategory[] = TEMPLATE.map((c, i) => ({ id: c.key, key: c.key, name: c.name, groupName: c.group, groupSort: groupSort(c.group), treatment: c.treatment, showWhenZero: true, archived: false, sortOrder: i }));

const payment = (month: string, amount: number, tax: number, tip = 0) => ({ amountCents: amount, taxCents: tax, tipCents: tip, isCash: false, tenderLabel: "Credit Card", result: "SUCCESS", excluded: false, saleTime: new Date(`${month}-10T18:00:00Z`) });
const tx = (cents: number, key: string, kind: ReportTxn["kind"] = "EXPENSE"): ReportTxn => ({ amountCents: cents, kind, categoryId: key, reviewStatus: "REVIEWED", normalizedMerchant: "X", raw: "X" });
const month = (m: string, status: "DRAFT" | "LOCKED", sales: number, txns: ReportTxn[], cats = CATS, extra: { discounts?: number; taxInRevenue?: boolean } = {}): YearMonth => ({
  month: m, status,
  report: buildReport({ label: m, categories: cats, txns, salesTaxInRevenue: extra.taxInRevenue ?? false, discountsCents: extra.discounts ?? 0, revenue: computeRevenue({ month: m, timezone: TZ, payments: [payment(m, sales + 80, 80, 100)], refunds: [] }) }),
});

// ---- ratios ---------------------------------------------------------------------------------------------------------
{
  assert.deepEqual(computeRatios({ netSalesCents: 10_000, laborCents: 3_000, productCents: 2_500, rentCents: 1_000 }), { laborPct: 0.3, productPct: 0.25, primePct: 0.55, rentPct: 0.1 });
  assert.deepEqual(computeRatios({ netSalesCents: 0, laborCents: 1, productCents: 1, rentCents: 1 }), { laborPct: null, productPct: null, primePct: null, rentPct: null }, "no divide by zero");
  assert.equal(computeRatios({ netSalesCents: -5, laborCents: 1, productCents: 1, rentCents: 1 }).primePct, null);
  assert.equal(formatPct(0.3141), "31.4%");
  assert.equal(formatPct(null), "-");
  assert.equal(formatWhole(-0), "$0");
  assert.equal(formatWhole(-49), "$0", "a few cents of a deduction is not -$0");
  assert.equal(formatWhole(-1_234_56), "-$1,235");
  assert.equal(formatWhole(100_050), "$1,001");
  const r = month("2026-01", "LOCKED", 10_000, [tx(3_000, "wages"), tx(2_500, "purchase"), tx(1_000, "rent")]).report;
  assert.equal(r.netSalesCents, 10_000, "net sales: after discounts and returns, before tax and tips");
  assert.deepEqual(r.ratios, { laborPct: 0.3, productPct: 0.25, primePct: 0.55, rentPct: 0.1 });
  // the same either way sales tax is shown
  const inc = month("2026-01", "LOCKED", 10_000, [tx(3_000, "wages"), tx(2_500, "purchase"), tx(1_000, "rent")], CATS, { taxInRevenue: true }).report;
  assert.equal(inc.netSalesCents, 10_000);
  assert.deepEqual(inc.ratios, r.ratios, "ratios don't move with the sales-tax setting");
  // discounts are already out of payments: net sales doesn't change with them
  assert.equal(month("2026-01", "LOCKED", 10_000, [], CATS, { discounts: 700 }).report.netSalesCents, 10_000);
}

// ---- the table --------------------------------------------------------------------------------------------------------
const jan = month("2026-01", "LOCKED", 10_000, [tx(3_000, "wages"), tx(2_500, "purchase"), tx(1_000, "rent"), tx(400, "bank-charges"), tx(900, "sales-tax", "SALES_TAX_REMITTANCE"), tx(700, "personal-misc", "OWNER_DRAW"), tx(-100, "personal-misc", "OWNER_CONTRIBUTION")]);
// February has an archived category that held money only that month: it must show in February and be $0 elsewhere
const archived = CATS.map((c) => (c.key === "printing" ? { ...c, archived: true } : c));
const feb = month("2026-02", "DRAFT", 20_000, [tx(6_000, "wages"), tx(5_000, "purchase"), tx(1_000, "rent"), tx(250, "printing")], archived);
const mar = month("2026-03", "DRAFT", 0, [tx(1_000, "rent")], archived);
const table = buildYearTable("2026", [jan, feb, mar]);
const row = (k: string) => table.rows.find((r) => r.key === k)!;

{
  assert.deepEqual(table.columns.map((c) => [c.label, c.draft]), [["Jan", false], ["Feb", true], ["Mar", true]], "unlocked months are marked draft");
  assert.deepEqual(table.draftMonths, ["2026-02", "2026-03"]);
  assert.equal(table.rows[0].label, "Revenue");
  // every template line is in the table, in the template's order, even at $0 in every month
  const labels = table.rows.map((r) => r.label);
  const at = (l: string) => labels.indexOf(l);
  for (const [a, b] of [["Total Revenue/Sales", "Gross Revenue"], ["Gross Revenue", "Wages and Benefits"], ["Wages and Benefits", "Rent"], ["Rent", "Sales/Food"], ["Purchase", "Total Sales/Food"], ["Total Sales/Food", "Other Direct Selling"], ["Total Other Direct Selling", "Total Expenses"], ["Total Expenses", "Net Income"], ["Net Income", "Not part of profit and loss"], ["Payments", "Personal: Misc"], ["Uncategorized", "Ratios"]]) assert.ok(at(a) >= 0 && at(b) > at(a), `"${a}" comes before "${b}"`);
  assert.equal(row("exp:Sales/Food:uniforms").total, 0, "an unused line shows $0 for the year");
  assert.deepEqual(row("exp:Sales/Food:uniforms").cells, [0, 0, 0]);
  // totals are the sum of the months
  assert.deepEqual(row("exp:top:wages").cells, [3_000, 6_000, 0]);
  assert.equal(row("exp:top:wages").total, 9_000);
  assert.equal(row("exp:top:rent").total, 3_000);
  assert.equal(row("exp:total").total, row("exp:total").cells.reduce((a, b) => a! + b!, 0));
  assert.equal(row("net").total, jan.report.netIncomeCents + feb.report.netIncomeCents + mar.report.netIncomeCents, "YTD Net Income = the sum of the months");
  assert.equal(row("rev:gross").total, jan.report.revenue.grossRevenueCents + feb.report.revenue.grossRevenueCents + mar.report.revenue.grossRevenueCents);
  assert.equal(row("exp:sub:Sales/Food").total, 2_500 + 400 + 5_000, "group subtotals add up too");
  // an archived category with history still shows, where it has money; $0 in the months it doesn't
  const printing = table.rows.find((r) => r.label === "Printing")!;
  assert.deepEqual(printing.cells, [0, 250, 0], "an archived line still shows the month it held money");
  assert.equal(printing.total, 250);
  assert.ok(table.rows.find((r) => r.label === "Printing" && r.cells[0] === 0), "and $0 in other months");
  // below the line and the unreviewed lines
  assert.equal(row("below:Other:payments").total, 0);
  assert.equal(table.rows.find((r) => r.label === "Sales Tax")!.total, 900);
  assert.equal(row("below:uncategorized").computed, true);
  // ratios: YTD is totals over totals, never the sum or average of the monthly percentages
  assert.deepEqual(row("ratio:laborPct").cells, [0.3, 0.3, null], "a month with no net sales has no ratio");
  assert.equal(row("ratio:netsales").total, 30_000);
  assert.equal(row("ratio:laborPct").total, 9_000 / 30_000);
  assert.equal(row("ratio:productPct").total, 7_500 / 30_000);
  assert.equal(row("ratio:primePct").total, 16_500 / 30_000);
  assert.equal(row("ratio:rentPct").total, 3_000 / 30_000);
  // cash notes
  assert.equal(table.cash.ownerDrawsCents, 700);
  assert.equal(table.cash.ownerContributionsCents, 100);
  assert.equal(table.cash.taxRemittedCents, 900);
  assert.equal(table.cash.taxCollectedCents, 80 * 3 - 0, "tax collected adds across months");
  assert.equal(table.cash.tipsCents, 300);
}

// ---- merging months that don't share every line ---------------------------------------------------------------------------
{
  const a = [{ key: "a" }, { key: "b" }, { key: "d" }].map((x) => ({ ...x, label: x.key, kind: "line" as const, indent: false, pct: false, computed: false, value: 0 }));
  const b = [{ key: "a" }, { key: "c" }, { key: "d" }, { key: "e" }].map((x) => ({ ...x, label: x.key, kind: "line" as const, indent: false, pct: false, computed: false, value: 0 }));
  const keys = mergeOrdered([a, b]).map((x) => x.key);
  assert.ok(keys.indexOf("a") < keys.indexOf("b") && keys.indexOf("b") < keys.indexOf("d") && keys.indexOf("a") < keys.indexOf("c") && keys.indexOf("c") < keys.indexOf("d") && keys.indexOf("d") < keys.indexOf("e"), `both orders are kept: ${keys.join(",")}`);
  assert.equal(new Set(keys).size, keys.length, "no duplicates");
  assert.equal(rowsOf(jan.report).length > 40, true);
}

// ---- trend ----------------------------------------------------------------------------------------------------------------
{
  const t = trendSeries(table, [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
  assert.equal(t.labels.length, 12);
  assert.deepEqual(t.series.map((s) => s.key), ["netSales", "expenses", "net", "lastYear"]);
  assert.deepEqual(t.series[0].values.slice(0, 4), [10_000, 20_000, 0, null], "this year stops at the last month so far");
  assert.equal(t.series[3].values.length, 12, "last year is the full twelve months");
  assert.equal(t.series[3].dotted, true);
  assert.equal(t.series[3].label, "Net sales 2025");
  assert.ok(!trendSeries(table, null).series.some((s) => s.key === "lastYear"), "no last-year line without last-year data");
  assert.ok(!t.series.some((s) => /last year/i.test(s.label) && s.key === "expenses"), "no expenses year over year");
}

// ---- CSV ------------------------------------------------------------------------------------------------------------------
{
  const csv = toCsv(table);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "Line,Jan 2026,Feb 2026 (draft),Mar 2026 (draft),YTD 2026");
  assert.ok(lines.includes("Net Income,"+[...row("net").cells, row("net").total].map((c) => (c! < 0 ? "-" : "") + Math.floor(Math.abs(c!) / 100) + "." + String(Math.abs(c!) % 100).padStart(2, "0")).join(",")), "amounts are plain decimals with cents");
  assert.ok(lines.some((l) => l.startsWith("Labor % (Wages and Benefits ÷ net sales),30.0%,30.0%,,30.0%")), "ratios are percentages; n/a is an empty cell");
  assert.ok(lines.some((l) => l.startsWith("Revenue,,,,")), "section rows are label only");
  assert.ok(csv.includes("Cash notes, 2026 year to date") || csv.includes('"Cash notes, 2026 year to date"'), "cash notes follow the table");
  assert.ok(csv.includes("Owner draws,7.00") && csv.includes("Owner contributions,1.00"));
  assert.equal(csv.split("\r\n").length, lines.length + 1, "CRLF line endings, trailing newline");
  // labels are untrusted: a formula-looking name is neutralized, commas and quotes are escaped
  const evil = CATS.map((c) => (c.key === "rent" ? { ...c, name: '=HYPERLINK("http://x","y"), rent' } : c));
  const t2 = buildYearTable("2026", [month("2026-01", "LOCKED", 100, [tx(100, "rent")], evil)]);
  const out = toCsv(t2);
  assert.ok(out.includes(`"'=HYPERLINK(""http://x"",""y""), rent"`), "formula neutralized and quoted");
  assert.ok(!/(^|\r\n)=/.test(out));
}

console.log("year: all checks passed");
