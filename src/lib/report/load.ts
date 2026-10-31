import { db } from "@/lib/db";
import { monthBounds } from "@/lib/dates";
import { asReport } from "@/lib/report";
import { discountsForMonth } from "@/lib/report/discounts";
import { buildReport, type Report, type ReportCategory, type ReportTxn } from "@/lib/report/pnl";
import { loadMonthRevenue } from "@/lib/revenue-db";
import { requireClassification } from "@/lib/rules/readiness";
import type { Kind } from "@/lib/rules/types";
import { KINDS } from "@/lib/rules/types";

// Loads everything the P&L needs for one month and builds it. Read-only. A LOCKED month is served from its snapshot (the
// numbers that were sent), never recomputed.

const KIND_SET = new Set<string>(KINDS);
type Business = { id: string; timezone: string; salesTaxInRevenue: boolean };

export type LoadedReport = { report: Report; source: "live" | "snapshot"; status: "DRAFT" | "LOCKED" };

export async function loadReport(business: Business, month: string): Promise<LoadedReport> {
  await requireClassification(db, business.id);

  const snap = await db.monthSnapshot.findUnique({ where: { businessId_month: { businessId: business.id, month } } });
  if (snap?.status === "LOCKED") {
    const stored = asReport(snap.dataJson);
    if (stored) return { report: stored, source: "snapshot", status: "LOCKED" };
    // locked before this layout existed: fall through and show it live, labelled
  }

  const { start, end } = monthBounds(month, business.timezone);
  const civil = { gte: new Date(`${month}-01T00:00:00Z`), lt: nextMonth(month) };

  const [revenue, payments, categories, bank] = await Promise.all([
    loadMonthRevenue({ businessId: business.id, timezone: business.timezone, month }),
    db.cloverPayment.findMany({ where: { businessId: business.id, saleTime: { gte: start, lt: end } }, select: { orderId: true, amountCents: true, taxCents: true, result: true, excluded: true, saleTime: true } }),
    db.category.findMany({ where: { businessId: business.id }, include: { group: true } }),
    db.bankTransaction.findMany({
      where: {
        businessId: business.id, pending: false, removedAt: null, supersededAt: null, account: { included: true },
        // a row counts in its own month, unless it is a late row, which counts in the open month it was found in
        OR: [{ adjustmentMonth: month }, { date: civil, isLate: false }],
      },
      select: { amountCents: true, kind: true, categoryId: true, reviewStatus: true, normalizedMerchant: true, rawDescription: true },
    }),
  ]);

  const orderIds = [...new Set(payments.map((p) => p.orderId).filter((x): x is string => !!x))];
  const orders = new Map<string, { subtotalCents: number; hasDiscount: boolean }>();
  for (let i = 0; i < orderIds.length; i += 1000) {
    for (const o of await db.cloverOrder.findMany({ where: { businessId: business.id, cloverId: { in: orderIds.slice(i, i + 1000) } }, select: { cloverId: true, subtotalCents: true, hasDiscount: true } })) orders.set(o.cloverId, o);
  }
  const discounts = discountsForMonth({ month, timezone: business.timezone, orders, payments });

  const reportCats: ReportCategory[] = categories.map((c) => ({
    id: c.id, key: c.key, name: c.name, groupName: c.group?.name ?? null, groupSort: c.group?.sortOrder ?? -1, treatment: c.treatment,
    showWhenZero: c.showWhenZero, archived: c.archived, sortOrder: c.sortOrder,
  }));
  const txns: ReportTxn[] = bank.map((t) => ({
    amountCents: t.amountCents, kind: t.kind && KIND_SET.has(t.kind) ? (t.kind as Kind) : null, categoryId: t.categoryId, reviewStatus: t.reviewStatus, normalizedMerchant: t.normalizedMerchant, raw: t.rawDescription,
  }));

  const report = buildReport({
    label: month, revenue, discountsCents: discounts.discountCents, ordersMissing: discounts.ordersMissing, discountAnomalies: discounts.anomalies,
    categories: reportCats, txns, salesTaxInRevenue: business.salesTaxInRevenue,
  });
  return { report, source: "live", status: snap?.status === "LOCKED" ? "LOCKED" : "DRAFT" };
}

function nextMonth(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1));
}
