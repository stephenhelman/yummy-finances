import { centsToDecimal } from "@/lib/money";
import { computeRatios, formatPct, RATIO_LABELS, type Ratios } from "@/lib/report/ratios";
import type { CashFacts, Report, ReportGroup, ReportLine } from "@/lib/report/pnl";

// The year-to-date table: the accountant's template, one column per month plus a YTD total. Pure. Each month comes from that
// month's Report (a locked month from its snapshot, an unlocked one computed live), so a column here is exactly that month's
// report, and the YTD column is the sum of the columns above it. Ratios are never summed: YTD ratios are YTD totals over YTD totals.

export type YearMonth = { month: string; status: "DRAFT" | "LOCKED"; report: Report };
export type YearColumn = { month: string; label: string; draft: boolean };
export type RowKind = "section" | "group" | "line" | "subtotal" | "total" | "net" | "memo" | "ratio";
/** `cells` are cents, or fractions for a ratio row (`pct`). null = nothing to show. */
export type YearRow = { key: string; label: string; kind: RowKind; indent: boolean; pct: boolean; computed: boolean; cells: (number | null)[]; total: number | null };
export type YearTable = { year: string; columns: YearColumn[]; rows: YearRow[]; cash: CashFacts; draftMonths: string[]; warnings: { month: string; text: string }[] };

type Flat = { key: string; label: string; kind: RowKind; indent: boolean; pct: boolean; computed: boolean; value: number | null };

const flat = (key: string, label: string, kind: RowKind, value: number | null, o: Partial<Flat> = {}): Flat => ({ key, label, kind, indent: false, pct: false, computed: false, value, ...o });

function lines(prefix: string, ls: readonly ReportLine[]): Flat[] {
  return ls.map((l) => flat(`${prefix}:${l.key}`, l.label, "line", l.cents, { indent: true, computed: !!l.computed }));
}

/** One Report as ordered rows, in the template's order. */
export function rowsOf(report: Report): Flat[] {
  const out: Flat[] = [];
  out.push(flat("sec:revenue", "Revenue", "section", null));
  for (const l of report.revenue.lines) {
    const deduction = l.key === "sales-returns" || l.key === "discounts";
    out.push(flat(`rev:${l.key}`, l.label, "line", deduction ? -l.cents : l.cents, { indent: true }));
  }
  out.push(flat("rev:gross", "Gross Revenue", "subtotal", report.revenue.grossRevenueCents));

  out.push(flat("sec:expenses", "Expenses", "section", null));
  const group = (g: ReportGroup, p: string) => {
    if (g.name) out.push(flat(`${p}grp:${g.name}`, g.name, "group", null));
    out.push(...lines(`${p}${g.name ?? "top"}`, g.lines));
    if (g.name) out.push(flat(`${p}sub:${g.name}`, `Total ${g.name}`, "subtotal", g.subtotalCents));
  };
  for (const g of report.expenses.groups.filter((x) => x.name === null)) group(g, "exp:");
  for (const g of report.expenses.groups.filter((x) => x.name !== null)) group(g, "exp:");
  out.push(flat("exp:total", "Total Expenses", "total", report.expenses.totalCents));
  out.push(flat("net", "Net Income", "net", report.netIncomeCents));

  out.push(flat("sec:below", "Not part of profit and loss", "section", null));
  for (const g of report.below.groups) group(g, "below:");
  out.push(flat("below:uncategorized", report.below.uncategorized.label, "total", report.below.uncategorized.cents, { computed: true }));

  out.push(flat("sec:ratios", "Ratios", "section", null));
  out.push(flat("ratio:netsales", "Net sales (after discounts and returns, before tax)", "memo", report.netSalesCents));
  for (const k of ["laborPct", "productPct", "primePct", "rentPct"] as const) out.push(flat(`ratio:${k}`, RATIO_LABELS[k], "ratio", report.ratios[k], { indent: true, pct: true }));
  return out;
}

/** Union of several ordered key lists that keeps each list's order: a key new to the union goes right after the key before it. */
export function mergeOrdered(lists: readonly (readonly Flat[])[]): Flat[] {
  const order: Flat[] = [];
  const at = new Map<string, number>();
  const insertAt = (i: number, f: Flat) => {
    order.splice(i, 0, f);
    at.clear();
    order.forEach((x, j) => at.set(x.key, j));
  };
  for (const list of lists) {
    let prev = -1;
    for (const f of list) {
      const known = at.get(f.key);
      if (known !== undefined) prev = known;
      else {
        insertAt(prev + 1, f);
        prev = prev + 1;
      }
    }
  }
  return order;
}

const SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const sum = (xs: readonly (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

export function buildYearTable(year: string, months: readonly YearMonth[]): YearTable {
  const columns: YearColumn[] = months.map((m) => ({ month: m.month, label: SHORT[Number(m.month.slice(5)) - 1], draft: m.status !== "LOCKED" }));
  const perMonth = months.map((m) => new Map(rowsOf(m.report).map((f) => [f.key, f.value])));
  const merged = mergeOrdered(months.map((m) => rowsOf(m.report)));

  const rows: YearRow[] = merged.map((f) => ({
    key: f.key, label: f.label, kind: f.kind, indent: f.indent, pct: f.pct, computed: f.computed,
    // a line a month doesn't have (an archived category with no money that month) is $0 there
    cells: perMonth.map((cells) => (f.kind === "section" || f.kind === "group" ? null : cells.has(f.key) ? cells.get(f.key)! : f.pct ? null : 0)),
    total: null,
  }));
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const r of rows) if (!r.pct && r.kind !== "section" && r.kind !== "group") r.total = sum(r.cells);

  // YTD ratios: YTD totals over YTD totals
  const t = (key: string) => byKey.get(key)?.total ?? 0;
  const ytd: Ratios = computeRatios({ netSalesCents: t("ratio:netsales"), laborCents: t("exp:top:wages"), productCents: t("exp:Sales/Food:purchase"), rentCents: t("exp:top:rent") });
  for (const k of ["laborPct", "productPct", "primePct", "rentPct"] as const) byKey.get(`ratio:${k}`)!.total = ytd[k];

  const cash = months.reduce<CashFacts>(
    (a, m) => {
      const c = m.report.cash;
      return {
        taxCollectedCents: a.taxCollectedCents + c.taxCollectedCents, taxRemittedCents: a.taxRemittedCents + c.taxRemittedCents, tipsCents: a.tipsCents + c.tipsCents,
        loanPaymentsCents: a.loanPaymentsCents + c.loanPaymentsCents, cashDepositedCents: a.cashDepositedCents + c.cashDepositedCents, cashCollectedCents: a.cashCollectedCents + c.cashCollectedCents,
        ownerDrawsCents: a.ownerDrawsCents + c.ownerDrawsCents, ownerContributionsCents: a.ownerContributionsCents + c.ownerContributionsCents,
      };
    },
    { taxCollectedCents: 0, taxRemittedCents: 0, tipsCents: 0, loanPaymentsCents: 0, cashDepositedCents: 0, cashCollectedCents: 0, ownerDrawsCents: 0, ownerContributionsCents: 0 },
  );
  return {
    year, columns, rows, cash,
    draftMonths: columns.filter((c) => c.draft).map((c) => c.month),
    warnings: months.flatMap((m) => m.report.warnings.map((text) => ({ month: m.month, text }))),
  };
}

// ---- trend chart data ---------------------------------------------------------------------------------------------

export type TrendSeries = { key: string; label: string; values: (number | null)[]; dotted?: boolean };

/** Net sales, total expenses and net income for the months so far, plus last year's net sales for all 12 months (Clover only). */
export function trendSeries(table: YearTable, lastYearNetSales: readonly number[] | null): { labels: string[]; series: TrendSeries[] } {
  const get = (key: string) => table.rows.find((r) => r.key === key)?.cells ?? [];
  const pad = (xs: readonly (number | null)[]) => SHORT.map((_, i) => xs[i] ?? null);
  const series: TrendSeries[] = [
    { key: "netSales", label: "Net sales", values: pad(get("ratio:netsales")) },
    { key: "expenses", label: "Total expenses", values: pad(get("exp:total")) },
    { key: "net", label: "Net income", values: pad(get("net")) },
  ];
  if (lastYearNetSales) series.push({ key: "lastYear", label: `Net sales ${Number(table.year) - 1}`, values: SHORT.map((_, i) => lastYearNetSales[i] ?? null), dotted: true });
  return { labels: [...SHORT], series };
}

// ---- CSV ------------------------------------------------------------------------------------------------------------

/** A spreadsheet treats a cell that starts with = + - @ as a formula: neutralize labels (numbers are written by us). */
const safe = (s: string) => (/^[=+\-@\t\r]/.test(s) ? `'${s}` : s);
const q = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCsv(table: YearTable): string {
  const head = ["Line", ...table.columns.map((c) => `${c.label} ${table.year}${c.draft ? " (draft)" : ""}`), `YTD ${table.year}`];
  const body = table.rows.map((r) => {
    const fmt = (v: number | null) => (v === null ? "" : r.pct ? formatPct(v) : centsToDecimal(v));
    const cells = r.kind === "section" || r.kind === "group" ? table.columns.map(() => "") : r.cells.map(fmt);
    return [safe(r.label), ...cells, r.kind === "section" || r.kind === "group" ? "" : fmt(r.total)];
  });
  const c = table.cash;
  const notes: string[][] = [
    [],
    [`Cash notes, ${table.year} year to date`],
    ["Sales tax collected", centsToDecimal(c.taxCollectedCents)], ["Sales tax remitted", centsToDecimal(c.taxRemittedCents)],
    ["Tips collected (passed through to staff)", centsToDecimal(c.tipsCents)], ["Loan payments", centsToDecimal(c.loanPaymentsCents)],
    ["Cash deposited", centsToDecimal(c.cashDepositedCents)], ["Cash collected in Clover", centsToDecimal(c.cashCollectedCents)],
    ["Owner draws", centsToDecimal(c.ownerDrawsCents)], ["Owner contributions", centsToDecimal(c.ownerContributionsCents)],
  ];
  return [head, ...body, ...notes].map((r) => r.map((x) => q(String(x))).join(",")).join("\r\n") + "\r\n";
}
