import type { CloverObject } from "@/lib/clover/client";
import { monthBounds } from "@/lib/dates";

// Clover discounts. Verified on live data (scripts/clover-discount-probe.ts): an order's pre-discount subtotal is
// Σ(line price + modifier amounts) and equals what was paid before tax on every undiscounted order (1345 of 1345).
// Percentage discounts carry no dollar amount and stack additively, and line-level ones don't reconcile from their
// objects, so the discount is NOT read from the discount objects: it is the subtotal minus what the order's SUCCESS
// payments paid before tax. That is exact whatever mix of discounts was used, and ties to the payments by construction.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const elements = (v: unknown): Obj[] => (isObj(v) && Array.isArray(v.elements) ? v.elements.filter(isObj) : []);
const int = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

export type OrderRow = {
  cloverId: string;
  createdTime: Date;
  clientCreatedTime: Date | null;
  subtotalCents: number;
  hasDiscount: boolean;
  discountNames: string[]; // "Cash Discount", "Rewards 5%": names and percentages only, nothing about customers
  testMode: boolean;
};

/** A fetched order (expand=discounts,lineItems,lineItems.discounts,lineItems.modifications) -> the row we store. */
export function mapOrder(raw: CloverObject): OrderRow {
  const lines = elements(raw.lineItems);
  const names = [...elements(raw.discounts), ...lines.flatMap((l) => elements(l.discounts))].map((d) => {
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : "Discount";
    return typeof d.percentage === "number" ? `${name} ${d.percentage}%` : name;
  });
  const created = typeof raw.createdTime === "number" ? new Date(raw.createdTime) : null;
  if (!created || Number.isNaN(created.getTime())) throw new Error(`Clover order ${raw.id}: missing createdTime`);
  const client = typeof raw.clientCreatedTime === "number" && raw.clientCreatedTime > 0 ? new Date(raw.clientCreatedTime) : null;
  return {
    cloverId: raw.id,
    createdTime: created,
    clientCreatedTime: client,
    subtotalCents: lines.reduce((a, l) => a + int(l.price) + elements(l.modifications).reduce((m, x) => m + int(x.amount), 0), 0),
    hasDiscount: names.length > 0,
    discountNames: [...new Set(names)],
    testMode: raw.testMode === true,
  };
}

export type DiscountPayment = { orderId: string | null; amountCents: number; taxCents: number; result: string; excluded: boolean; saleTime: Date };

export type DiscountResult = {
  discountCents: number;
  discountedOrders: number;
  /** Paid orders in the period with no stored order detail: discounts may be understated until the next sync. */
  ordersMissing: number;
  /** Discounted orders whose payments paid MORE than the subtotal (counted as no discount). */
  anomalies: number;
};

/**
 * Discounts for a month. An order counts in the month of its earliest SUCCESS payment (the same saleTime that puts the
 * payment into Total Sales), once, however many tenders paid it.
 */
export function discountsForMonth(args: {
  month: string;
  timezone: string;
  orders: ReadonlyMap<string, Pick<OrderRow, "subtotalCents" | "hasDiscount">>;
  payments: readonly DiscountPayment[];
}): DiscountResult {
  const { start, end } = monthBounds(args.month, args.timezone);
  const byOrder = new Map<string, DiscountPayment[]>();
  for (const p of args.payments) {
    if (!p.orderId || p.result !== "SUCCESS" || p.excluded) continue;
    (byOrder.get(p.orderId) ?? byOrder.set(p.orderId, []).get(p.orderId)!).push(p);
  }
  const out: DiscountResult = { discountCents: 0, discountedOrders: 0, ordersMissing: 0, anomalies: 0 };
  for (const [orderId, pays] of byOrder) {
    const first = pays.reduce((a, p) => (p.saleTime < a ? p.saleTime : a), pays[0].saleTime);
    if (first < start || first >= end) continue;
    const order = args.orders.get(orderId);
    if (!order) {
      out.ordersMissing++;
      continue;
    }
    if (!order.hasDiscount) continue;
    const paidBeforeTax = pays.reduce((a, p) => a + p.amountCents - p.taxCents, 0);
    const d = order.subtotalCents - paidBeforeTax;
    if (d < 0) out.anomalies++;
    else if (d > 0) {
      out.discountCents += d;
      out.discountedOrders++;
    }
  }
  return out;
}
