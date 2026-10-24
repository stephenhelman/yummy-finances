import assert from "node:assert/strict";
import { isReportable, lateAdjustment, mapPlaidTransaction, type ExistingTxn, type PlaidTxnInput } from "../src/lib/plaid/map";
import { fetchAllUpdates, runSync, type FetchPage, type PlaidPage, type SyncStore, type WriteOp } from "../src/lib/plaid/sync";

// ---- fixtures -------------------------------------------------------------------------------
const NOW = new Date("2026-10-24T18:00:00Z");
const OPEN = "2026-10";

let seq = 0;
const tx = (o: Partial<PlaidTxnInput> & { transaction_id?: string } = {}): PlaidTxnInput => ({
  transaction_id: o.transaction_id ?? `t${++seq}`,
  account_id: "acc1",
  pending: false,
  pending_transaction_id: null,
  date: "2026-10-10",
  authorized_date: null,
  amount: 12.34,
  name: "Some Name",
  original_description: "SOME VENDOR #123 EL PASO TX",
  merchant_name: "Some Vendor",
  payment_channel: "in store",
  personal_finance_category: { primary: "GENERAL_MERCHANDISE", detailed: "GENERAL_MERCHANDISE_OTHER", confidence_level: "HIGH", version: "v2" },
  ...o,
});
const page = (o: Partial<PlaidPage> = {}): PlaidPage => ({ added: [], modified: [], removed: [], next_cursor: "c", has_more: false, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", ...o });
const mutationError = () => Object.assign(new Error("mutation"), { response: { data: { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" } } });

// ---- in-memory store (same contract as the Prisma store) -------------------------------------
type Row = ExistingTxn & { accountId: string };
class MemStore implements SyncStore {
  rows = new Map<string, Row>();
  audits: string[] = [];
  cursor = "";
  locked = new Set<string>();
  known = new Set(["acc1"]);
  opLog: string[] = [];
  refreshCalls = 0;
  failOnApply: number | null = null; // fail the Nth apply() call (1-based)
  private applyCount = 0;
  async accountIds() { return new Map([...this.known].map((a) => [a, `id_${a}`])); }
  async refreshAccounts() { this.refreshCalls++; this.known.add("acc_new"); }
  async loadExisting(ids: string[]) { return new Map(ids.filter((i) => this.rows.has(i)).map((i) => [i, structuredClone(this.rows.get(i)!)])); }
  async lockedMonths(months: string[]) { return new Set(months.filter((m) => this.locked.has(m))); }
  async apply(op: WriteOp) {
    if (this.failOnApply !== null && ++this.applyCount === this.failOnApply) throw new Error("db exploded");
    this.opLog.push(op.type);
    if (op.type === "create") {
      for (const r of op.rows) if (!this.rows.has(r.plaidTransactionId)) {
        this.rows.set(r.plaidTransactionId, { isLate: false, adjustmentMonth: null, adjustmentBaseCents: null, ...r, removedAt: null, supersededAt: null });
      }
    } else if (op.type === "update") {
      for (const u of op.rows) this.rows.set(u.plaidTransactionId, { ...this.rows.get(u.plaidTransactionId)!, ...u.row, removedAt: null, ...u.late });
    } else if (op.type === "remove") {
      for (const r of op.rows) this.rows.set(r.plaidTransactionId, { ...this.rows.get(r.plaidTransactionId)!, removedAt: op.at, ...r.late });
    } else if (op.type === "supersede") {
      for (const id of op.ids) { const r = this.rows.get(id); if (r && !r.supersededAt) r.supersededAt = op.at; }
    } else this.audits.push(...op.entries.map((e) => e.message));
  }
  async commitCursor(c: string) { this.cursor = c; }
}

/** Serves pages keyed by the cursor they are requested with. */
const pager = (pages: Record<string, PlaidPage | (() => PlaidPage)>, calls: string[] = []): FetchPage => async (cursor) => {
  calls.push(cursor);
  const p = pages[cursor];
  if (!p) throw new Error(`unexpected cursor "${cursor}"`);
  return typeof p === "function" ? p() : p;
};
const sync = (store: MemStore, fetchPage: FetchPage, extra: { chunkSize?: number; maxRestarts?: number } = {}) =>
  runSync({ startCursor: store.cursor, fetchPage, store, now: NOW, openMonth: OPEN, ...extra });

async function main() {
  // ---- mapping ----
  {
    const m = mapPlaidTransaction(tx({ transaction_id: "m1", amount: -250.5, original_description: "ACH CREDIT CLOVER", name: "Clover" }));
    assert.equal(m.amountCents, -25050, "Plaid sign kept: negative = money in");
    assert.equal(mapPlaidTransaction(tx({ amount: 19.99 })).amountCents, 1999, "positive = money out");
    assert.equal(m.rawDescription, "ACH CREDIT CLOVER", "raw description comes from original_description");
    assert.equal(mapPlaidTransaction(tx({ original_description: null, name: "Fallback" })).rawDescription, "Fallback");
    const p = mapPlaidTransaction(tx());
    assert.deepEqual([p.pfcPrimary, p.pfcDetailed, p.pfcConfidence, p.pfcVersion, p.paymentChannel], ["GENERAL_MERCHANDISE", "GENERAL_MERCHANDISE_OTHER", "HIGH", "v2", "in store"]);
    assert.equal(mapPlaidTransaction(tx({ personal_finance_category: null })).pfcPrimary, null);
  }

  // ---- multi-page sync ----
  {
    const store = new MemStore();
    const calls: string[] = [];
    const out = await sync(store, pager({
      "": page({ added: [tx({ transaction_id: "a1" }), tx({ transaction_id: "a2" })], next_cursor: "c1", has_more: true }),
      c1: page({ added: [tx({ transaction_id: "a3" })], modified: [], next_cursor: "c2", has_more: true }),
      c2: page({ added: [tx({ transaction_id: "a4" })], next_cursor: "c3", has_more: false }),
    }, calls), { chunkSize: 2 });
    assert.equal(out.status, "synced");
    if (out.status !== "synced") return;
    assert.deepEqual(calls, ["", "c1", "c2"], "pages follow next_cursor");
    assert.equal(out.pages, 3);
    assert.equal(out.counts.created, 4);
    assert.equal(store.rows.size, 4);
    assert.equal(store.cursor, "c3", "cursor advances to the final next_cursor");
    // second run with no changes: nothing to do
    const again = await sync(store, pager({ c3: page({ next_cursor: "c3" }) }));
    assert.equal(again.status === "synced" && again.counts.created + again.counts.updated + again.counts.removed, 0);
  }

  // ---- mutation during pagination: discard and restart from the start cursor ----
  {
    const store = new MemStore();
    store.cursor = "c0";
    store.rows.set("keep", { ...(mapPlaidTransaction(tx({ transaction_id: "keep" })) as ExistingTxn), accountId: "id_acc1", removedAt: null, supersededAt: null, isLate: false, adjustmentMonth: null, adjustmentBaseCents: null });
    const calls: string[] = [];
    let page2Attempts = 0;
    const out = await sync(store, pager({
      c0: page({ added: [tx({ transaction_id: "n1" })], next_cursor: "c1", has_more: true }),
      c1: () => { if (++page2Attempts === 1) throw mutationError(); return page({ added: [tx({ transaction_id: "n2" })], next_cursor: "c2" }); },
    }, calls));
    assert.deepEqual(calls, ["c0", "c1", "c0", "c1"], "restarted from the cursor held at loop start, not just the failed page");
    assert.equal(out.status === "synced" && out.restarts, 1);
    assert.equal(out.status === "synced" && out.counts.created, 2, "page-1 rows from the failed attempt are not double counted");
    assert.deepEqual([...store.rows.keys()].sort(), ["keep", "n1", "n2"]);
    assert.equal(store.cursor, "c2");

    // persistent mutation: gives up, writes nothing, cursor untouched
    const s2 = new MemStore();
    s2.cursor = "c0";
    await assert.rejects(sync(s2, pager({ c0: () => { throw mutationError(); } }), { maxRestarts: 2 }), /mutation/);
    assert.equal(s2.cursor, "c0");
    assert.equal(s2.opLog.length, 0);
    // a non-mutation error is not retried
    let n = 0;
    await assert.rejects(fetchAllUpdates(async () => { n++; throw new Error("boom"); }, "", 3), /boom/);
    assert.equal(n, 1);
  }

  // ---- removed rows: flagged, not deleted; unknown ids ignored; re-add clears ----
  {
    const store = new MemStore();
    await sync(store, pager({ "": page({ added: [tx({ transaction_id: "r1" }), tx({ transaction_id: "r2" })], next_cursor: "c1" }) }));
    const out = await sync(store, pager({ c1: page({ removed: [{ transaction_id: "r1" }, { transaction_id: "never_seen" }], next_cursor: "c2" }) }));
    assert.equal(out.status === "synced" && out.counts.removed, 1, "unknown id is ignored");
    assert.ok(store.rows.get("r1")!.removedAt, "removed row is flagged");
    assert.equal(store.rows.size, 2, "nothing hard-deleted");
    assert.equal(isReportable(store.rows.get("r1")!), false);
    assert.equal(isReportable(store.rows.get("r2")!), true);
    await sync(store, pager({ c2: page({ added: [tx({ transaction_id: "r1" })], next_cursor: "c3" }) }));
    assert.equal(store.rows.get("r1")!.removedAt, null, "re-added row is live again");
    // added then removed within one run: never stored
    const s2 = new MemStore();
    await sync(s2, pager({ "": page({ added: [tx({ transaction_id: "z" })], next_cursor: "x", has_more: true }), x: page({ removed: [{ transaction_id: "z" }], next_cursor: "y" }) }));
    assert.equal(s2.rows.size, 0);
    // added then modified within one run: one row with the modified values
    const s3 = new MemStore();
    await sync(s3, pager({ "": page({ added: [tx({ transaction_id: "z", amount: 5 })], next_cursor: "x", has_more: true }), x: page({ modified: [tx({ transaction_id: "z", amount: 7 })], next_cursor: "y" }) }));
    assert.equal(s3.rows.get("z")!.amountCents, 700);
  }

  // ---- pending -> posted ----
  {
    const store = new MemStore();
    await sync(store, pager({ "": page({ added: [tx({ transaction_id: "p1", pending: true, amount: 40 })], next_cursor: "c1" }) }));
    assert.equal(isReportable(store.rows.get("p1")!), false, "pending is never reportable");
    await sync(store, pager({ c1: page({
      added: [tx({ transaction_id: "posted1", pending: false, pending_transaction_id: "p1", amount: 41.25, date: "2026-10-12" })],
      removed: [{ transaction_id: "p1" }],
      next_cursor: "c2",
    }) }));
    const pend = store.rows.get("p1")!;
    assert.ok(pend.supersededAt, "pending row marked superseded");
    assert.ok(pend.removedAt, "and removed when Plaid reports it");
    assert.equal(isReportable(pend), false);
    assert.equal(isReportable(store.rows.get("posted1")!), true);
    assert.equal(store.rows.get("posted1")!.amountCents, 4125, "posted amount differs from pending and wins");
    // superseded even when Plaid does NOT also list the pending id as removed
    const s2 = new MemStore();
    await sync(s2, pager({ "": page({ added: [tx({ transaction_id: "p9", pending: true })], next_cursor: "c1" }) }));
    await sync(s2, pager({ c1: page({ added: [tx({ transaction_id: "q9", pending_transaction_id: "p9" })], next_cursor: "c2" }) }));
    assert.ok(s2.rows.get("p9")!.supersededAt);
    assert.equal(s2.rows.get("p9")!.removedAt, null);
    // posted and pending in the same batch
    const s3 = new MemStore();
    await sync(s3, pager({ "": page({ added: [tx({ transaction_id: "p5", pending: true }), tx({ transaction_id: "q5", pending_transaction_id: "p5" })], next_cursor: "c1" }) }));
    assert.ok(s3.rows.get("p5")!.supersededAt);
  }

  // ---- late rows in a LOCKED month (Q5) ----
  {
    const store = new MemStore();
    store.locked = new Set(["2026-09"]);
    // new posted row dated in locked September: late, base 0
    await sync(store, pager({ "": page({ added: [
      tx({ transaction_id: "L1", date: "2026-09-30", amount: 100 }),
      tx({ transaction_id: "OK1", date: "2026-10-02", amount: 100 }),
      tx({ transaction_id: "PEND", date: "2026-09-30", pending: true, amount: 100 }),
    ], next_cursor: "c1" }) }));
    const l1 = store.rows.get("L1")!;
    assert.deepEqual([l1.isLate, l1.adjustmentMonth, l1.adjustmentBaseCents], [true, OPEN, 0]);
    assert.equal(store.rows.get("OK1")!.isLate, false, "open-month row is not late");
    assert.equal(store.rows.get("PEND")!.isLate, false, "pending rows are never adjustments");

    // a row that existed at lock time, then changes: base = what the snapshot counted
    const orig = { ...(mapPlaidTransaction(tx({ transaction_id: "O1", date: "2026-09-15", amount: 10 })) as ExistingTxn), accountId: "id_acc1", removedAt: null, supersededAt: null, isLate: false, adjustmentMonth: null, adjustmentBaseCents: null };
    store.rows.set("O1", orig);
    store.rows.set("O2", { ...orig, plaidTransactionId: "O2", amountCents: 2000 });
    store.rows.set("O3", { ...orig, plaidTransactionId: "O3", amountCents: 3000 });
    store.rows.set("O4", { ...orig, plaidTransactionId: "O4", amountCents: 4000 });
    await sync(store, pager({ c1: page({
      modified: [
        tx({ transaction_id: "O1", date: "2026-09-15", amount: 12 }), // 1000 -> 1200
        tx({ transaction_id: "O2", date: "2026-09-15", amount: 20, original_description: "RENAMED" }), // description only
        tx({ transaction_id: "O4", date: "2026-10-03", amount: 40 }), // moved Sep -> Oct
      ],
      removed: [{ transaction_id: "O3" }],
      next_cursor: "c2",
    }) }));
    const o1 = store.rows.get("O1")!;
    assert.deepEqual([o1.isLate, o1.adjustmentBaseCents, o1.amountCents], [true, 1000, 1200], "contribution = 1200 - 1000");
    assert.equal(store.rows.get("O2")!.isLate, false, "description-only edit changes no totals: no adjustment");
    const o3 = store.rows.get("O3")!;
    assert.deepEqual([o3.isLate, o3.adjustmentBaseCents, !!o3.removedAt], [true, 3000, true], "removed: contribution = 0 - 3000");
    assert.equal(store.rows.get("O4")!.isLate, false);
    assert.equal(store.audits.length, 1, "month move is left for manual review");
    assert.match(store.audits[0], /moved from 2026-09 to 2026-10/);

    // modified again in the same open month: base stays what the snapshot counted
    await sync(store, pager({ c2: page({ modified: [tx({ transaction_id: "O1", date: "2026-09-15", amount: 13 })], next_cursor: "c3" }) }));
    assert.deepEqual([store.rows.get("O1")!.adjustmentBaseCents, store.rows.get("O1")!.amountCents], [1000, 1300]);
    // a late-added row removed again keeps base 0 (net contribution 0)
    await sync(store, pager({ c3: page({ removed: [{ transaction_id: "L1" }], next_cursor: "c4" }) }));
    assert.deepEqual([store.rows.get("L1")!.adjustmentBaseCents, !!store.rows.get("L1")!.removedAt], [0, true]);
  }
  {
    // pure rule checks
    const base = { ...(mapPlaidTransaction(tx({ transaction_id: "E", date: "2026-09-15", amount: 10 })) as ExistingTxn), removedAt: null, supersededAt: null, isLate: false, adjustmentMonth: null, adjustmentBaseCents: null };
    const locked = new Set(["2026-09"]);
    assert.equal(lateAdjustment({ existing: null, next: { pending: false, date: "2026-10-01", amountCents: 5 }, lockedMonths: locked, openMonth: OPEN }), null);
    assert.equal(lateAdjustment({ existing: base, next: { pending: true, date: "2026-09-15", amountCents: 1000 }, lockedMonths: locked, openMonth: OPEN })?.hasOwnProperty("late"), true, "posted row turning pending removes it from the locked month");
    const prior = { ...base, isLate: true, adjustmentMonth: "2026-09", adjustmentBaseCents: 0 };
    const stale = lateAdjustment({ existing: prior, next: { pending: false, date: "2026-09-15", amountCents: 9 }, lockedMonths: locked, openMonth: OPEN });
    assert.ok(stale && "audit" in stale, "already adjusted into an older month: manual review");
    // pending row becoming posted inside a locked month is a late add
    const pendingRow = { ...base, pending: true };
    const d = lateAdjustment({ existing: pendingRow, next: { pending: false, date: "2026-09-15", amountCents: 1000 }, lockedMonths: locked, openMonth: OPEN });
    assert.deepEqual(d && "late" in d && d.late, { isLate: true, adjustmentMonth: OPEN, adjustmentBaseCents: 0 });
  }

  // ---- cursor must not advance when a chunk fails mid-way; the retry converges ----
  {
    const store = new MemStore();
    store.cursor = "c0";
    const rows = Array.from({ length: 5 }, (_, i) => tx({ transaction_id: `f${i}` }));
    const pages = { c0: page({ added: rows, next_cursor: "c1" }) };
    store.failOnApply = 2; // chunkSize 2 -> 3 create chunks; the 2nd fails after the 1st committed
    await assert.rejects(sync(store, pager(pages), { chunkSize: 2 }), /db exploded/);
    assert.equal(store.cursor, "c0", "cursor NOT advanced");
    assert.equal(store.rows.size, 2, "first chunk committed, rest not");
    store.failOnApply = null;
    const out = await sync(store, pager(pages), { chunkSize: 2 });
    assert.equal(out.status, "synced");
    assert.equal(store.rows.size, 5, "retry converged with no duplicates");
    assert.equal(store.cursor, "c1");
  }

  // ---- not ready ----
  {
    const store = new MemStore();
    const out = await sync(store, pager({ "": page({ next_cursor: "", transactions_update_status: "NOT_READY" }) }));
    assert.equal(out.status, "not_ready");
    assert.equal(store.cursor, "");
    assert.equal(store.opLog.length, 0);
    // a real but empty account is NOT "not ready": it has a cursor
    const empty = await sync(new MemStore(), pager({ "": page({ next_cursor: "c1", transactions_update_status: "HISTORICAL_UPDATE_COMPLETE" }) }));
    assert.equal(empty.status, "synced");
    await assert.rejects(sync(new MemStore(), pager({ "": page({ next_cursor: "", has_more: true }) })), /without a cursor/);
  }

  // ---- unknown account: one refresh, then fine; still unknown -> error ----
  {
    const store = new MemStore();
    const out = await sync(store, pager({ "": page({ added: [tx({ account_id: "acc_new" })], next_cursor: "c1" }) }));
    assert.equal(out.status, "synced");
    assert.equal(store.refreshCalls, 1);
    await assert.rejects(sync(new MemStore(), pager({ "": page({ added: [tx({ account_id: "ghost" })], next_cursor: "c1" }) })), /unknown account ghost/);
  }

  console.log("plaid sync ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
