import { formatCents } from "@/lib/money";
import { normalizeDescriptor } from "@/lib/rules/normalize";
import type { Kind } from "@/lib/rules/types";
import type { RevenueResult } from "@/lib/revenue";
import { computeRatios, type Ratios } from "@/lib/report/ratios";
import { COMPUTED_LINES, DEFAULT_LINE_BY_KIND, GROUPS, KEY, type CategoryTreatment } from "@/lib/report/template";

// The accountant's P&L, built from data. Pure: the caller loads Clover revenue, discounts, categories and the month's
// bank transactions. Every non-archived category shows on every report, even at $0 (unless its showWhenZero is off).
//
//   Revenue   Total Sales (pre-discount, ex-tax unless salesTaxInRevenue) - Returns - Discounts + Other Income = Gross Revenue
//   Expenses  top-level lines, then each group with a subtotal; Total Expenses; Net Income (no gross-profit line)
//   Below     non-business groups (Other, Personal) with totals, plus what is still in the review queue
//
// Sales tax: false -> Total Sales excludes tax and Sales Tax stays below the line (cash notes show collected vs remitted).
// true -> Total Sales includes tax collected and Sales Tax is an expense line equal to the tax collected for the period,
// so Net Income is identical either way (the collected-vs-remitted gap is a liability, shown in the cash notes).

export type ReportCategory = {
  id: string;
  key: string | null;
  name: string;
  groupName: string | null;
  groupSort: number;
  treatment: CategoryTreatment;
  showWhenZero: boolean;
  archived: boolean;
  sortOrder: number;
};

export type ReportTxn = {
  amountCents: number; // Plaid sign: positive = money out
  kind: Kind | null;
  categoryId: string | null;
  reviewStatus: "NEEDS_REVIEW" | "AUTO" | "REVIEWED";
  normalizedMerchant: string | null;
  raw: string;
};

export type ReportInput = {
  label: string; // "2026-09" or "2026 year to date"
  revenue: RevenueResult;
  discountsCents: number;
  ordersMissing?: number;
  discountAnomalies?: number;
  categories: readonly ReportCategory[];
  txns: readonly ReportTxn[];
  salesTaxInRevenue: boolean;
};

export type ReportLine = { key: string; label: string; cents: number; categoryId?: string; count?: number; computed?: boolean };
export type ReportGroup = { name: string | null; lines: ReportLine[]; subtotalCents: number };

/** Money facts that sit beside the P&L (cash notes), as numbers so a year view can add them up. */
export type CashFacts = {
  taxCollectedCents: number; taxRemittedCents: number; tipsCents: number; loanPaymentsCents: number;
  cashDepositedCents: number; cashCollectedCents: number; ownerDrawsCents: number; ownerContributionsCents: number;
};

export type Report = {
  label: string;
  salesTaxInRevenue: boolean;
  /** After discounts and returns, before sales tax and tips, whatever the sales-tax setting. The denominator of every ratio. */
  netSalesCents: number;
  ratios: Ratios;
  cash: CashFacts;
  revenue: { lines: ReportLine[]; grossRevenueCents: number };
  expenses: { groups: ReportGroup[]; totalCents: number }; // the group with name null holds the top-level lines
  netIncomeCents: number;
  below: { groups: ReportGroup[]; uncategorized: ReportLine };
  cashNotes: string[];
  warnings: string[];
};

const ZELLE = /^ZELLE (SCHEDULED )?PAYMENT (TO|FROM)\b/;
const sum = (xs: readonly { cents: number }[]) => xs.reduce((a, l) => a + l.cents, 0);

type Bucket = { cents: number; count: number };
const bucket = (): Bucket => ({ cents: 0, count: 0 });
const add = (b: Bucket, cents: number) => { b.cents += cents; b.count++; };

