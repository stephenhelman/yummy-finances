import assert from "node:assert/strict";
import { hashReport, type Snapshot } from "../src/lib/report/close-month";
import { MAX_FILE_MONTHS, fileMonths, monthRange, problemsFor, type FileDeps } from "../src/lib/report/file-months";
import { buildReport, type ReportCategory, type ReportTxn } from "../src/lib/report/pnl";
import { GROUP_ORDER, TEMPLATE } from "../src/lib/report/template";
import { computeRevenue } from "../src/lib/revenue";

const TZ = "America/Denver";
const at = (iso: string) => new Date(iso);

// ---- ranges --------------------------------------------------------------------------------------------------------------
assert.deepEqual(monthRange("2026-01", "2026-03"), ["2026-01", "2026-02", "2026-03"]);
assert.deepEqual(monthRange("2026-05", "2026-05"), ["2026-05"]);
assert.deepEqual(monthRange("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"], "ranges cross a year");
assert.equal(monthRange("2026-01", "2026-12").length, 12);
assert.match(String(monthRange("2025-01", "2026-01")), /At most 12 months/);
assert.match(String(monthRange("2026-03", "2026-01")), /can't be before/);
for (const bad of [["", ""], ["2026-13", "2026-14"], ["26-01", "26-02"], ["2026-01", ""]] as const) assert.match(String(monthRange(bad[0], bad[1])), /Choose a first and a last month/);
assert.equal(MAX_FILE_MONTHS, 12);

// ---- fixtures --------------------------------------------------------------------------------------------------------------
const groupSort = (g: string | null) => (g === null ? -1 : GROUP_ORDER.indexOf(g));
const CATS: ReportCategory[] = TEMPLATE.map((c, i) => ({ id: c.key, key: c.key, name: c.name, groupName: c.group, groupSort: groupSort(c.group), treatment: c.treatment, showWhenZero: true, archived: false, sortOrder: i }));
function report(month: string, o: { unreviewed?: number; taxWarning?: boolean } = {}) {
  const txns: ReportTxn[] = [
    { amountCents: 1_000, kind: "EXPENSE", categoryId: "rent", reviewStatus: "REVIEWED", normalizedMerchant: "R", raw: "R" },
    ...Array.from({ length: o.unreviewed ?? 0 }, () => ({ amountCents: 300, kind: null, categoryId: null, reviewStatus: "NEEDS_REVIEW" as const, normalizedMerchant: "MYSTERY", raw: "MYSTERY" })),
  ];
  // a 12% effective tax rate trips the "sales tax looks high" warning
  const tax = o.taxWarning ? 1_200 : 80;
  return buildReport({
    label: month, categories: CATS, salesTaxInRevenue: false, discountsCents: 0, txns,
    revenue: computeRevenue({ month, timezone: TZ, payments: [{ amountCents: 10_000 + tax, taxCents: tax, tipCents: 0, isCash: false, tenderLabel: "Credit Card", result: "SUCCESS", excluded: false, saleTime: new Date(`${month}-10T18:00:00Z`) }], refunds: [] }),
  });
}

function world(opts: { now?: string; reports?: Record<string, ReturnType<typeof report>>; fileFailsFor?: () => string | null } = {}) {
  const s = { snaps: new Map<string, Snapshot>(), locks: [] as string[], filed: [] as string[], emails: 0, audits: [] as { action: string; payload: Record<string, unknown> }[], liveReads: [] as string[] };
  const reports = opts.reports ?? {};
  const deps: FileDeps = {
    now: () => at(opts.now ?? "2026-10-06T12:00:00-06:00"), timezone: TZ,
    liveReport: async (m) => { s.liveReads.push(m); return reports[m] ?? report(m); },
    getSnapshot: async (m) => s.snaps.get(m) ?? null,
    lock: async (m, r, hash) => {
      assert.equal(hash, hashReport(r), "the hash is of the report that is stored");
      const have = s.snaps.get(m);
      if (have?.status === "LOCKED") return { snapshot: have, created: false };
      const snap: Snapshot = { month: m, status: "LOCKED", dataJson: r, emailSentAt: null };
      s.snaps.set(m, snap);
      s.locks.push(m);
      return { snapshot: snap, created: true };
    },
    send: async () => { s.emails++; },
    recordSent: async () => { s.emails++; },
    sendTest: async () => { s.emails++; },
    file: async (snap) => { if (opts.fileFailsFor?.() === snap.month) throw new Error("Apps Script timed out"); s.filed.push(snap.month); },
    audit: async (action, payload) => { s.audits.push({ action, payload }); },
  };
  return { deps, s };
}
const none = new Set<string>();

async function main() {
  const M = ["2026-01", "2026-02", "2026-03"];

  // ---- the happy path ------------------------------------------------------------------------------------------------------
  {
    const w = world();
    const r = await fileMonths(w.deps, M, { acknowledged: none });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.done, M.map((month) => ({ month, locked: true, filed: true })));
    assert.deepEqual(w.s.locks, M, "locked oldest first");
    assert.deepEqual(w.s.filed, M, "and filed oldest first");
    assert.equal(w.s.emails, 0, "NO email is sent: neither the report, nor a delivery record, nor a test");
    assert.ok([...w.s.snaps.values()].every((s) => s.status === "LOCKED" && s.emailSentAt === null), "emailSentAt stays empty: Re-send can still email a filed month");
    // audited: a lock and a file per month, then a summary
    assert.deepEqual(w.s.audits.map((a) => a.action), ["report.lock", "report.file", "report.lock", "report.file", "report.lock", "report.file", "report.file_range"]);
    assert.ok(w.s.audits.filter((a) => a.action === "report.lock").every((a) => a.payload.bulk === true), "marked as a bulk lock");
    assert.deepEqual(w.s.audits.at(-1)!.payload, { from: "2026-01", to: "2026-03", months: 3, newlyLocked: 3 });
  }

  // ---- idempotent: run it again ----------------------------------------------------------------------------------------------
  {
    const w = world();
    await fileMonths(w.deps, M, { acknowledged: none });
    const before = { locks: w.s.locks.length, snaps: JSON.stringify([...w.s.snaps.values()]) };
    w.s.liveReads.length = 0;
    const again = await fileMonths(w.deps, M, { acknowledged: none });
    assert.equal(again.ok, true);
    assert.deepEqual(again.ok && again.done.map((d) => d.locked), [false, false, false], "nothing is locked a second time");
    assert.equal(w.s.locks.length, before.locks);
    assert.equal(JSON.stringify([...w.s.snaps.values()]), before.snaps, "the saved numbers are untouched");
    assert.deepEqual(w.s.liveReads, [], "a locked month is never recomputed");
    assert.deepEqual(w.s.filed, [...M, ...M], "its tab is rewritten from the stored snapshot (the script replaces the tab, so no duplicates)");
    assert.equal(w.s.emails, 0);
    // numbers that moved on since are ignored for a locked month, even ones that would now be refused
    w.deps.liveReport = async () => { throw new Error("must not be read"); };
    assert.equal((await fileMonths(w.deps, M, { acknowledged: none })).ok, true);
  }

  // ---- same lock rules as Lock & send ------------------------------------------------------------------------------------------
  {
    const w = world({ now: "2026-10-20T12:00:00-06:00" });
    const r = await fileMonths(w.deps, ["2026-08", "2026-09", "2026-10"], { acknowledged: none });
    assert.ok(!r.ok && r.reason === "problems");
    assert.deepEqual(r.problems.map((p) => [p.month, p.kind]), [["2026-10", "not_eligible"]], "the current month is refused");
    assert.match(r.problems[0].message, /isn't over yet/);
    assert.equal(w.s.locks.length + w.s.filed.length, 0, "nothing at all was locked, not even the good months");
    const w2 = world({ now: "2026-11-02T09:00:00-07:00" });
    const r2 = await fileMonths(w2.deps, ["2026-09", "2026-10"], { acknowledged: none });
    assert.ok(!r2.ok && r2.reason === "problems" && /less than 3 days/.test(r2.problems[0].message) && r2.problems[0].month === "2026-10");
    assert.equal(w2.s.locks.length, 0);
    const w3 = world({ now: "2026-11-04T09:00:00-07:00" });
    assert.equal((await fileMonths(w3.deps, ["2026-09", "2026-10"], { acknowledged: none })).ok, true, "3 days after the month ended it is allowed");
  }

  // ---- unreviewed transactions: refused, no override ----------------------------------------------------------------------------
  {
    const w = world({ reports: { "2026-02": report("2026-02", { unreviewed: 3 }) } });
    const everyAck = new Set(M);
    const r = await fileMonths(w.deps, M, { acknowledged: everyAck });
    assert.ok(!r.ok && r.reason === "problems");
    assert.deepEqual(r.problems.map((p) => [p.month, p.kind]), [["2026-02", "unreviewed"]], "acknowledging can't override unreviewed transactions");
    assert.match(r.problems[0].message, /3 bank transactions are still waiting for review/);
    assert.equal(w.s.locks.length + w.s.filed.length, 0, "all or nothing: January and March were not locked either");
    const one = world({ reports: { "2026-02": report("2026-02", { unreviewed: 1 }) } });
    const r1 = await fileMonths(one.deps, M, { acknowledged: new Set(M) });
    assert.match((!r1.ok && r1.reason === "problems" && r1.problems[0].message) || "", /1 bank transaction is still waiting for review\. Review it first/);
  }

  // ---- warnings must be acknowledged, per month ------------------------------------------------------------------------------
  {
    const reports = { "2026-02": report("2026-02", { taxWarning: true }), "2026-03": report("2026-03", { taxWarning: true }) };
    assert.ok(reports["2026-02"].warnings.length > 0 && report("2026-01").warnings.length === 0, "fixture: February and March have a warning, January has none");
    const w = world({ reports });
    const none1 = await fileMonths(w.deps, M, { acknowledged: none });
    assert.ok(!none1.ok && none1.reason === "problems");
    assert.deepEqual(none1.problems.map((p) => [p.month, p.kind]), [["2026-02", "unacknowledged"], ["2026-03", "unacknowledged"]], "January has nothing to acknowledge");
    assert.equal(w.s.locks.length, 0);
    const partial = await fileMonths(w.deps, M, { acknowledged: new Set(["2026-02"]) });
    assert.ok(!partial.ok && partial.reason === "problems" && partial.problems.map((p) => p.month).join() === "2026-03", "each month needs its own acknowledgement");
    assert.equal(w.s.locks.length, 0);
    const all = await fileMonths(w.deps, M, { acknowledged: new Set(["2026-02", "2026-03"]) });
    assert.equal(all.ok, true);
    assert.equal(w.s.locks.length, 3);
    assert.ok(w.s.audits.filter((a) => a.action === "report.lock").some((a) => a.payload.warnings === 1), "the warning count at lock time is audited");
  }

  // ---- mixed: some already locked ------------------------------------------------------------------------------------------------
  {
    const w = world({ reports: { "2026-01": report("2026-01", { unreviewed: 9 }) } });
    // January is already locked (say, by hand earlier): its stored report is what counts, not today's unreviewed rows
    w.s.snaps.set("2026-01", { month: "2026-01", status: "LOCKED", dataJson: report("2026-01"), emailSentAt: null });
    const r = await fileMonths(w.deps, M, { acknowledged: none });
    assert.equal(r.ok, true);
    assert.deepEqual(r.ok && r.done.map((d) => [d.month, d.locked]), [["2026-01", false], ["2026-02", true], ["2026-03", true]]);
    assert.deepEqual(w.s.locks, ["2026-02", "2026-03"]);
  }

  // ---- a failure part-way: earlier months stay done, later ones are untouched, and a re-run carries on ------------------------------
  {
    let failing: string | null = "2026-02";
    const w = world({ fileFailsFor: () => failing });
    const r = await fileMonths(w.deps, M, { acknowledged: none });
    assert.ok(!r.ok && r.reason === "failed");
    assert.equal(r.failedAt.month, "2026-02");
    assert.match(r.failedAt.message, /timed out/);
    assert.deepEqual(r.done.map((d) => d.month), ["2026-01"], "January is done");
    assert.deepEqual(w.s.locks, ["2026-01", "2026-02"], "February was locked (so its numbers are safe) but not filed");
    assert.equal(w.s.snaps.has("2026-03"), false, "March was never touched");
    assert.deepEqual(w.s.filed, ["2026-01"]);
    assert.ok(w.s.audits.some((a) => a.action === "report.file_failed" && a.payload.month === "2026-02"), "the failure is audited");
    assert.ok(!w.s.audits.some((a) => a.action === "report.file_range"), "no summary for an unfinished run");
    failing = null;
    const retry = await fileMonths(w.deps, M, { acknowledged: none });
    assert.equal(retry.ok, true);
    assert.deepEqual(retry.ok && retry.done.map((d) => [d.month, d.locked]), [["2026-01", false], ["2026-02", false], ["2026-03", true]], "finishes the job without locking anything twice");
    assert.deepEqual(w.s.filed, ["2026-01", "2026-01", "2026-02", "2026-03"]);
    assert.equal(w.s.emails, 0);
  }

  // ---- bad requests -------------------------------------------------------------------------------------------------------------
  {
    const w = world();
    const empty = await fileMonths(w.deps, [], { acknowledged: none });
    assert.ok(!empty.ok && empty.reason === "problems");
    const many = await fileMonths(w.deps, Array.from({ length: 13 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`), { acknowledged: none });
    assert.ok(!many.ok);
    assert.equal(w.s.locks.length, 0);
  }

  // problemsFor on its own
  assert.deepEqual(problemsFor([{ month: "2026-01", status: "LOCKED", report: report("2026-01", { unreviewed: 5 }) }], at("2026-10-06T12:00:00-06:00"), TZ, none), [], "a locked month has no problems to check");

  console.log("file-months: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
