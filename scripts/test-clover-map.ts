import assert from "node:assert/strict";
import type { CloverObject } from "../src/lib/clover/client";
import { MAX_OFFLINE_SKEW_MS, PAYMENT_COMPARE, REFUND_COMPARE, changed, isCashTender, mapPayment, mapRefund, mapTender, resolveSaleTime } from "../src/lib/clover/map";

// Fixtures follow the shape of the live probe output.
const tenders = new Map(
  [
    { id: "T_CASH", label: "Cash", labelKey: "com.clover.tender.cash" },
    { id: "T_CREDIT", label: "Credit Card", labelKey: "com.clover.tender.credit_card" },
    { id: "T_DEBIT", label: "Debit Card", labelKey: "com.clover.tender.debit_card" },
  ].map((t) => mapTender(t as CloverObject)).map((t) => [t.cloverId, t]),
);

const order = (id: string, total: number) => ({
  id, currency: "USD", total, state: "locked", payType: "FULL", testMode: false,
  note: "extra sprinkles for Bob", customers: { elements: [{ id: "CUST1" }] }, employee: { id: "E1" },
});
const pay = (o: Partial<CloverObject> & { id: string }): CloverObject => ({
  order: order("ORD1", 2882), tender: { id: "T_CREDIT", href: "x" }, amount: 2882, tipAmount: 0, taxAmount: 282,
  cashbackAmount: 0, createdTime: 1792813700000, clientCreatedTime: 1792813700000, offline: false, result: "SUCCESS",
  refunds: { elements: [] }, employee: { id: "E1" }, ...o,
});

// Tenders
assert.equal(mapTender({ id: "a", label: "Cash" }).isCash, true);
assert.equal(mapTender({ id: "a", label: " cash " }).isCash, true);
assert.equal(mapTender({ id: "a", label: "Cash App", labelKey: "x" }).isCash, false);
assert.equal(mapTender({ id: "a", label: "Petty", labelKey: "com.clover.tender.cash" }).isCash, true);
assert.equal(isCashTender("Credit Card", null), false);
assert.throws(() => mapTender({ id: "a" }), /missing label/);

// Card payment with tip on top; amount is NOT adjusted (amount == order.total, tip separate)
{
  const r = mapPayment(pay({ id: "P1", amount: 1362, taxAmount: 118, tipAmount: 100, order: order("ORD2", 1362) }), tenders);
  assert.equal(r.amountCents, 1362);
  assert.equal(r.taxCents, 118);
  assert.equal(r.tipCents, 100);
  assert.equal(r.tenderLabel, "Credit Card");
  assert.equal(r.isCash, false);
  assert.equal(r.excluded, false);
  assert.equal(r.orderId, "ORD2");
  assert.equal(r.createdTime.toISOString(), new Date(1792813700000).toISOString());
}

// Null tip (cash) -> 0, cash flag from tender label
{
  const r = mapPayment(pay({ id: "P2", amount: 567, taxAmount: 62, tipAmount: null, tender: { id: "T_CASH" } }), tenders);
  assert.equal(r.tipCents, 0);
  assert.equal(r.isCash, true);
  assert.equal(r.tenderLabel, "Cash");
  const absent = mapPayment({ ...pay({ id: "P2b" }), tipAmount: undefined }, tenders);
  assert.equal(absent.tipCents, 0);
}

// FAIL retries share an order with the eventual SUCCESS: all stored, FAILs excluded
{
  const o = order("ORD3", 2440);
  const rows = [
    pay({ id: "F1", result: "FAIL", amount: 2440, taxAmount: 266, order: o, createdTime: 1792810769000 }),
    pay({ id: "F2", result: "FAIL", amount: 2440, taxAmount: 266, order: o, createdTime: 1792810815000 }),
    pay({ id: "S1", result: "SUCCESS", amount: 2440, taxAmount: 266, order: o, createdTime: 1792810910000 }),
  ].map((p) => mapPayment(p, tenders));
  assert.deepEqual(rows.map((r) => r.excluded), [true, true, false]);
  assert.ok(rows.every((r) => r.orderId === "ORD3"));
  assert.equal(rows.filter((r) => !r.excluded).length, 1, "exactly one counted payment per order");
  assert.ok(rows.every((r) => r.amountCents === 2440), "raw amounts preserved even for excluded rows");
}

// Unknown tender id: kept, label null, not cash (surfaced in sync report)
{
  const r = mapPayment(pay({ id: "P3", tender: { id: "T_GONE" } }), tenders);
  assert.equal(r.tenderId, "T_GONE");
  assert.equal(r.tenderLabel, null);
  assert.equal(r.isCash, false);
  assert.equal(mapPayment(pay({ id: "P4", tender: undefined }), tenders).tenderId, null);
}

// Raw is trimmed: no customers, notes, or employee data stored
{
  const r = mapPayment(pay({ id: "P5" }), tenders);
  const flat = JSON.stringify(r.raw);
  for (const leak of ["CUST1", "Bob", "extra sprinkles", "E1", "customers", "employee"]) assert.ok(!flat.includes(leak), `raw leaked ${leak}`);
  assert.equal((r.raw.order as { testMode: boolean }).testMode, false);
}

// Bad data fails loudly
assert.throws(() => mapPayment(pay({ id: "B1", amount: 12.5 }), tenders), /not an integer/);
assert.throws(() => mapPayment(pay({ id: "B2", amount: undefined }), tenders), /missing amount/);
assert.throws(() => mapPayment(pay({ id: "B3", result: undefined }), tenders), /missing result/);
assert.throws(() => mapPayment(pay({ id: "B4", createdTime: 0 }), tenders), /invalid createdTime/);

