import assert from "node:assert/strict";
import type { CloverObject } from "../src/lib/clover/client";
import { mapPayment, mapRefund, mapTender } from "../src/lib/clover/map";
import { HIGH_TAX_RATE_THRESHOLD, computeRevenue } from "../src/lib/revenue";

const TZ = "America/Denver";
const SEP = "2026-09";
const t = (iso: string) => Date.parse(iso);
const tenders = new Map(
  [
    { id: "T_CASH", label: "Cash", labelKey: "com.clover.tender.cash" },
    { id: "T_CREDIT", label: "Credit Card" },
    { id: "T_DEBIT", label: "Debit Card" },
  ].map((x) => mapTender(x as CloverObject)).map((x) => [x.cloverId, x]),
);

// Raw Clover-shaped fixtures -> mapped rows -> calculator (exercises mapping + math together)
let n = 0;
const pay = (o: Record<string, unknown>) =>
  mapPayment(
    { id: `P${++n}`, order: { id: `O${n}` }, tender: { id: "T_CREDIT" }, amount: 1000, taxAmount: 0, tipAmount: 0, result: "SUCCESS", createdTime: t("2026-09-15T18:00:00Z"), clientCreatedTime: t("2026-09-15T18:00:00Z"), ...o } as CloverObject,
    tenders,
  );
const refund = (o: Record<string, unknown>) =>
  mapRefund(
    { id: `R${++n}`, amount: 100, taxAmount: 0, status: "SUCCESS", voided: false, createdTime: t("2026-09-16T18:00:00Z"), clientCreatedTime: t("2026-09-16T18:00:00Z"), payment: { id: "PX", tender: { id: "T_CREDIT" } }, ...o } as CloverObject,
    tenders,
  );
const rev = (payments: ReturnType<typeof pay>[], refunds: ReturnType<typeof refund>[], month = SEP) =>
  computeRevenue({ month, timezone: TZ, payments, refunds });

function checkInvariants(r: ReturnType<typeof rev>) {
  for (const k of ["grossSales", "refunds", "netSales", "salesTaxCollected", "tips"] as const) {
    assert.equal(r[k].card + r[k].cash, r[k].total, `${k} card+cash=total`);
  }
  for (const s of ["total", "card", "cash"] as const) assert.equal(r.netSales[s], r.grossSales[s] - r.refunds[s], `net=gross-refunds (${s})`);
}

// --- Main scenario: null tip, cash, FAIL retries, partial refund of a prior-month sale
{
  const payments = [
    pay({ amount: 1362, taxAmount: 118, tipAmount: 100 }), // card with tip on top
    pay({ amount: 567, taxAmount: 62, tipAmount: null, tender: { id: "T_CASH" } }), // cash, null tip
    pay({ amount: 2440, taxAmount: 266, result: "FAIL", order: { id: "ORD_X" } }), // FAIL retries share an order
    pay({ amount: 2440, taxAmount: 266, result: "FAIL", order: { id: "ORD_X" } }),
    pay({ amount: 2440, taxAmount: 266, order: { id: "ORD_X" } }), // eventual SUCCESS
  ];
  // partial refund (926 of a 3536 sale) of an AUGUST payment that is not even in the data
  const refunds = [refund({ amount: 926, taxAmount: 101, payment: { id: "P_AUG", tender: { id: "T_CREDIT" } } })];
  const r = rev(payments, refunds);
  checkInvariants(r);
  assert.deepEqual(r.grossSales, { total: 1244 + 505 + 2174, card: 1244 + 2174, cash: 505 });
  assert.deepEqual(r.refunds, { total: 825, card: 825, cash: 0 }, "refund reduces the refund month; net = amount - tax");
  assert.deepEqual(r.netSales, { total: 3923 - 825, card: 3418 - 825, cash: 505 });
  assert.deepEqual(r.salesTaxCollected, { total: 118 + 62 + 266 - 101, card: 118 + 266 - 101, cash: 62 }, "refund tax comes off tax collected");
  assert.deepEqual(r.tips, { total: 100, card: 100, cash: 0 }, "null tip counts as 0; tips are memo only");
  assert.deepEqual(r.counts.payments, { total: 3, card: 2, cash: 1 }, "FAIL retries not counted");
  assert.deepEqual(r.counts.refunds, { total: 1, card: 1, cash: 0 });
  assert.equal(r.ignored.payments, 2);
  assert.equal(r.startUtc, "2026-09-01T06:00:00.000Z");
  assert.equal(r.effectiveTaxRate, 345 / 3098);
  assert.equal(r.warnings.some((w) => w.code === "HIGH_EFFECTIVE_TAX_RATE"), true);
}

