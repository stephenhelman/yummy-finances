import assert from "node:assert/strict";
import { LOCAL_SALES_TAX_RATE_LABEL, dayOfMonth, formatDateTime, monthLabel, percent } from "../src/lib/format";
import { summarizeSync } from "../src/lib/sync-summary";
import type { ManualSyncResult } from "../src/lib/sync-now";

// ---- format
assert.equal(monthLabel("2026-09"), "September");
assert.equal(monthLabel("2026-01", true), "January 2026");
assert.equal(monthLabel("garbage"), "garbage");
assert.equal(percent(0.118306), "11.83%");
assert.equal(percent(0.0825), "8.25%");
assert.equal(LOCAL_SALES_TAX_RATE_LABEL, "8.25%");
// 11:30pm Denver on Oct 24 is already Oct 25 in UTC: dates must follow the business timezone
const lateNight = new Date("2026-10-25T05:30:00Z");
assert.equal(dayOfMonth(lateNight, "America/Denver"), 24);
assert.equal(dayOfMonth(lateNight, "UTC"), 25);
assert.equal(formatDateTime(new Date("2026-10-24T16:36:00Z"), "America/Denver"), "Oct 24, 10:36 AM");

// ---- sync summary
const at = new Date("2026-10-24T16:36:00Z");
const counts = { apiAdded: 0, apiModified: 0, apiRemoved: 0, created: 0, updated: 0, unchanged: 0, removed: 0, superseded: 0, late: 0, audited: 0 };
const month = (m: string, created = 0, updated = 0, refundsCreated = 0) => ({
  month: m,
  payments: { fetched: 10, created, updated, unchanged: 0, outsideWindow: 0, updatedInLockedMonth: 0, unknownTender: 0, testMode: 0, lateCreated: 0 },
  refunds: { fetched: 1, created: refundsCreated, updated: 0, unchanged: 0, outsideWindow: 0, updatedInLockedMonth: 0, unknownTender: 0, lateCreated: 0 },
  startUtc: "", endUtc: "", monthLocked: false,
});
const clover = (months: ReturnType<typeof month>[]) => ({ ok: true as const, report: { month: months.at(-1)!.month, timezone: "America/Denver", tenders: 13, months, refundsLinked: 0, refundsUnlinked: 0 } });
type BankResult = Extract<ManualSyncResult["plaid"], { ok: true }>["banks"][number]["result"];
const bank = (result: BankResult, institution: string | null = "First Platypus Bank", itemId = "i1") => ({ itemId, institution, result });
const banks = (...b: ReturnType<typeof bank>[]) => ({ ok: true as const, banks: b });
const syncedResult = (c: Partial<typeof counts>): BankResult => ({ outcome: "synced", itemStatus: "OK", status: "synced", counts: { ...counts, ...c }, pages: 1, restarts: 0, nextCursor: "x" });
const synced = (c: Partial<typeof counts>) => banks(bank(syncedResult(c)));
const sum = (r: ManualSyncResult) => summarizeSync(r, at, "Oct 24, 10:36 AM");

{
  const quiet = sum({ plaid: synced({}), clover: clover([month("2026-08"), month("2026-09"), month("2026-10")]) });
  assert.equal(quiet.ok, true);
  assert.deepEqual(quiet.lines, ["Bank: up to date.", "Clover: up to date (August to October checked)."]);
  assert.equal(quiet.atLabel, "Oct 24, 10:36 AM");

  const busy = sum({ plaid: synced({ created: 12, updated: 2, removed: 1, late: 1, audited: 1 }), clover: clover([month("2026-09"), month("2026-10", 40, 3, 2)]) });
  assert.equal(busy.lines[0], "Bank: 12 new, 2 changed, 1 removed. 1 landed in a month that was already closed. 1 need a look.");
  assert.equal(busy.lines[1], "Clover: 40 new payments, 3 changed, 2 new refunds (September to October checked).");

  const noBank = sum({ plaid: banks(), clover: clover([month("2026-10")]) });
  assert.equal(noBank.ok, true, "no bank yet is not a failure");
  assert.equal(noBank.lines[0], "Bank: not connected yet.");
  assert.equal(noBank.lines[1], "Clover: up to date (October checked).");

  const skipped = sum({ plaid: banks(bank({ outcome: "skipped", itemStatus: "LOGIN_REQUIRED", errorCode: "ITEM_LOGIN_REQUIRED" })), clover: clover([month("2026-10")]) });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.plaidOk, false);
  assert.equal(skipped.cloverOk, true);
  assert.match(skipped.lines[0], /^Bank: skipped\. .*Connections/);

  const withMessage = sum({ plaid: banks(bank({ outcome: "skipped", itemStatus: "UNUSABLE", errorCode: "KEY_MISMATCH", message: "Cannot decrypt." })), clover: clover([month("2026-10")]) });
  assert.equal(withMessage.lines[0], "Bank: skipped. Cannot decrypt.");

  const notReady = sum({ plaid: banks(bank({ outcome: "not_ready", itemStatus: "OK" })), clover: clover([month("2026-10")]) });
  assert.match(notReady.lines[0], /still preparing/);
  assert.equal(notReady.ok, true);

  // several banks: lines name the bank, one needing attention doesn't hide the other
  const mixed = sum({
    plaid: banks(
      bank({ outcome: "skipped", itemStatus: "LOGIN_REQUIRED", errorCode: "ITEM_LOGIN_REQUIRED" }, "Chase", "i1"),
      bank(syncedResult({ created: 3 }), "Wells Fargo", "i2"),
      bank({ outcome: "failed", error: "boom" }, null, "i3"),
    ),
    clover: clover([month("2026-10")]),
  });
  assert.equal(mixed.plaidOk, false);
  assert.match(mixed.lines[0], /^Bank \(Chase\): skipped\./);
  assert.equal(mixed.lines[1], "Bank (Wells Fargo): 3 new, 0 changed, 0 removed.");
  assert.equal(mixed.lines[2], "Bank (#3): couldn't sync. boom");

  const failed = sum({ plaid: { ok: false, error: "ITEM_ERROR/X: bad" }, clover: { ok: false, error: "Clover timezone mismatch" } });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.lines, ["Bank: couldn't sync. ITEM_ERROR/X: bad", "Clover: couldn't sync. Clover timezone mismatch"]);
  assert.deepEqual([failed.plaidOk, failed.cloverOk], [false, false]);
}

console.log("ui helpers ok");
