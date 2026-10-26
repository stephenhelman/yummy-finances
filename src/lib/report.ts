import type { MonthSnapshot } from "@/generated/prisma/client";
import { callAppsScript, type AppsScriptOptions, type MonthlyReportPayload } from "@/lib/apps-script";

/**
 * Shape this mapper expects in MonthSnapshot.dataJson. The P&L builder doesn't exist yet;
 * when it does, it should write this shape (or this type should be adjusted to match it).
 * All amounts are integer cents; expense lines are positive magnitudes, OTHER is signed (income positive).
 */
export type SnapshotData = {
  sections: {
    section: "REVENUE" | "COGS" | "OPEX" | "OTHER";
    lines: { name: string; cents: number }[];
  }[];
  cashNotes?: string[];
  warnings?: { code?: string; message: string }[];
};

type ReportBusiness = { name: string; ownerEmail: string; ccEmail: string | null };

const SECTION_LABEL = { REVENUE: "Revenue", COGS: "Cost of goods sold", OPEX: "Operating expenses", OTHER: "Other income / expense" } as const;
const SECTION_ORDER = ["REVENUE", "COGS", "OPEX", "OTHER"] as const;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** Maps a LOCKED snapshot to the Apps Script "monthly_report" payload. Throws on a draft or malformed data. */
export function buildMonthlyReportPayload(
  snapshot: Pick<MonthSnapshot, "month" | "status" | "dataJson">,
  business: ReportBusiness,
): MonthlyReportPayload {
  if (snapshot.status !== "LOCKED") throw new Error(`Month ${snapshot.month} is not locked; only locked months are reported`);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(snapshot.month);
  if (!m) throw new Error(`Invalid month: ${snapshot.month}`);

  const data = snapshot.dataJson as SnapshotData | null;
  if (!data || !Array.isArray(data.sections)) throw new Error(`Snapshot ${snapshot.month} has no P&L sections`);

  const bySection = new Map(data.sections.map((s) => [s.section, s]));
  const sections: MonthlyReportPayload["sections"] = [];
  const lines: MonthlyReportPayload["lines"] = [];
  const totals: Record<string, number> = {};
  for (const key of SECTION_ORDER) {
    const s = bySection.get(key);
    if (!s) continue;
    let subtotal = 0;
    for (const l of s.lines) {
      if (!isInt(l.cents) || typeof l.name !== "string") throw new Error(`Snapshot ${snapshot.month} has a malformed line in ${key}`);
      lines.push({ section: key, label: l.name, cents: l.cents });
      subtotal += l.cents;
    }
    sections.push({ key, label: SECTION_LABEL[key], subtotalCents: subtotal });
    totals[key] = subtotal;
  }
  if (!sections.length) throw new Error(`Snapshot ${snapshot.month} has no recognised P&L sections`);

  const recipients = [business.ownerEmail, business.ccEmail].filter((e): e is string => !!e);
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    businessName: business.name,
    sections,
    lines,
    netCents: (totals.REVENUE ?? 0) - (totals.COGS ?? 0) - (totals.OPEX ?? 0) + (totals.OTHER ?? 0),
    cashNotes: data.cashNotes ?? [],
    warnings: (data.warnings ?? []).map((w) => w.message),
    recipients: [...new Set(recipients)],
  };
}

/** Sends a locked month's P&L through the Apps Script (sheet tab + YTD + PDF email). Idempotent per month on the script side. */
export async function sendMonthlyReport(
  snapshot: Pick<MonthSnapshot, "month" | "status" | "dataJson">,
  business: ReportBusiness,
  opts?: AppsScriptOptions,
): Promise<void> {
  await callAppsScript({ type: "monthly_report", ...buildMonthlyReportPayload(snapshot, business) }, opts);
}