// --- Offline payment: device time in September, uploaded in October
{
  const offline = pay({ amount: 1121, taxAmount: 100, createdTime: t("2026-10-12T17:48:06Z"), clientCreatedTime: t("2026-09-26T23:24:11Z"), offline: true });
  assert.equal(rev([offline], []).grossSales.total, 1021, "counts in September");
  assert.equal(rev([offline], [], "2026-10").grossSales.total, 0, "and not in October");
  assert.equal(rev([offline], [], "2026-10").ignored.outsideMonth, 1);
}

// --- Offline payment whose device time is in the PRIOR month
{
  const p = pay({ amount: 500, taxAmount: 40, createdTime: t("2026-09-02T15:00:00Z"), clientCreatedTime: t("2026-08-31T20:00:00Z") });
  assert.equal(rev([p], []).grossSales.total, 0, "Aug 31 sale is not a September sale even though uploaded Sep 2");
  assert.equal(rev([p], [], "2026-08").grossSales.total, 460, "it is an August sale");
}

// --- 45-day fallback: bogus device clock -> server createdTime decides
{
  const stale = pay({ amount: 700, taxAmount: 50, createdTime: t("2026-09-20T18:00:00Z"), clientCreatedTime: t("2026-07-01T18:00:00Z") });
  assert.equal(stale.saleTimeSource, "SERVER");
  assert.equal(rev([stale], []).grossSales.total, 650, "falls back to Sep 20");
  assert.equal(rev([stale], [], "2026-07").grossSales.total, 0);
  const ok = pay({ amount: 700, taxAmount: 50, createdTime: t("2026-09-20T18:00:00Z"), clientCreatedTime: t("2026-08-10T18:00:00Z") }); // 41 days
  assert.equal(ok.saleTimeSource, "CLIENT");
  assert.equal(rev([ok], []).grossSales.total, 0, "41-day lag is trusted -> August");
}

// --- Denver month boundary: 11:59:59pm Sep 30 MDT vs midnight Oct 1
{
  const last = pay({ amount: 110, taxAmount: 10, createdTime: t("2026-10-01T05:59:59Z"), clientCreatedTime: t("2026-10-01T05:59:59Z") });
  const first = pay({ amount: 220, taxAmount: 20, createdTime: t("2026-10-01T06:00:00Z"), clientCreatedTime: t("2026-10-01T06:00:00Z") });
  assert.equal(rev([last, first], []).grossSales.total, 100);
  assert.equal(rev([last, first], [], "2026-10").grossSales.total, 200);
}

// --- Refund edge cases
{
  const voided = refund({ amount: 500, taxAmount: 40, voided: true });
  const failed = refund({ amount: 500, taxAmount: 40, status: "FAIL" });
  const cashRefund = refund({ amount: 300, taxAmount: 20, payment: { id: "PC", tender: { id: "T_CASH" } } });
  const priorMonthRefund = refund({ amount: 999, taxAmount: 99, createdTime: t("2026-08-20T18:00:00Z"), clientCreatedTime: t("2026-08-20T18:00:00Z") });
  const r = rev([pay({ amount: 2000, taxAmount: 150 })], [voided, failed, cashRefund, priorMonthRefund]);
  checkInvariants(r);
  assert.deepEqual(r.refunds, { total: 280, card: 0, cash: 280 });
  assert.deepEqual(r.counts.refunds, { total: 1, card: 0, cash: 1 });
  assert.equal(r.ignored.refunds, 2);
  assert.equal(r.ignored.outsideMonth, 1);
  assert.equal(r.salesTaxCollected.total, 150 - 20);
}

// --- Effective tax rate + warning threshold (strict >)
{
  const at = (taxCents: number) => rev([pay({ amount: 10000 + taxCents, taxAmount: taxCents })], []);
  assert.equal(at(825).warnings.length, 0, "8.25% is fine");
  assert.equal(at(850).effectiveTaxRate, 0.085);
  assert.equal(at(850).warnings.length, 0, "exactly 8.5% does not warn");
  const high = at(851);
  assert.equal(high.warnings[0].code, "HIGH_EFFECTIVE_TAX_RATE");
  assert.match(high.warnings[0].message, /8\.51%/);
  assert.equal(HIGH_TAX_RATE_THRESHOLD, 0.085);
  // refunds in excess of sales: no rate, no warning
  const neg = rev([pay({ amount: 1000, taxAmount: 100 })], [refund({ amount: 1000, taxAmount: 100 })]);
  assert.equal(neg.netSales.total, 0);
  assert.equal(neg.effectiveTaxRate, null);
  assert.equal(neg.warnings.length, 0);
}

// --- Empty month and unknown tender
{
  const empty = rev([], []);
  assert.equal(empty.netSales.total, 0);
  assert.equal(empty.effectiveTaxRate, null);
  checkInvariants(empty);
  const unknown = rev([pay({ tender: { id: "T_GONE" }, amount: 1100, taxAmount: 100 })], []);
  assert.equal(unknown.grossSales.card, 1000, "unknown tender bucketed as card");
  assert.equal(unknown.warnings.some((w) => w.code === "UNKNOWN_TENDER"), true);
}

console.log("revenue ok");
