import assert from "node:assert/strict";
import { autoBlockers, lockEligibility, unreviewedCount } from "../src/lib/report/close";
import { hashReport, lockAndSend, resend, sendTest, type CloseDeps, type Snapshot } from "../src/lib/report/close-month";
import { monthlyClose, reviewNudge, type CloseCronDeps, type NudgeDeps } from "../src/lib/report/cron-jobs";
import { buildReport, type ReportCategory } from "../src/lib/report/pnl";
import { GROUP_ORDER, TEMPLATE } from "../src/lib/report/template";
import { computeRevenue } from "../src/lib/revenue";
import { autoSendCheck } from "../src/lib/preflight-env";
import { buildTestPayload } from "../src/lib/report";

const TZ = "America/Denver";
const at = (iso: string) => new Date(iso);

// ---- when a month may be locked -----------------------------------------------------------------------------------------
{
  const ok = (month: string, now: string) => lockEligibility(month, at(now), TZ).ok;
  assert.equal(ok("2026-10", "2026-10-31T12:00:00-06:00"), false, "the current month can't be locked");
  assert.equal(ok("2026-10", "2026-11-01T00:30:00-06:00"), false, "it ended minutes ago");
  assert.equal(ok("2026-10", "2026-11-03T23:59:00-07:00"), false, "still inside the 3 days");
  assert.equal(ok("2026-10", "2026-11-04T00:00:00-07:00"), true, "3 days after it ended");
  assert.equal(ok("2026-10", "2026-11-05T09:00:00-07:00"), true, "the 5th is fine");
  assert.equal(ok("2026-09", "2026-10-31T00:00:00-06:00"), true, "an older month");
  const e = lockEligibility("2026-10", at("2026-10-15T12:00:00-06:00"), TZ);
  assert.ok(!e.ok && /isn't over yet/.test(e.reason) && e.availableFrom === "2026-11-04");
  const f = lockEligibility("2026-10", at("2026-11-02T12:00:00-07:00"), TZ);
  assert.ok(!f.ok && /ended less than 3 days ago/.test(f.reason) && /Nov 4/.test(f.reason));
  // time zone: 06:30 UTC on Nov 4 is still Nov 3 in Denver (UTC-7), so it is NOT yet allowed
  assert.equal(ok("2026-10", "2026-11-04T06:30:00Z"), false, "the business time zone decides, not UTC");
  assert.equal(ok("2026-10", "2026-11-04T07:00:00Z"), true);
}

// ---- a report to work with ----------------------------------------------------------------------------------------------
const groupSort = (g: string | null) => (g === null ? -1 : GROUP_ORDER.indexOf(g));
const CATS: ReportCategory[] = TEMPLATE.map((c, i) => ({ id: c.key, key: c.key, name: c.name, groupName: c.group, groupSort: groupSort(c.group), treatment: c.treatment, showWhenZero: true, archived: false, sortOrder: i }));
const mkReport = (unreviewed = 0) =>
  buildReport({
    label: "2026-09", categories: CATS, salesTaxInRevenue: false, discountsCents: 0,
    revenue: computeRevenue({ month: "2026-09", timezone: TZ, payments: [{ amountCents: 10_080, taxCents: 80, tipCents: 0, isCash: false, tenderLabel: "Credit Card", result: "SUCCESS", excluded: false, saleTime: new Date("2026-09-10T18:00:00Z") }], refunds: [] }),
    txns: [
      { amountCents: 2_000, kind: "EXPENSE", categoryId: "rent", reviewStatus: "REVIEWED", normalizedMerchant: "R", raw: "R" },
      ...Array.from({ length: unreviewed }, () => ({ amountCents: 500, kind: null, categoryId: null, reviewStatus: "NEEDS_REVIEW" as const, normalizedMerchant: "MYSTERY", raw: "MYSTERY" })),
    ],
  });
assert.equal(unreviewedCount(mkReport(0)), 0);
assert.equal(unreviewedCount(mkReport(3)), 3);
assert.deepEqual(autoBlockers(mkReport(0), []), []);
assert.deepEqual(autoBlockers(mkReport(2), ["Chase needs attention"]), ["2 bank transactions are still waiting for review", "Chase needs attention"]);
assert.match(autoBlockers(mkReport(1), [])[0], /1 bank transaction is still waiting/);

// ---- fakes ------------------------------------------------------------------------------------------------------------------
function world(over: { now?: string; report?: ReturnType<typeof mkReport>; sendFails?: () => boolean } = {}) {
  const state = { snaps: new Map<string, Snapshot>(), sends: [] as string[], tests: [] as string[], audits: [] as { action: string; payload: Record<string, unknown> }[], liveCalls: 0, locks: 0 };
  let nowIso = over.now ?? "2026-10-06T12:00:00-06:00";
  const live = over.report ?? mkReport(0);
  const deps: CloseDeps = {
    now: () => at(nowIso), timezone: TZ,
    liveReport: async () => { state.liveCalls++; return live; },
    getSnapshot: async (m) => state.snaps.get(m) ?? null,
    lock: async (m, report) => {
      const have = state.snaps.get(m);
      if (have?.status === "LOCKED") return { snapshot: have, created: false }; // lockMonth never overwrites
      state.locks++;
      const s: Snapshot = { month: m, status: "LOCKED", dataJson: report, emailSentAt: null };
      state.snaps.set(m, s);
      return { snapshot: s, created: true };
    },
    send: async (snap) => { if (over.sendFails?.()) throw new Error("Apps Script timed out"); state.sends.push(JSON.stringify(snap.dataJson)); },
    recordSent: async (m, when) => { state.snaps.get(m)!.emailSentAt = when; },
    sendTest: async (m, r) => { state.tests.push(`${m}:${r.label}`); },
    audit: async (action, payload) => { state.audits.push({ action, payload }); },
  };
  return { deps, state, setNow: (iso: string) => { nowIso = iso; } };
}

async function main() {
// ---- Lock & send -----------------------------------------------------------------------------------------------------------
{
  const w = world();
  const r = await lockAndSend(w.deps, "2026-09", { actor: "me" });
  assert.deepEqual(r, { ok: true, locked: true, sent: true, alreadyLocked: false });
  assert.equal(w.state.snaps.get("2026-09")!.status, "LOCKED");
  assert.ok(w.state.snaps.get("2026-09")!.emailSentAt);
  assert.equal(w.state.sends.length, 1);
  assert.deepEqual(w.state.audits.map((a) => a.action), ["report.lock", "report.send"], "both steps are audited");
  assert.equal(hashReport(mkReport(0)), hashReport(mkReport(0)), "the hash is stable");
  // a second press does nothing: already locked and sent
  const again = await lockAndSend(w.deps, "2026-09", { actor: "me" });
  assert.ok(!again.ok && again.code === "already_locked_sent");
  assert.equal(w.state.sends.length, 1, "no second email");
  assert.equal(w.state.locks, 1);
}
{
  // blocked for the current month and a month that just ended: nothing is read, locked or sent
  const w = world({ now: "2026-10-20T12:00:00-06:00" });
  const cur = await lockAndSend(w.deps, "2026-10", { actor: "me" });
  assert.ok(!cur.ok && cur.code === "not_eligible" && /isn't over yet/.test(cur.message));
  w.setNow("2026-11-02T09:00:00-07:00");
  const fresh = await lockAndSend(w.deps, "2026-10", { actor: "me" });
  assert.ok(!fresh.ok && fresh.code === "not_eligible" && /less than 3 days/.test(fresh.message));
  assert.equal(w.state.locks + w.state.sends.length + w.state.liveCalls, 0, "a refused lock touches nothing");
}
{
  // sending fails: the month stays LOCKED (data is safe), is marked not sent, and Re-send / a second press finishes the job
  let fail = true;
  const w = world({ sendFails: () => fail });
  const r = await lockAndSend(w.deps, "2026-09", { actor: "me" });
  assert.ok(!r.ok && r.code === "send_failed" && r.locked === true && /Re-send/.test(r.message));
  assert.equal(w.state.snaps.get("2026-09")!.status, "LOCKED");
  assert.equal(w.state.snaps.get("2026-09")!.emailSentAt, null, "not marked sent");
  assert.ok(w.state.audits.some((a) => a.action === "report.send_failed"));
  fail = false;
  w.deps.liveReport = async () => { throw new Error("must not be recomputed once locked"); };
  const retry = await lockAndSend(w.deps, "2026-09", { actor: "me" });
  assert.deepEqual(retry, { ok: true, locked: true, sent: true, alreadyLocked: true });
  assert.ok(w.state.snaps.get("2026-09")!.emailSentAt);
}

// ---- Re-send ---------------------------------------------------------------------------------------------------------------
{
  const w = world();
  assert.ok(!(await resend(w.deps, "2026-09")).ok, "a draft can't be re-sent");
  await lockAndSend(w.deps, "2026-09", { actor: "me" });
  const before = w.state.sends[0];
  w.deps.liveReport = async () => mkReport(7); // today's numbers have moved on
  const r = await resend(w.deps, "2026-09");
  assert.ok(r.ok);
  assert.equal(w.state.sends.length, 2);
  assert.equal(w.state.sends[1], before, "re-sends the STORED snapshot, never today's numbers");
  assert.deepEqual(w.state.audits.at(-1), { action: "report.send", payload: { month: "2026-09", resend: true } });
}

// ---- Send test report ------------------------------------------------------------------------------------------------------
{
  const w = world();
  const r = await sendTest(w.deps, "2026-09");
  assert.ok(r.ok);
  assert.deepEqual(w.state.tests, ["2026-09:2026-09"]);
  assert.equal(w.state.snaps.size, 0, "a test locks nothing");
  assert.equal(w.state.locks + w.state.sends.length, 0, "and sends no real report");
  assert.deepEqual(w.state.audits.map((a) => a.action), ["report.test"]);
  // for a locked month the test uses the stored report
  await lockAndSend(w.deps, "2026-09", { actor: "me" });
  w.deps.liveReport = async () => { throw new Error("locked months aren't recomputed"); };
  assert.ok((await sendTest(w.deps, "2026-09")).ok);
  // a failing test reports it and still changes nothing
  w.deps.sendTest = async () => { throw new Error("boom"); };
  const bad = await sendTest(w.deps, "2026-09");
  assert.ok(!bad.ok && /didn't send/.test(bad.message));
  // the payload itself: owner only, flagged test
  const p = buildTestPayload(mkReport(0), { name: "Yummy", ownerEmail: "owner@x.com", ccEmail: "cc@x.com" }, "2026-09");
  assert.deepEqual(p.recipients, ["owner@x.com"], "a test goes to the owner only, never the cc");
  assert.equal(p.test, true);
  assert.deepEqual([p.year, p.month], [2026, 9]);
}

// ---- cron: review nudge (3rd) ------------------------------------------------------------------------------------------------
const ON = { REPORTS_AUTO_SEND: "true" };
function jobs(init: { unreviewed?: number } = {}) {
  const done = new Map<string, "RUNNING" | "OK" | "FAILED">();
  const notices: { subject: string; body: string }[] = [];
  const base = {
    now: () => at("2026-10-03T15:00:00Z"), timezone: TZ,
    claim: async (job: string, period: string) => { const k = `${job}:${period}`; if (done.get(k) === "OK" || done.get(k) === "RUNNING") return false; done.set(k, "RUNNING"); return true; },
    finish: async (job: string, period: string, error?: string) => { done.set(`${job}:${period}`, error ? "FAILED" : "OK"); },
    notify: async (subject: string, body: string) => { notices.push({ subject, body }); },
  };
  const nudge: NudgeDeps = { ...base, unreviewed: async () => init.unreviewed ?? 0 };
  return { base, nudge, done, notices };
}
{
  const j = jobs({ unreviewed: 12 });
  assert.deepEqual(await reviewNudge(j.nudge, {}), { status: "disabled" }, "off unless REPORTS_AUTO_SEND=true");
  assert.deepEqual(await reviewNudge(j.nudge, { REPORTS_AUTO_SEND: "1" }), { status: "disabled" }, "only the exact word true");
  assert.deepEqual(await reviewNudge(j.nudge, { REPORTS_AUTO_SEND: "false" }), { status: "disabled" });
  assert.equal(j.notices.length + j.done.size, 0, "disabled does nothing at all");
  assert.deepEqual(await reviewNudge(j.nudge, ON), { status: "sent", month: "2026-09", count: 12 });
  assert.match(j.notices[0].subject, /12 transactions to review before the September report/);
  assert.match(j.notices[0].body, /12 bank transactions from September 2026/);
  assert.deepEqual(await reviewNudge(j.nudge, ON), { status: "already_done", month: "2026-09" }, "once per month");
  assert.equal(j.notices.length, 1);
  const none = jobs({ unreviewed: 0 });
  assert.deepEqual(await reviewNudge(none.nudge, ON), { status: "nothing_to_review", month: "2026-09", count: 0 });
  assert.equal(none.notices.length, 0, "no email when there is nothing to review");
  const one = jobs({ unreviewed: 1 });
  await reviewNudge(one.nudge, ON);
  assert.match(one.notices[0].subject, /1 transaction to review/);
  const broken = jobs();
  broken.nudge.unreviewed = async () => { throw new Error("db down"); };
  assert.equal((await reviewNudge(broken.nudge, ON)).status, "failed");
  assert.equal(broken.done.get("review-nudge:2026-09"), "FAILED", "a failed run can be tried again");
}

// ---- cron: monthly close (5th) -------------------------------------------------------------------------------------------------
function closeJob(over: { report?: ReturnType<typeof mkReport>; syncProblems?: string[]; bankProblems?: string[]; sendFails?: boolean; now?: string } = {}) {
  const j = jobs();
  const w = world({ now: over.now ?? "2026-10-05T09:00:00-06:00", report: over.report, sendFails: () => !!over.sendFails });
  const calls: string[] = [];
  const deps: CloseCronDeps = {
    ...j.base, now: () => at(over.now ?? "2026-10-05T15:00:00Z"),
    sync: async () => { calls.push("sync"); return { problems: over.syncProblems ?? [] }; },
    bankProblems: async () => over.bankProblems ?? [],
    close: w.deps,
  };
  return { deps, j, w, calls };
}
{
  const off = closeJob();
  assert.deepEqual(await monthlyClose(off.deps, {}), { status: "disabled" });
  assert.equal(off.calls.length + off.w.state.locks + off.j.notices.length, 0, "disabled: no sync, no lock, no email");

  const ok = closeJob();
  assert.deepEqual(await monthlyClose(ok.deps, ON), { status: "sent", month: "2026-09" });
  assert.deepEqual(ok.calls, ["sync"]);
  assert.equal(ok.w.state.snaps.get("2026-09")!.status, "LOCKED");
  assert.equal(ok.w.state.sends.length, 1);
  assert.equal(ok.j.notices.length, 0, "success sends the report itself, no extra notice");
  assert.ok(ok.w.state.audits.find((a) => a.action === "report.lock")!.payload.auto === true, "marked as an automatic lock");
  // calling it again (a retry, or the cron firing twice) is a no-op
  assert.deepEqual(await monthlyClose(ok.deps, ON), { status: "already_done", month: "2026-09" });
  assert.equal(ok.w.state.sends.length, 1);

  // unreviewed transactions: never locked automatically; the owner is told why
  const un = closeJob({ report: mkReport(4) });
  assert.deepEqual(await monthlyClose(un.deps, ON), { status: "blocked", month: "2026-09" });
  assert.equal(un.w.state.snaps.size, 0, "not locked");
  assert.equal(un.w.state.sends.length, 0, "not sent");
  assert.match(un.j.notices[0].subject, /September report was not sent/);
  assert.match(un.j.notices[0].body, /4 bank transactions are still waiting for review/);
  assert.equal(un.j.done.get("monthly-close:2026-09"), "FAILED", "so it can be run again after the review");

  // a bank that needs attention
  const bank = closeJob({ bankProblems: ["Bank of America needs attention (login required)"] });
  assert.equal((await monthlyClose(bank.deps, ON)).status, "blocked");
  assert.match(bank.j.notices[0].body, /Bank of America needs attention/);

  // the sync fails: no lock at all, whatever the report says
  const sy = closeJob({ syncProblems: ["Clover sync failed: timeout"] });
  assert.deepEqual(await monthlyClose(sy.deps, ON), { status: "synced_failed", month: "2026-09" });
  assert.equal(sy.w.state.locks, 0);
  assert.match(sy.j.notices[0].body, /Clover sync failed/);

  // locked, but the mailer fails: the month stays locked and the owner is told
  const sf = closeJob({ sendFails: true });
  assert.deepEqual(await monthlyClose(sf.deps, ON), { status: "send_failed", month: "2026-09" });
  assert.equal(sf.w.state.snaps.get("2026-09")!.status, "LOCKED");
  assert.equal(sf.w.state.snaps.get("2026-09")!.emailSentAt, null);
  assert.ok(sf.j.notices.length >= 1);

  // a crash inside the job still reports instead of throwing
  const crash = closeJob();
  crash.deps.sync = async () => { throw new Error("kaboom"); };
  assert.equal((await monthlyClose(crash.deps, ON)).status, "send_failed");
  assert.equal(crash.j.done.get("monthly-close:2026-09"), "FAILED");

  // the 5th is more than 3 days after the month ended, so eligibility never blocks the scheduled run; but the same job run on the 2nd would
  const early = closeJob({ now: "2026-10-02T15:00:00Z" });
  early.deps.close = world({ now: "2026-10-02T09:00:00-06:00" }).deps; // before Oct 4? September ended Oct 1: 1 day ago
  assert.equal((await monthlyClose(early.deps, ON)).status, "blocked");
}

// ---- preflight ---------------------------------------------------------------------------------------------------------------
{
  assert.equal(autoSendCheck({}).status, "info");
  assert.equal(autoSendCheck({ REPORTS_AUTO_SEND: "yes" }).status, "info");
  assert.match(autoSendCheck({ REPORTS_AUTO_SEND: "yes" }).message, /only "true" turns it on/);
  const missing = autoSendCheck({ REPORTS_AUTO_SEND: "true", APPS_SCRIPT_URL: "u" });
  assert.equal(missing.status, "fail");
  assert.match(missing.message, /APPS_SCRIPT_SECRET, CRON_SECRET are not set/);
  assert.equal(autoSendCheck({ REPORTS_AUTO_SEND: "true", APPS_SCRIPT_URL: "u", APPS_SCRIPT_SECRET: "s", CRON_SECRET: "c" }).status, "pass");
}

console.log("close: all checks passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
