import { db } from "@/lib/db";
import { monthBounds } from "@/lib/dates";
import { computeRevenue, type RevenueResult } from "@/lib/revenue";

/** Loads a month's Clover rows (by saleTime) and computes revenue. Read-only. */
export async function loadMonthRevenue(args: {
  businessId: string;
  timezone: string;
  month: string;
}): Promise<RevenueResult> {
  const { businessId, timezone, month } = args;
  const { start, end } = monthBounds(month, timezone);
  const where = { businessId, saleTime: { gte: start, lt: end } };
  const [payments, refunds] = await Promise.all([
    db.cloverPayment.findMany({
      where,
      select: { amountCents: true, taxCents: true, tipCents: true, isCash: true, tenderLabel: true, result: true, excluded: true, saleTime: true },
    }),
    db.cloverRefund.findMany({
      where,
      select: { amountCents: true, taxCents: true, isCash: true, tenderLabel: true, status: true, voided: true, saleTime: true },
    }),
  ]);
  return computeRevenue({ month, timezone, payments, refunds });
}
