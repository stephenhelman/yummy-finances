import type { Prisma } from "@/generated/prisma/client";
import type { MonthSnapshot } from "@/generated/prisma/client";
import { callAppsScript } from "@/lib/apps-script";
import { db } from "@/lib/db";
import { asReport, buildTestPayload, sendMonthlyReport } from "@/lib/report";
import { buildLiveReport } from "@/lib/report/load";
import type { CloseDeps, Snapshot } from "@/lib/report/close-month";
import { lockMonth, recordDelivery } from "@/lib/snapshots";

type Business = { id: string; name: string; timezone: string; salesTaxInRevenue: boolean; ownerEmail: string; ccEmail: string | null };

const toSnap = (s: MonthSnapshot): Snapshot => ({ month: s.month, status: s.status, dataJson: s.dataJson, emailSentAt: s.emailSentAt });

/** Wires the close/send orchestration to the database and the Apps Script mailer. */
export function prismaCloseDeps(business: Business, actor: string, now: () => Date = () => new Date()): CloseDeps {
  const find = (month: string) => db.monthSnapshot.findUnique({ where: { businessId_month: { businessId: business.id, month } } });
  return {
    now,
    timezone: business.timezone,
    liveReport: (month) => buildLiveReport(business, month),
    getSnapshot: async (month) => {
      const s = await find(month);
      return s ? toSnap(s) : null;
    },
    lock: async (month, report, inputsHash) => {
      const r = await lockMonth({ businessId: business.id, month, data: report as unknown as Prisma.InputJsonValue, inputsHash });
      return { snapshot: toSnap(r.snapshot), created: r.created };
    },
    send: async (snap) => {
      await sendMonthlyReport({ month: snap.month, status: "LOCKED", dataJson: snap.dataJson as never }, business);
    },
    recordSent: async (month, at) => {
      const s = await find(month);
      if (s) await recordDelivery(s.id, { emailSentAt: at });
    },
    sendTest: async (month, report) => {
      const stored = asReport(report);
      if (!stored) throw new Error("That month's report is in an older format");
      await callAppsScript({ type: "monthly_report", ...buildTestPayload(stored, business, month) });
    },
    audit: async (action, payload) => {
      await db.auditLog.create({ data: { businessId: business.id, actor, action, entity: "MonthSnapshot", payload: payload as Prisma.InputJsonValue } });
    },
  };
}