// Partial refund: refund.amount includes tax, no tip field; payment link kept as Clover id
{
  const r = mapRefund({
    id: "R1", amount: 926, taxAmount: 101, createdTime: 1792116298000, voided: false, status: "SUCCESS", reason: "Returned goods",
    orderRef: { id: "ORD9", note: "private" }, employee: { id: "E1" },
    payment: { id: "P_OLD", amount: 3536, tipAmount: 0, taxAmount: 386, result: "SUCCESS", tender: { id: "T_CREDIT" } },
  });
  assert.equal(r.amountCents, 926);
  assert.equal(r.taxCents, 101);
  assert.equal(r.tipCents, 0);
  assert.equal(r.cloverPaymentId, "P_OLD");
  assert.equal(r.voided, false);
  assert.ok(r.amountCents < 3536, "partial refund");
  const flat = JSON.stringify(r.raw);
  assert.ok(!flat.includes("private") && !flat.includes("E1"));
}
assert.equal(mapRefund({ id: "R2", amount: 100, createdTime: 1792116298000, status: "SUCCESS", voided: true }).voided, true);
assert.equal(mapRefund({ id: "R3", amount: 100, createdTime: 1792116298000, status: "SUCCESS" }).cloverPaymentId, null);
assert.equal(mapRefund({ id: "R3", amount: 100, createdTime: 1792116298000, status: "SUCCESS" }).taxCents, 0);

// Change detection drives idempotent updates
{
  const a = mapPayment(pay({ id: "C1" }), tenders);
  assert.equal(changed(a, mapPayment(pay({ id: "C1" }), tenders), PAYMENT_COMPARE), false);
  assert.equal(changed(a, mapPayment(pay({ id: "C1", tipAmount: 50 }), tenders), PAYMENT_COMPARE), true);
  assert.equal(changed(a, mapPayment(pay({ id: "C1", result: "FAIL" }), tenders), PAYMENT_COMPARE), true);
  const r = mapRefund({ id: "R", amount: 1, createdTime: 1792116298000, status: "SUCCESS" });
  assert.equal(changed(r, { ...r }, REFUND_COMPARE), false);
  assert.equal(changed(r, { ...r, voided: true }, REFUND_COMPARE), true);
}

// Sale date rule: clientCreatedTime when present, <= createdTime, and within 45 days; else createdTime
{
  const created = new Date("2026-10-12T17:48:06Z");
  const sep26 = Date.parse("2026-09-26T23:24:11Z");
  const offline = resolveSaleTime(sep26, created);
  assert.equal(offline.saleTimeSource, "CLIENT");
  assert.equal(offline.saleTime.toISOString(), "2026-09-26T23:24:11.000Z");
  assert.equal(resolveSaleTime(created.getTime(), created).saleTimeSource, "CLIENT", "equal times: client");
  assert.equal(resolveSaleTime(created.getTime() + 1, created).saleTimeSource, "SERVER", "client in the future vs server");
  assert.equal(resolveSaleTime(created.getTime() - MAX_OFFLINE_SKEW_MS, created).saleTimeSource, "CLIENT", "exactly 45 days");
  const over = resolveSaleTime(created.getTime() - MAX_OFFLINE_SKEW_MS - 1, created);
  assert.equal(over.saleTimeSource, "SERVER", "45 days + 1ms falls back");
  assert.equal(over.saleTime.getTime(), created.getTime());
  assert.notEqual(over.clientCreatedTime, null, "client time is still recorded");
  for (const absent of [undefined, null, 0, "x", NaN]) assert.equal(resolveSaleTime(absent, created).saleTimeSource, "SERVER");
  assert.equal(resolveSaleTime(undefined, created).clientCreatedTime, null);

  // through the mapper: the live offline payment shape (device time Sep 26, server Oct 12)
  const p = mapPayment(pay({ id: "OFF1", amount: 1121, taxAmount: 100, tipAmount: 0, createdTime: created.getTime(), clientCreatedTime: sep26, offline: true }), tenders);
  assert.equal(p.saleTimeSource, "CLIENT");
  assert.equal(p.saleTime.toISOString(), "2026-09-26T23:24:11.000Z");
  assert.equal(p.createdTime.toISOString(), created.toISOString(), "server time preserved");
  const rf = mapRefund({ id: "OFFR", amount: 100, createdTime: created.getTime(), clientCreatedTime: sep26, status: "SUCCESS" });
  assert.equal(rf.saleTime.toISOString(), "2026-09-26T23:24:11.000Z");
  assert.equal(changed(p, mapPayment(pay({ id: "OFF1", amount: 1121, taxAmount: 100, tipAmount: 0, createdTime: created.getTime(), clientCreatedTime: sep26 + 1000 }), tenders), PAYMENT_COMPARE), true, "saleTime change is detected");
}

// Refund tender comes from the expanded payment, so cash vs card is known without the payment row
{
  const card = mapRefund({ id: "RT1", amount: 926, taxAmount: 101, createdTime: 1792116298000, status: "SUCCESS", payment: { id: "P_OLD", tender: { id: "T_CREDIT" } } }, tenders);
  assert.deepEqual([card.tenderLabel, card.isCash], ["Credit Card", false]);
  const cash = mapRefund({ id: "RT2", amount: 500, taxAmount: 50, createdTime: 1792116298000, status: "SUCCESS", payment: { id: "P_OLD2", tender: { id: "T_CASH" } } }, tenders);
  assert.deepEqual([cash.tenderLabel, cash.isCash], ["Cash", true]);
  assert.equal(mapRefund({ id: "RT3", amount: 5, createdTime: 1792116298000, status: "SUCCESS", payment: { id: "P" } }, tenders).tenderLabel, null);
}

console.log("clover map ok");
