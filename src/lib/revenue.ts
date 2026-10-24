import { monthBounds } from "@/lib/dates";

// Pure revenue math over Clover rows. All money is integer cents. Rules:
//  - Payments count only if result = SUCCESS and not excluded; refunds only if
//    status = SUCCESS and not voided.
//  - Month membership is by saleTime in the business timezone (a refund reduces the
//    month it was issued, whatever month the original sale was in).
//  - payment.amount = subtotal after discounts + tax; tipAmount is on top (pass-through).
//    refund.amount includes tax; refunds carry no tip.

export const HIGH_TAX_RATE_THRESHOLD = 0.085;

export type RevenuePayment = {
  amountCents: number;
  taxCents: number;
  tipCents: number;
  isCash: boolean;
  tenderLabel: string | null;
  result: string;
  excluded: boolean;
  saleTime: Date;
};

export type RevenueRefund = {
  amountCents: number;
  taxCents: number;
  isCash: boolean;
  tenderLabel: string | null;
  status: string;
  voided: boolean;
  saleTime: Date;
};

export type Split = { total: number; card: number; cash: number };

export type RevenueWarning = {
  code: "HIGH_EFFECTIVE_TAX_RATE" | "UNKNOWN_TENDER";
  message: string;
};

export type RevenueResult = {
  month: string;
  timezone: string;
  startUtc: string;
  endUtc: string;
  grossSales: Split; // Σ(payment.amount − payment.tax)
  refunds: Split; // Σ(refund.amount − refund.tax)
  netSales: Split; // grossSales − refunds
  salesTaxCollected: Split; // memo: Σ payment tax − Σ refund tax
  tips: Split; // memo: pass-through to staff, not revenue
  counts: { payments: Split; refunds: Split };
  ignored: { payments: number; refunds: number; outsideMonth: number };
  effectiveTaxRate: number | null; // salesTaxCollected / netSales; null when netSales <= 0
  warnings: RevenueWarning[];
};

const zero = (): Split => ({ total: 0, card: 0, cash: 0 });

function add(s: Split, isCash: boolean, cents: number): void {
  s.total += cents;
  if (isCash) s.cash += cents;
  else s.card += cents;
}

const sub = (a: Split, b: Split): Split => ({ total: a.total - b.total, card: a.card - b.card, cash: a.cash - b.cash });

export function computeRevenue(args: {
  month: string;
  timezone: string;
  payments: readonly RevenuePayment[];
  refunds: readonly RevenueRefund[];
}): RevenueResult {
  const { month, timezone } = args;
  const { start, end } = monthBounds(month, timezone);
  const inMonth = (d: Date) => d >= start && d < end;

  const gross = zero(), refundNet = zero(), taxIn = zero(), taxOut = zero(), tips = zero();
  const payCount = zero(), refCount = zero();
  const ignored = { payments: 0, refunds: 0, outsideMonth: 0 };
  let unknownTender = 0;

  for (const p of args.payments) {
    if (!inMonth(p.saleTime)) { ignored.outsideMonth++; continue; }
    if (p.result !== "SUCCESS" || p.excluded) { ignored.payments++; continue; }
    if (!p.tenderLabel) unknownTender++;
    add(gross, p.isCash, p.amountCents - p.taxCents);
    add(taxIn, p.isCash, p.taxCents);
    add(tips, p.isCash, p.tipCents);
    add(payCount, p.isCash, 1);
  }
  for (const r of args.refunds) {
    if (!inMonth(r.saleTime)) { ignored.outsideMonth++; continue; }
    if (r.status !== "SUCCESS" || r.voided) { ignored.refunds++; continue; }
    if (!r.tenderLabel) unknownTender++;
    add(refundNet, r.isCash, r.amountCents - r.taxCents);
    add(taxOut, r.isCash, r.taxCents);
    add(refCount, r.isCash, 1);
  }

  const netSales = sub(gross, refundNet);
  const salesTaxCollected = sub(taxIn, taxOut);
  const effectiveTaxRate = netSales.total > 0 ? salesTaxCollected.total / netSales.total : null;

  const warnings: RevenueWarning[] = [];
  if (effectiveTaxRate !== null && effectiveTaxRate > HIGH_TAX_RATE_THRESHOLD) {
    warnings.push({
      code: "HIGH_EFFECTIVE_TAX_RATE",
      message: `Effective sales tax rate is ${(effectiveTaxRate * 100).toFixed(2)}%, above ${(HIGH_TAX_RATE_THRESHOLD * 100).toFixed(1)}%. Check tax settings or how tax is recorded in Clover.`,
    });
  }
  if (unknownTender > 0) {
    warnings.push({
      code: "UNKNOWN_TENDER",
      message: `${unknownTender} counted row(s) have an unknown tender and were treated as card.`,
    });
  }

  return {
    month,
    timezone,
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    grossSales: gross,
    refunds: refundNet,
    netSales,
    salesTaxCollected,
    tips,
    counts: { payments: payCount, refunds: refCount },
    ignored,
    effectiveTaxRate,
    warnings,
  };
}
