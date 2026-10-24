import type { CloverObject } from "@/lib/clover/client";

// Pure mapping from Clover API objects to our row shapes. Semantics confirmed
// against live probe output:
//  - payment.amount == order.total: subtotal after discounts + tax. tipAmount is ON TOP
//    of amount and may be null (cash) -> 0.
//  - refund.amount includes tax; refunds have no tip field.
//  - Only result=SUCCESS payments count; other results are stored but excluded.
// No revenue math happens here.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

function cents(v: unknown, field: string, id: string, required: boolean): number {
  if (v === null || v === undefined) {
    if (required) throw new Error(`Clover ${id}: missing ${field}`);
    return 0;
  }
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`Clover ${id}: ${field} is not an integer (${String(v)})`);
  return v;
}

function time(v: unknown, field: string, id: string): Date {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`Clover ${id}: invalid ${field}`);
  return new Date(v); // epoch milliseconds
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** A device clock is trusted only if it is not in the future vs the server and within 45 days of it. */
export const MAX_OFFLINE_SKEW_MS = 45 * 86_400_000;

export type SaleTime = { saleTime: Date; saleTimeSource: "CLIENT" | "SERVER"; clientCreatedTime: Date | null };

/**
 * Sale date rule: clientCreatedTime (device time, i.e. when the sale happened)
 * when present AND <= createdTime AND createdTime - clientCreatedTime <= 45 days;
 * otherwise the server createdTime. All month assignment uses saleTime.
 */
export function resolveSaleTime(clientCreatedMs: unknown, createdTime: Date): SaleTime {
  const client =
    typeof clientCreatedMs === "number" && Number.isFinite(clientCreatedMs) && clientCreatedMs > 0
      ? new Date(clientCreatedMs)
      : null;
  if (client) {
    const lag = createdTime.getTime() - client.getTime();
    if (lag >= 0 && lag <= MAX_OFFLINE_SKEW_MS) {
      return { saleTime: client, saleTimeSource: "CLIENT", clientCreatedTime: client };
    }
  }
  return { saleTime: createdTime, saleTimeSource: "SERVER", clientCreatedTime: client };
}

export type TenderRow = { cloverId: string; label: string; labelKey: string | null; isCash: boolean };

export function isCashTender(label: string, labelKey: string | null): boolean {
  return label.trim().toLowerCase() === "cash" || labelKey === "com.clover.tender.cash";
}

export function mapTender(raw: CloverObject): TenderRow {
  const label = str(raw.label);
  if (!label) throw new Error(`Clover tender ${raw.id}: missing label`);
  const labelKey = str(raw.labelKey);
  return { cloverId: raw.id, label, labelKey, isCash: isCashTender(label, labelKey) };
}

export type PaymentRow = {
  cloverId: string;
  createdTime: Date;
  clientCreatedTime: Date | null;
  saleTime: Date;
  saleTimeSource: "CLIENT" | "SERVER";
  amountCents: number;
  taxCents: number;
  tipCents: number;
  result: string;
  orderId: string | null;
  tenderId: string | null;
  tenderLabel: string | null;
  isCash: boolean;
  excluded: boolean;
  raw: Obj;
};

