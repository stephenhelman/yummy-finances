import type { MonthSnapshot } from "@/generated/prisma/client";
import { callAppsScript, type AppsScriptOptions, type MonthlyReportPayload } from "@/lib/apps-script";
import { reportToPayload } from "@/lib/report/payload";
import type { Report } from "@/lib/report/pnl";

type ReportBusiness = { name: string; ownerEmail: string; ccEmail: string | null };

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** A stored snapshot is the finished Report (src/lib/report/pnl.ts) as JSON. Null when it isn't one. */
export function asReport(json: unknown): Report | null {
  const r = json as Partial<Report> | null;
  if (!r || typeof r !== "object" || !r.revenue || !Array.isArray(r.revenue.lines) || !r.expenses || !Array.isArray(r.expenses.groups) || !r.below || !Array.isArray(r.below.groups) || !isInt(r.netIncomeCents)) return null;
  // snapshots written before these existed: fill what can be derived, zero the rest
  const full = r as Report;
  const total = full.revenue.lines.find((l) => l.key === "total-sales")?.cents ?? 0;
  const returns = full.revenue.lines.find((l) => l.key === "sales-returns")?.cents ?? 0;
  const disc = full.revenue.lines.find((l) => l.key === "discounts")?.cents ?? 0;
  full.netSalesCents ??= total - returns - disc;
  full.ratios ??= { laborPct: null, productPct: null, primePct: null, rentPct: null };
  full.cash ??= { taxCollectedCents: 0, taxRemittedCents: 0, tipsCents: 0, loanPaymentsCents: 0, cashDepositedCents: 0, cashCollectedCents: 0, ownerDrawsCents: 0, ownerContributionsCents: 0 };
  return full;
}

/** Maps a LOCKED snapshot to the Apps Script "monthly_report" payload. Throws on a draft or malformed data. */
export function buildMonthlyReportPayload(snapshot: Pick<MonthSnapshot, "month" | "status" | "dataJson">, business: ReportBusiness): MonthlyReportPayload {
  if (snapshot.status !== "LOCKED") throw new Error(`Month ${snapshot.month} is not locked; only locked months are reported`);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(snapshot.month);
  if (!m) throw new Error(`Invalid month: ${snapshot.month}`);

  const report = asReport(snapshot.dataJson);
  if (!report) throw new Error(`Snapshot ${snapshot.month} has no P&L report`);
  const payload = reportToPayload(report);
  for (const l of payload.lines) if (!isInt(l.cents) || typeof l.label !== "string") throw new Error(`Snapshot ${snapshot.month} has a malformed line in ${l.section}`);

  const recipients = [business.ownerEmail, business.ccEmail].filter((e): e is string => !!e);
  return { year: Number(m[1]), month: Number(m[2]), businessName: business.name, ...payload, recipients: [...new Set(recipients)] };
}

/** Sends a locked month's P&L through the Apps Script (sheet tab + YTD + PDF email). Idempotent per month on the script side. */
export async function sendMonthlyReport(
  snapshot: Pick<MonthSnapshot, "month" | "status" | "dataJson">,
  business: ReportBusiness,
  opts?: AppsScriptOptions,
): Promise<void> {
  await callAppsScript({ type: "monthly_report", ...buildMonthlyReportPayload(snapshot, business) }, opts);
}

/** A TEST payload for any report (live or locked): owner only, flagged so the script writes it to the TEST workbook and labels everything TEST. */
export function buildTestPayload(report: Report, business: ReportBusiness, month: string): MonthlyReportPayload {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  return { year: Number(m[1]), month: Number(m[2]), businessName: business.name, ...reportToPayload(report), recipients: [business.ownerEmail], test: true };
}