export function buildReport(input: ReportInput): Report {
  const { revenue, salesTaxInRevenue } = input;
  const cats = [...input.categories].sort((a, b) => a.groupSort - b.groupSort || a.sortOrder - b.sortOrder);
  const byId = new Map(cats.map((c) => [c.id, c]));
  const byKey = new Map(cats.filter((c) => c.key).map((c) => [c.key!, c]));

  // ---- 1. where each bank transaction lands
  const perCat = new Map<string, Bucket>();
  const zelle = bucket(), checks = bucket(), uncategorized = bucket();
  const unreviewedInflows = bucket();
  const loan = bucket(), cashDeposits = bucket(), draws = bucket(), contributions = bucket();

  for (const t of input.txns) {
    if (t.kind === "CLOVER_SETTLEMENT") continue; // card revenue is counted from Clover; this is only reconciliation
    if (t.kind === "CASH_DEPOSIT") { add(cashDeposits, Math.abs(t.amountCents)); continue; }
    if (t.kind === "LOAN_PAYMENT") add(loan, Math.abs(t.amountCents));
    if (t.kind === "OWNER_DRAW") add(draws, Math.abs(t.amountCents));
    if (t.kind === "OWNER_CONTRIBUTION") add(contributions, Math.abs(t.amountCents));

    if (t.reviewStatus === "NEEDS_REVIEW") {
      const key = t.normalizedMerchant ?? normalizeDescriptor(t.raw);
      if (ZELLE.test(key)) add(zelle, t.amountCents);
      else if (key === "CHECK") add(checks, t.amountCents);
      else if (t.amountCents > 0) add(uncategorized, t.amountCents);
      else add(unreviewedInflows, -t.amountCents);
      continue;
    }

    let cat = t.categoryId ? byId.get(t.categoryId) : undefined;
    if (!cat && t.kind && DEFAULT_LINE_BY_KIND[t.kind]) cat = byKey.get(DEFAULT_LINE_BY_KIND[t.kind]!);
    if (!cat) {
      if (t.kind === "OTHER_INFLOW") add(unreviewedInflows, -t.amountCents); // reviewed as "some other deposit": not income, not a line
      else if (t.amountCents > 0) add(uncategorized, t.amountCents);
      continue;
    }
    add(perCat.get(cat.id) ?? perCat.set(cat.id, bucket()).get(cat.id)!, t.amountCents);
  }

  const amount = (c: ReportCategory) => {
    const raw = perCat.get(c.id)?.cents ?? 0;
    return c.treatment === "PNL_INCOME" ? -raw : raw; // income is money in (negative in Plaid sign)
  };
  const lineOf = (c: ReportCategory, cents: number): ReportLine => ({ key: c.key ?? c.id, label: c.name, cents, categoryId: c.id, count: perCat.get(c.id)?.count ?? 0 });
  const shown = (c: ReportCategory, cents: number) => cents !== 0 || (c.showWhenZero && !c.archived);

  // ---- 2. revenue
  const taxCollected = revenue.salesTaxCollected.total;
  const incomeCats = cats.filter((c) => c.treatment === "PNL_INCOME");
  const otherIncome = incomeCats.reduce((a, c) => a + amount(c), 0);
  const totalSales = revenue.grossSales.total + input.discountsCents + (salesTaxInRevenue ? revenue.taxOnPayments.total : 0);
  const returns = revenue.refunds.total + (salesTaxInRevenue ? revenue.taxOnRefunds.total : 0);
  const grossRevenue = totalSales - returns - input.discountsCents + otherIncome;
  const revenueLines: ReportLine[] = [
    { key: "total-sales", label: "Total Revenue/Sales", cents: totalSales },
    { key: "sales-returns", label: "Less: Sales Returns", cents: returns },
    { key: "discounts", label: "Less: Discounts and Allowances", cents: input.discountsCents },
    { key: "other-income", label: "Other Income", cents: otherIncome },
  ];

  // ---- 3. expenses
  const salesTaxCat = byKey.get(KEY.SALES_TAX);
  const expenseCats = cats.filter((c) => c.treatment === "PNL_EXPENSE" || (salesTaxInRevenue && c === salesTaxCat));
  const groups = new Map<string | null, ReportLine[]>();
  for (const c of expenseCats) {
    const cents = salesTaxInRevenue && c === salesTaxCat ? taxCollected : amount(c);
    if (!shown(c, cents)) continue;
    const g = c.groupName;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(lineOf(c, cents));
  }
  const groupSort = (name: string | null) => (name === null ? -1 : cats.find((c) => c.groupName === name)?.groupSort ?? 999);
  const expenseGroups: ReportGroup[] = [...groups.entries()]
    .sort((a, b) => groupSort(a[0]) - groupSort(b[0]))
    .map(([name, lines]) => ({ name, lines, subtotalCents: sum(lines) }));
  const totalExpenses = expenseGroups.reduce((a, g) => a + g.subtotalCents, 0);

  // ---- 4. below the P&L
  const belowCats = cats.filter((c) => (c.treatment === "NON_PL" || c.treatment === "PERSONAL") && !(salesTaxInRevenue && c === salesTaxCat));
  const below = new Map<string, ReportLine[]>();
  for (const c of belowCats) {
    const cents = amount(c);
    if (!shown(c, cents)) continue;
    const g = c.groupName ?? GROUPS.OTHER;
    (below.get(g) ?? below.set(g, []).get(g)!).push(lineOf(c, cents));
  }
  // what's still in the review queue shows under "Other", never as a pickable category
  const other = below.get(GROUPS.OTHER) ?? below.set(GROUPS.OTHER, []).get(GROUPS.OTHER)!;
  other.push({ key: "zelle-unclassified", label: COMPUTED_LINES.ZELLE, cents: zelle.cents, count: zelle.count, computed: true });
  other.push({ key: "checks-unclassified", label: COMPUTED_LINES.CHECKS, cents: checks.cents, count: checks.count, computed: true });
  const belowGroups: ReportGroup[] = [...below.entries()]
    .sort((a, b) => groupSort(a[0]) - groupSort(b[0]))
    .map(([name, lines]) => ({ name, lines, subtotalCents: sum(lines) }));

  // ---- 5. cash notes and warnings
  const remitted = salesTaxCat ? perCat.get(salesTaxCat.id)?.cents ?? 0 : 0;
  const cashNotes: string[] = [
    `Sales tax: collected ${formatCents(taxCollected)}, remitted ${formatCents(remitted)} (${taxCollected >= remitted ? "still owed" : "paid ahead"} ${formatCents(Math.abs(taxCollected - remitted))}).`,
    `Tips: ${formatCents(revenue.tips.total)} collected and passed through to staff (not revenue, not an expense).`,
  ];
  if (loan.count) cashNotes.push(`Loan payments: ${formatCents(loan.cents)} in ${loan.count} payment${loan.count === 1 ? "" : "s"}. Interest portion is deductible; the accountant needs the loan statement.`);
  const cashCollected = revenue.netSales.cash + revenue.salesTaxCollected.cash; // what was handed over, tax included, net of cash refunds
  cashNotes.push(`Cash: ${formatCents(cashDeposits.cents)} deposited vs ${formatCents(cashCollected)} cash collected in Clover (difference ${formatCents(cashCollected - cashDeposits.cents)}).`);

  const warnings = revenue.warnings.map((w) => w.message);
  const unreviewed = uncategorized.count + zelle.count + checks.count;
  if (unreviewed) warnings.push(`${formatCents(uncategorized.cents + zelle.cents + checks.cents)} in ${unreviewed} unreviewed bank transaction${unreviewed === 1 ? "" : "s"} is not in Net Income. Review ${unreviewed === 1 ? "it" : "them"} first.`);
  if (unreviewedInflows.count) warnings.push(`${formatCents(unreviewedInflows.cents)} in ${unreviewedInflows.count} unclassified deposit${unreviewedInflows.count === 1 ? "" : "s"} is not counted. Deposits are never revenue.`);
  if (input.ordersMissing) warnings.push(`${input.ordersMissing} paid order${input.ordersMissing === 1 ? "" : "s"} have no order detail yet, so Discounts may be understated. Run Sync now.`);
  if (input.discountAnomalies) warnings.push(`${input.discountAnomalies} order${input.discountAnomalies === 1 ? " was" : "s were"} paid more than ${input.discountAnomalies === 1 ? "its" : "their"} listed price; no discount was counted.`);

  const lineCents = (key: string) => [...expenseGroups.flatMap((g) => g.lines)].find((l) => l.key === key)?.cents ?? 0;
  const netSales = revenue.netSales.total;
  return {
    label: input.label,
    salesTaxInRevenue,
    netSalesCents: netSales,
    ratios: computeRatios({ netSalesCents: netSales, laborCents: lineCents(KEY.WAGES), productCents: lineCents("purchase"), rentCents: lineCents(KEY.RENT) }),
    cash: {
      taxCollectedCents: taxCollected, taxRemittedCents: remitted, tipsCents: revenue.tips.total, loanPaymentsCents: loan.cents,
      cashDepositedCents: cashDeposits.cents, cashCollectedCents: cashCollected, ownerDrawsCents: draws.cents, ownerContributionsCents: contributions.cents,
    },
    revenue: { lines: revenueLines, grossRevenueCents: grossRevenue },
    expenses: { groups: expenseGroups, totalCents: totalExpenses },
    netIncomeCents: grossRevenue - totalExpenses,
    below: { groups: belowGroups, uncategorized: { key: "uncategorized", label: COMPUTED_LINES.UNCATEGORIZED, cents: uncategorized.cents, count: uncategorized.count, computed: true } },
    cashNotes,
    warnings,
  };
}