export function mapPayment(raw: CloverObject, tenders: ReadonlyMap<string, TenderRow>): PaymentRow {
  const id = raw.id;
  const result = str(raw.result);
  if (!result) throw new Error(`Clover payment ${id}: missing result`);
  const order = isObj(raw.order) ? raw.order : null;
  const tender = isObj(raw.tender) ? raw.tender : null;
  const tenderId = str(tender?.id);
  const known = tenderId ? tenders.get(tenderId) : undefined;
  const createdTime = time(raw.createdTime, "createdTime", id);
  return {
    cloverId: id,
    createdTime,
    ...resolveSaleTime(raw.clientCreatedTime, createdTime),
    amountCents: cents(raw.amount, "amount", id, true),
    taxCents: cents(raw.taxAmount, "taxAmount", id, false),
    tipCents: cents(raw.tipAmount, "tipAmount", id, false), // null for cash -> 0
    result,
    orderId: str(order?.id),
    tenderId,
    tenderLabel: known?.label ?? null,
    isCash: known?.isCash ?? false,
    excluded: result !== "SUCCESS",
    // Trimmed on purpose: the embedded order carries customers and notes we don't store.
    raw: {
      id,
      amount: raw.amount ?? null,
      tipAmount: raw.tipAmount ?? null,
      taxAmount: raw.taxAmount ?? null,
      cashbackAmount: raw.cashbackAmount ?? null,
      cashTendered: raw.cashTendered ?? null,
      result,
      createdTime: raw.createdTime,
      clientCreatedTime: raw.clientCreatedTime ?? null,
      offline: raw.offline ?? null,
      tenderId,
      order: order
        ? { id: order.id, total: order.total ?? null, state: order.state ?? null, payType: order.payType ?? null, testMode: order.testMode ?? null, currency: order.currency ?? null }
        : null,
    },
  };
}

export type RefundRow = {
  cloverId: string;
  cloverPaymentId: string | null;
  tenderId: string | null;
  tenderLabel: string | null;
  isCash: boolean;
  createdTime: Date;
  clientCreatedTime: Date | null;
  saleTime: Date;
  saleTimeSource: "CLIENT" | "SERVER";
  amountCents: number;
  taxCents: number;
  tipCents: number;
  status: string;
  voided: boolean;
  raw: Obj;
};

export function mapRefund(raw: CloverObject, tenders: ReadonlyMap<string, TenderRow> = new Map()): RefundRow {
  const id = raw.id;
  const payment = isObj(raw.payment) ? raw.payment : null;
  const paymentTender = isObj(payment?.tender) ? payment.tender : null;
  const tenderId = str(paymentTender?.id);
  const known = tenderId ? tenders.get(tenderId) : undefined;
  const createdTime = time(raw.createdTime, "createdTime", id);
  const status = str(raw.status);
  if (!status) throw new Error(`Clover refund ${id}: missing status`);
  return {
    cloverId: id,
    cloverPaymentId: str(payment?.id),
    tenderId,
    tenderLabel: known?.label ?? null,
    isCash: known?.isCash ?? false,
    createdTime,
    ...resolveSaleTime(raw.clientCreatedTime, createdTime),
    amountCents: cents(raw.amount, "amount", id, true), // includes tax
    taxCents: cents(raw.taxAmount, "taxAmount", id, false),
    tipCents: 0, // refunds carry no tip field
    status,
    voided: raw.voided === true,
    raw: {
      id,
      amount: raw.amount,
      taxAmount: raw.taxAmount ?? null,
      createdTime: raw.createdTime,
      clientCreatedTime: raw.clientCreatedTime ?? null,
      status,
      voided: raw.voided ?? null,
      reason: raw.reason ?? null,
      payment: payment
        ? { id: payment.id, amount: payment.amount ?? null, tipAmount: payment.tipAmount ?? null, taxAmount: payment.taxAmount ?? null, result: payment.result ?? null, tenderId }
        : null,
    },
  };
}

/** Fields that decide whether an existing stored row needs an update. */
export const PAYMENT_COMPARE = ["amountCents", "taxCents", "tipCents", "result", "orderId", "tenderId", "tenderLabel", "isCash", "excluded", "clientCreatedTime", "saleTime", "saleTimeSource"] as const;
export const REFUND_COMPARE = ["cloverPaymentId", "tenderId", "tenderLabel", "isCash", "clientCreatedTime", "saleTime", "saleTimeSource", "amountCents", "taxCents", "tipCents", "status", "voided"] as const;

export function changed(existing: object, next: object, keys: readonly string[]): boolean {
  const a = existing as Record<string, unknown>;
  const b = next as Record<string, unknown>;
  const same = (x: unknown, y: unknown) => (x instanceof Date && y instanceof Date ? x.getTime() === y.getTime() : x === y);
  return keys.some((k) => !same(a[k], b[k]));
}
