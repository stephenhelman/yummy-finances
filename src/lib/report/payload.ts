import type { MonthlyReportPayload } from "@/lib/apps-script";
import type { Report, ReportGroup, ReportLine } from "@/lib/report/pnl";

// Report -> the Apps Script "monthly_report" payload (Sheet tab, YTD tab and PDF all come from it, so they share this layout).
// Amounts are integer cents. Expense lines are positive; "Less:" lines are negative so a column adds up.

type Payload = Pick<MonthlyReportPayload, "sections" | "lines" | "netCents" | "netAfterSection" | "cashNotes" | "warnings">;

const slug = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "");

export function reportToPayload(report: Report): Payload {
  const sections: MonthlyReportPayload["sections"] = [];
  const lines: MonthlyReportPayload["lines"] = [];
  const push = (section: string, ls: readonly ReportLine[]) => ls.forEach((l) => lines.push({ section, label: l.label, cents: l.cents }));

  // Revenue: the two "Less:" lines are deductions.
  const rev = report.revenue.lines.map((l) => (l.key === "sales-returns" || l.key === "discounts" ? { ...l, cents: -l.cents } : l));
  sections.push({ key: "REVENUE", label: "Revenue", subtotalLabel: "Gross Revenue", subtotalCents: report.revenue.grossRevenueCents });
  push("REVENUE", rev);

  // Expenses: top-level lines (no group), then each group with its subtotal, then the grand total and Net Income.
  const groupKey = (g: ReportGroup) => `EXP_${slug(g.name ?? "")}`;
  for (const g of report.expenses.groups) {
    if (g.name === null) {
      sections.push({ key: "EXPENSES", label: "Expenses", subtotalCents: g.subtotalCents, noSubtotal: true });
      push("EXPENSES", g.lines);
    } else {
      sections.push({ key: groupKey(g), label: g.name, subtotalCents: g.subtotalCents });
      push(groupKey(g), g.lines);
    }
  }
  sections.push({ key: "TOTAL_EXPENSES", label: "Total Expenses", subtotalLabel: "Total Expenses", subtotalCents: report.expenses.totalCents, header: false });

  // Below the P&L: not part of Net Income, totals shown.
  sections.push({ key: "BELOW", label: "Not part of profit and loss", subtotalCents: 0, noSubtotal: true });
  for (const g of report.below.groups) {
    const key = `BELOW_${slug(g.name ?? "")}`;
    sections.push({ key, label: g.name ?? "Other", subtotalCents: g.subtotalCents });
    push(key, g.lines);
  }
  sections.push({ key: "UNCATEGORIZED", label: report.below.uncategorized.label, subtotalLabel: report.below.uncategorized.label, subtotalCents: report.below.uncategorized.cents, header: false });

  return { sections, lines, netCents: report.netIncomeCents, netAfterSection: "TOTAL_EXPENSES", cashNotes: report.cashNotes, warnings: report.warnings };
}
