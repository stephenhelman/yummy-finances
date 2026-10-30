import assert from "node:assert/strict";
import { applyRules, isFrozen, patchFor, type Patch, type RulesStore, type StoredTxn } from "../src/lib/rules/apply";
import { ALL_RULES } from "../src/lib/rules/all";
import { defToRow, mergeForUpsert, rowToDef } from "../src/lib/rules/convert";
import { classify } from "../src/lib/rules/engine";
import { summarize, type SummaryRow } from "../src/lib/rules/summary";
import { runSync, type FetchPage, type PlaidPage, type SyncStore, type WriteOp } from "../src/lib/plaid/sync";
import type { ExistingTxn, PlaidTxnInput } from "../src/lib/plaid/map";
import type { RuleDef } from "../src/lib/rules/types";

// ---- accounts ---------------------------------------------------------------------------------
const BOA2879 = { id: "a2879", institution: "Bank of America", mask: "2879", type: "depository" };
const BOA9334 = { id: "a9334", institution: "Bank of America", mask: "9334", type: "depository" };
const CHASE = { id: "c6318", institution: "Chase", mask: "6318", type: "credit" };
const ACCOUNTS = [BOA2879, BOA9334, CHASE];

// ---- categories and persisted-style rules (code rules -> DB rows -> engine rules) ------------------
const catNames = [...new Set(ALL_RULES.map((r) => r.categoryName).filter((x): x is string => !!x))];
const categoryIdByName = new Map(catNames.map((n) => [n, `cat_${n}`]));
const nameById = new Map([...categoryIdByName].map(([n, id]) => [id, n]));
const dbRules = ALL_RULES.map((d, i) => ({ id: `rule${i}`, ...defToRow(d, categoryIdByName) }));
const ruleIdByKey = new Map(dbRules.map((r) => [r.key, r.id]));
const rulesFromDb: RuleDef[] = dbRules.map((r) => rowToDef(r, nameById));

// ---- a row that serves both the rules store and the sync store ----------------------------------------
type Row = StoredTxn & {
  pending: boolean;
  removedAt: Date | null;
  supersededAt: Date | null;
  pendingTransactionId: string | null;
  authorizedDate: string | null;
  merchantName: string | null;
  paymentChannel: string | null;
  pfcVersion: string | null;
  pfcConfidence: string | null;
  adjustmentBaseCents: number | null;
};

let seq = 0;
const row = (raw: string, cents: number, account = BOA2879, date = "2026-06-10", extra: Partial<Row> = {}): Row => {
  const id = `r${++seq}`;
  return {
    id, plaidTransactionId: `p${seq}`, date, amountCents: cents, raw, pfcPrimary: null, pfcDetailed: null, account,
    kind: null, categoryId: null, categorySource: "NONE", ruleId: null, pairId: null, reviewStatus: "NEEDS_REVIEW", confirmed: false, normalizedMerchant: null,
    isLate: false, adjustmentMonth: null, pending: false, removedAt: null, supersededAt: null, pendingTransactionId: null, authorizedDate: null, merchantName: null, paymentChannel: null, pfcVersion: null, pfcConfidence: null, adjustmentBaseCents: null,
    ...extra,
  };
};

class MemStore implements RulesStore {
  writes: { ids: string[]; patch: Patch }[] = [];
  manualWriteAttempts = 0;
  constructor(public rows: Row[], public locked = new Set<string>(), public rules: RuleDef[] = rulesFromDb) {}
  async loadRules() { return { rules: this.rules, categoryIdByName }; }
  async loadTransactions(range: { from: string; to: string } | null) {
    return this.rows.filter((r) => !r.pending && !r.removedAt && !r.supersededAt && (!range || (r.date >= range.from && r.date <= range.to))).map((r) => ({ ...r }));
  }
  async datesOf(ids: string[]) { return this.rows.filter((r) => ids.includes(r.plaidTransactionId)).map((r) => r.date); }
  async lockedMonths() { return this.locked; }
  async clearUnprocessedKinds() {
    let n = 0;
    for (const r of this.rows) if (r.kind !== null && r.categorySource === "NONE" && r.normalizedMerchant === null && r.ruleId === null && r.pairId === null) { r.kind = null; n++; }
    return n;
  }
  async writePatch(ids: string[], patch: Patch) {
    this.writes.push({ ids, patch });
    for (const r of this.rows) {
      if (!ids.includes(r.id)) continue;
      if (r.categorySource === "MANUAL") { this.manualWriteAttempts++; continue; } // the DB guard
      Object.assign(r, patch);
    }
  }
  get(id: string) { return this.rows.find((r) => r.id === id)!; }
}

const status = (r: StoredTxn): SummaryRow["status"] => (r.reviewStatus === "NEEDS_REVIEW" ? "NEEDS_REVIEW" : r.confirmed ? "AUTO" : "AUTO_UNCONFIRMED");
const snapshot = (rs: Row[]) => JSON.stringify(rs.map((r) => [r.id, r.kind, r.categoryId, r.categorySource, r.ruleId, r.pairId, r.reviewStatus, r.confirmed, r.normalizedMerchant]));

// ---- a realistic fixture -------------------------------------------------------------------------------
function fixture(): Row[] {
  return [
    row("BANKCARD-1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SD CCD", -184562, BOA2879, "2026-06-01"),
    row("BANKCARD 1250 DES:MTOT DISC ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106123456SM CCD", 5500, BOA2879, "2026-06-02"),
    row("BKOFAMERICA ATM 06/03 #XXXXX2228 DEPOSIT JOE BATTLE EL PASO TX CKCD XXXXXXXXXX123456", -50000, BOA2879, "2026-06-03"),
    row("Online Banking transfer to CHK 3831 Confirmation# XXXXX1", 150000, BOA2879, "2026-06-04"),
    row("Online Banking transfer from CHK 3831 Confirmation# XXXXX2", -90000, BOA9334, "2026-06-05"),
    // an internal transfer: two sides, two accounts, one day apart
    row("Online Banking transfer to CHK 9334 Confirmation# XXXXX3", 400000, BOA2879, "2026-06-08"),
    row("Online Banking transfer from CHK 2879 Confirmation# XXXXX4", -400000, BOA9334, "2026-06-09"),
    // a card payment across the two banks, plus a Chase payment credit with no matching outflow
    row("CHASE CREDIT CRD DES:EPAY ID:XXXXX02639 INDN:CARD HOLDER CO ID:XXXXX99999 WEB", 120000, BOA2879, "2026-06-12"),
    row("Payment Thank You-Mobile", -120000, CHASE, "2026-06-10"),
    row("Payment Thank You-Mobile", -75500, CHASE, "2026-06-15"),
    // vendors: seed, owner rules, refunds
    row("CHECKCARD 0611 SAMSCLUB.COM XXXXX67726 AR XXXXX8253XXXXXXXXXX1234 CKCD 5300", 18000, BOA2879, "2026-06-11"),
    row("SAMS CLUB #6502", -4400, CHASE, "2026-06-13"),
    row("CREAMLAND", 120000, CHASE, "2026-06-14"),
    row("EL PASO PRODUC 06/13 #XXXXX3812 PURCHASE 3701 ALAMEDA AVE EL PASO TX CKCD 5499", 9341, BOA2879, "2026-06-14"),
    row("SEGOVIAS DISTR 06/08 #XXXXX8851 PURCHASE 3701 SHELL STREET EL PASO TX CKCD 5411", 13087, BOA2879, "2026-06-09"),
    row("OVERDRAFT ITEM FEE FOR ACTIVITY OF 06-18 ELECTRONIC TRANSACTION POSTING DATE 06-19-26", 1000, BOA2879, "2026-06-19"),
    row("PURCHASE 1020 ATT*BILL PAYMENT XXXXX99999 TX XXXXX9999XXXXXXXXXX9999 RECURRING CKCD 4814", 9720, BOA2879, "2026-06-20"),
    row("SQ *S. J. MEXICAN SPECIAL", 48256, CHASE, "2026-06-16"),
    row("Payroll-Homebase DES:PCR ID:dbfdcfb9a99c99e INDN:La Michoacana Yummy LL CO ID:XXXXX99999 CCD", 250000, BOA9334, "2026-06-18"),
    row("DAVO TECHNOLOGIE DES:ACH ID:888-659-8432 INDN:LA MICHOACANA YUMMY LA CO ID:XXXXX12345 PPD", 11000, BOA2879, "2026-06-18"),
    row("FirstLight FCU DES:ACH ORGTN ID:XXXXXXXXXX88468 INDN:SOMEONE,NAME CO ID:XXXXX99999 PPD", 36000, BOA2879, "2026-06-20"),
    row("PURCHASE INTEREST CHARGE", 14000, CHASE, "2026-06-21"),
    // rent check (in range) and other checks (stay in review)
    row("Check 1391", 440951, BOA2879, "2026-06-22"),
    row("Check 169", 26804, BOA2879, "2026-06-22"),
    row("Check 170", 505800, BOA2879, "2026-06-23"),
    // unmatched: Zelle, restaurants, unknown inflow
    row("Zelle payment to Yummy Alex Marquez Conf# xbdw90cjk", 52000, BOA2879, "2026-06-26"),
    row("CHECKCARD 0627 TACO CABANA 20297 EL PASO TX XXXXX5261XXXXXXXXXX1234 CKCD 5814", 2272, BOA2879, "2026-06-27"),
    row("Zelle payment from HUBERT G TERRAZAS Conf# 99c3k43ik", -53500, BOA2879, "2026-06-28"),
    // a coincidence that must NOT pair: a purchase and a Zelle credit of the same amount
    row("SAMS CLUB #650 EL PASO TX", 10000, BOA2879, "2026-06-29"),
    row("Zelle payment from SOMEONE ELSE Conf# a", -10000, BOA9334, "2026-06-29"),
  ];
}

const toInputs = (rs: Row[]) => rs.map((r) => ({ id: r.id, date: r.date, amountCents: r.amountCents, raw: r.raw, pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed, account: r.account }));

async function main() {
  // ===== persisted-rule roundtrip =====
  {
    const back = new Map(rulesFromDb.map((r, i) => [ALL_RULES[i].id, r]));
    for (const def of ALL_RULES) {
      const r = back.get(def.id)!;
      assert.deepEqual(
        [r.pattern, r.matchType, r.target, r.direction, r.kind, r.categoryName, r.priority, r.confirmed, r.source, r.amountMinCents, r.amountMaxCents, r.accounts],
        [def.pattern, def.matchType, def.target, def.direction, def.kind, def.categoryName, def.priority, def.confirmed, def.source, def.amountMinCents, def.amountMaxCents, def.accounts],
        `roundtrip ${def.id}`,
      );
    }
    assert.throws(() => defToRow({ ...ALL_RULES[0], categoryName: "No Such Category", kind: "EXPENSE" }, categoryIdByName), /does not exist/);
    // a person's decisions stick on re-seed: confirmed stays confirmed, switched-off stays off, the definition otherwise wins
    const row0 = dbRules[0];
    assert.equal(mergeForUpsert(null, row0).key, row0.key);
    assert.equal(mergeForUpsert({ confirmed: true, active: true }, { ...row0, confirmed: false }).confirmed, true);
    assert.equal(mergeForUpsert({ confirmed: false, active: false }, { ...row0, active: true }).active, false);
    assert.equal(mergeForUpsert({ confirmed: false, active: true }, { ...row0, pattern: "CHANGED" }).pattern, "CHANGED");
  }

  // ===== stored results equal the dry run on a fixture =====
  {
    const store = new MemStore(fixture());
    const result = await applyRules(store, { all: true });
    assert.equal(result.changed, store.rows.length);
    assert.equal(result.skippedManual + result.skippedLocked, 0);
    const fresh = new Map(classify(toInputs(store.rows), ALL_RULES).map((d) => [d.txnId, d]));
    for (const r of store.rows) {
      const d = fresh.get(r.id)!;
      assert.deepEqual(
        [r.kind, r.categoryId ? nameById.get(r.categoryId) : null, status(r), r.categorySource, r.pairId, r.normalizedMerchant],
        [d.kind, d.categoryName, d.status, d.via === "pair" ? "PAIR" : d.via === "default" ? "NONE" : "RULE", d.via === "pair" ? [r.id, d.pairedWith!].sort()[0] : null, d.normalized],
        `${r.raw.slice(0, 45)}`,
      );
    }
    // the same summary from stored rows and from the fresh classification
    const asSummary = (rs: Row[]) => rs.map((r): SummaryRow => ({ date: r.date, amountCents: r.amountCents, kind: r.kind, status: status(r), categoryName: r.categoryId ? nameById.get(r.categoryId) ?? null : null }));
    const freshRows = store.rows.map((r): SummaryRow => { const d = fresh.get(r.id)!; return { date: r.date, amountCents: r.amountCents, kind: d.kind, status: d.status, categoryName: d.categoryName }; });
    assert.deepEqual(summarize(asSummary(store.rows)), summarize(freshRows));

    // spot checks of what was stored
    const by = (frag: string) => store.rows.find((r) => r.raw.includes(frag))!;
    assert.deepEqual([by("MTOT DEP").kind, by("MTOT DEP").reviewStatus, by("MTOT DEP").confirmed], ["CLOVER_SETTLEMENT", "AUTO", false]);
    assert.equal(by("MTOT DEP").confirmed, false, "an unconfirmed seed rule is applied but unconfirmed");
    assert.deepEqual([by("MTOT DISC").kind, nameById.get(by("MTOT DISC").categoryId!), by("MTOT DISC").confirmed], ["EXPENSE", "Card processing fees", true], "the owner-accepted addition is confirmed");
    assert.deepEqual([by("to CHK 3831").kind, by("to CHK 3831").confirmed, by("to CHK 3831").categorySource], ["OWNER_DRAW", true, "RULE"]);
    assert.equal(by("to CHK 3831").ruleId, ruleIdByKey.get("seed:owner-draw-3831"), "ruleId is the persisted rule's id");
    const t1 = by("to CHK 9334"), t2 = by("from CHK 2879");
    assert.deepEqual([t1.kind, t2.kind, t1.categorySource, t2.categorySource, t1.ruleId, t1.confirmed], ["INTERNAL_TRANSFER", "INTERNAL_TRANSFER", "PAIR", "PAIR", null, true]);
    assert.equal(t1.pairId, t2.pairId, "both sides share a pairId");
    assert.ok(t1.pairId === [t1.id, t2.id].sort()[0]);
    const cp = by("CHASE CREDIT CRD"), cr = store.rows.find((r) => r.raw === "Payment Thank You-Mobile" && r.date === "2026-06-10")!;
    assert.deepEqual([cp.kind, cr.kind, cp.pairId === cr.pairId && !!cp.pairId], ["CARD_PAYMENT", "CARD_PAYMENT", true]);
    const lone = store.rows.find((r) => r.raw === "Payment Thank You-Mobile" && r.date === "2026-06-15")!;
    assert.deepEqual([lone.kind, lone.categorySource, lone.pairId, lone.reviewStatus, lone.confirmed], ["CARD_PAYMENT", "RULE", null, "AUTO", true], "an unmatched Chase payment credit is still a card payment, never income");
    assert.deepEqual([by("Check 1391").kind, nameById.get(by("Check 1391").categoryId!)], ["EXPENSE", "Rent"]);
    for (const frag of ["Check 169", "Check 170"]) assert.deepEqual([by(frag).kind, by(frag).reviewStatus, by(frag).categoryId], [null, "NEEDS_REVIEW", null], frag);
    assert.deepEqual([by("TACO CABANA").kind, by("TACO CABANA").reviewStatus], [null, "NEEDS_REVIEW"]);
    assert.deepEqual([by("HUBERT").kind, by("HUBERT").reviewStatus], ["OTHER_INFLOW", "NEEDS_REVIEW"], "an unmatched inflow is flagged, never revenue");
    assert.equal(by("SAMS CLUB #650").pairId, null, "a purchase never pairs with a same-amount Zelle credit");
    assert.equal(by("EL PASO PRODUC").ruleId, ruleIdByKey.get("user:el-paso-produce:purchase"));
    // hard rule on stored data
    for (const r of store.rows) {
      if (r.amountCents < 0) assert.notEqual(r.kind, "EXPENSE");
      if (r.kind === "EXPENSE" || r.kind === "VENDOR_REFUND") assert.ok(r.categoryId); else assert.equal(r.categoryId, null);
    }
  }

  // ===== legacy default kinds: rows the engine never looks at must not claim to be EXPENSE =====
  {
    const live = row("SAMS CLUB #6502", 4400, CHASE, "2026-06-13");
    const pendingRow = row("SAMS CLUB #650 EL PASO TX", 3000, BOA2879, "2026-06-14", { pending: true, kind: "EXPENSE" }); // legacy default, never processed
    const removedInflow = row("Zelle payment from SOMEONE Conf# a", -5000, BOA9334, "2026-06-14", { removedAt: new Date(), kind: "EXPENSE" });
    const manualKeep = row("CREAMLAND", 100, CHASE, "2026-06-14", { pending: true, kind: "OWNER_DRAW", categorySource: "MANUAL", reviewStatus: "REVIEWED", confirmed: true });
    const processedPending = row("CREAMLAND", 100, CHASE, "2026-06-14", { pending: true, kind: "EXPENSE", categorySource: "RULE", normalizedMerchant: "CREAMLAND", ruleId: "ruleX" });
    const store = new MemStore([live, pendingRow, removedInflow, manualKeep, processedPending]);
    const res = await applyRules(store, { all: true });
    assert.equal(res.legacyCleared, 2);
    assert.deepEqual([pendingRow.kind, removedInflow.kind], [null, null], "stale default kinds cleared");
    assert.equal(live.kind, "EXPENSE");
    assert.equal(manualKeep.kind, "OWNER_DRAW", "a person's choice is never cleared");
    assert.equal(processedPending.kind, "EXPENSE", "a processed row keeps its kind");
    assert.equal((await applyRules(store, { all: true })).legacyCleared, 0, "idempotent");
    // scoped (sync-hook) runs do not do the global cleanup
    pendingRow.kind = "EXPENSE";
    assert.equal((await applyRules(store, { plaidTransactionIds: [live.plaidTransactionId] })).legacyCleared, 0);
    assert.equal(pendingRow.kind, "EXPENSE");
  }

  // ===== idempotent: a second run writes nothing =====
  {
    const store = new MemStore(fixture());
    await applyRules(store, { all: true });
    const before = snapshot(store.rows);
    const writes = store.writes.length;
    const again = await applyRules(store, { all: true });
    assert.deepEqual([again.changed, again.unchanged], [0, store.rows.length]);
    assert.equal(store.writes.length, writes, "no database writes on the second run");
    assert.equal(snapshot(store.rows), before);
    const third = await applyRules(store, { all: true });
    assert.equal(third.changed, 0);
  }

  // ===== manual categorizations are never overwritten, and manual rows do not take part in pairing =====
  {
    const rows = fixture();
    const sams = rows.find((r) => r.raw.startsWith("CHECKCARD 0611 SAMSCLUB"))!;
    Object.assign(sams, { kind: "EXPENSE", categoryId: "cat_Other COGS", categorySource: "MANUAL", reviewStatus: "REVIEWED", confirmed: true, normalizedMerchant: "MY OWN KEY" });
    const draw = rows.find((r) => r.raw.includes("to CHK 3831"))!;
    Object.assign(draw, { kind: "EXPENSE", categoryId: "cat_Rent", categorySource: "MANUAL", reviewStatus: "REVIEWED", confirmed: true });
    const transferOut = rows.find((r) => r.raw.includes("to CHK 9334"))!;
    Object.assign(transferOut, { kind: "OWNER_DRAW", categoryId: null, categorySource: "MANUAL", reviewStatus: "REVIEWED", confirmed: true }); // person said: this was a draw
    const manualBefore = JSON.stringify([sams, draw, transferOut].map((r) => [r.kind, r.categoryId, r.categorySource, r.normalizedMerchant, r.pairId]));
    const store = new MemStore(rows);
    const res = await applyRules(store, { all: true });
    await applyRules(store, { all: true });
    assert.equal(JSON.stringify([sams, draw, transferOut].map((r) => [r.kind, r.categoryId, r.categorySource, r.normalizedMerchant, r.pairId])), manualBefore, "manual rows are byte-for-byte untouched");
    assert.equal(store.manualWriteAttempts, 0, "applyRules never even asks to write a manual row");
    assert.equal(res.skippedManual, 3);
    // the manual draw is out of pairing: its would-be partner stays unpaired (falls back to the BoA transfer rule) instead of half-pairing
    const partner = rows.find((r) => r.raw.includes("from CHK 2879"))!;
    assert.equal(partner.pairId, null);
    assert.equal(partner.kind, "INTERNAL_TRANSFER");
    assert.equal(partner.categorySource, "RULE", "classified by the fallback rule, not by a pair");
    // the database-level guard also holds if a row turns manual between load and write
    const racing = new MemStore([row("SAMS CLUB #6502", 4400, CHASE, "2026-06-13")]);
    const r0 = racing.rows[0];
    const original = racing.loadTransactions.bind(racing);
    racing.loadTransactions = async (range) => { const out = await original(range); r0.categorySource = "MANUAL"; r0.kind = "OWNER_DRAW"; return out; };
    await applyRules(racing, { all: true });
    assert.equal(racing.manualWriteAttempts, 1, "the store was asked, the guard refused");
    assert.equal(r0.kind, "OWNER_DRAW");
  }

  // ===== locked months are untouched; a late row in an open adjustment month is classified =====
  {
    const rows = [
      row("SAMS CLUB #6502", 4400, CHASE, "2026-03-10"), // March is locked: frozen
      row("SAMS CLUB #6502", 4400, CHASE, "2026-04-10"), // April open
      row("SAMS CLUB #6502", 4400, CHASE, "2026-03-20", { isLate: true, adjustmentMonth: "2026-04" }), // late into the open April
      row("SAMS CLUB #6502", 4400, CHASE, "2026-03-21", { isLate: true, adjustmentMonth: "2026-03" }), // late into a month that is itself locked
      row("SAMS CLUB #6502", 4400, CHASE, "2026-03-22", { isLate: true, adjustmentMonth: null }),
    ];
    const store = new MemStore(rows, new Set(["2026-03"]));
    const res = await applyRules(store, { all: true });
    assert.deepEqual([rows[0].kind, rows[0].categorySource, rows[0].normalizedMerchant], [null, "NONE", null], "locked month untouched");
    assert.equal(rows[1].kind, "EXPENSE");
    assert.equal(rows[2].kind, "EXPENSE", "a late row belongs to the open adjustment month, so it is classified");
    assert.deepEqual([rows[3].kind, rows[4].kind], [null, null], "late into a locked month / no adjustment month: frozen");
    assert.deepEqual([res.skippedLocked, res.changed], [3, 2]);
    assert.equal(isFrozen({ date: "2026-03-10", isLate: false, adjustmentMonth: null }, new Set(["2026-03"])), true);
    assert.equal(isFrozen({ date: "2026-04-10", isLate: false, adjustmentMonth: null }, new Set(["2026-03"])), false);
    // a rule change cannot rewrite a locked month either
    const changed = rulesFromDb.map((r) => (r.name.startsWith("Sam's Club (purchases)") ? { ...r, categoryName: "Rent" } : r));
    const s2 = new MemStore(rows, new Set(["2026-03"]), changed);
    await applyRules(s2, { all: true });
    assert.equal(rows[0].categoryId, null);
    assert.equal(rows[1].categoryId, "cat_Rent", "an open month does follow the new rule");
  }

  // ===== rules changing: removed rule reverts a row to review; manual untouched; only non-manual rows move =====
  {
    const rows = [row("CREAMLAND", 120000, CHASE, "2026-06-14"), row("EL PASO PRODUC 06/13 #X PURCHASE", 9341, BOA2879, "2026-06-14")];
    const store = new MemStore(rows);
    await applyRules(store, { all: true });
    assert.ok(rows.every((r) => r.kind === "EXPENSE"));
    store.rules = rulesFromDb.filter((r) => !r.name.startsWith("Creamland"));
    const res = await applyRules(store, { all: true });
    assert.equal(res.changed, 1);
    assert.deepEqual([rows[0].kind, rows[0].categorySource, rows[0].ruleId, rows[0].reviewStatus, rows[0].confirmed], [null, "NONE", null, "NEEDS_REVIEW", false]);
    assert.equal(rows[1].kind, "EXPENSE");
  }

  // ===== scoped apply: only the neighborhood of what changed; partners at the edge still pair =====
  {
    const far = row("SAMS CLUB #6502", 4400, CHASE, "2026-01-05"); // stale and far away: must not be touched
    const a = row("Online Banking transfer to CHK 9334 Confirmation# X", 400000, BOA2879, "2026-06-10");
    const b = row("Online Banking transfer from CHK 2879 Confirmation# X", -400000, BOA9334, "2026-06-15"); // 5 days later
    const bystander = row("CREAMLAND", 100000, CHASE, "2026-06-12");
    const store = new MemStore([far, a, b, bystander]);
    const res = await applyRules(store, { plaidTransactionIds: [b.plaidTransactionId] });
    assert.deepEqual([a.kind, b.kind, a.pairId === b.pairId && !!a.pairId], ["INTERNAL_TRANSFER", "INTERNAL_TRANSFER", true], "re-pairs the earlier row that was not in the changed set");
    assert.equal(bystander.kind, "EXPENSE", "rows in the window are classified");
    assert.equal(far.kind, null, "rows outside the window are not touched");
    assert.deepEqual(res.window, { from: "2026-06-10", to: "2026-06-20" });
    assert.equal((await applyRules(store, { plaidTransactionIds: ["nope"] })).considered, 0);
    // a removed row (not in the live set) still defines the window, so its old partner is re-evaluated
    b.removedAt = new Date();
    await applyRules(store, { plaidTransactionIds: [b.plaidTransactionId] });
    assert.deepEqual([a.pairId, a.categorySource, a.kind], [null, "RULE", "INTERNAL_TRANSFER"], "unpaired again: fallback rule, no pair");
  }

  // ===== sync hook: new rows are categorized right after the cursor commits =====
  {
    const rows: Row[] = [];
    const rules = new MemStore(rows);
    let cursor = "";
    const syncStore: SyncStore = {
      accountIds: async () => new Map(ACCOUNTS.map((a) => [`plaid_${a.id}`, a.id])),
      refreshAccounts: async () => {},
      loadExisting: async (ids) => new Map(rows.filter((r) => ids.includes(r.plaidTransactionId)).map((r) => [r.plaidTransactionId, {
        plaidTransactionId: r.plaidTransactionId, accountPlaidId: `plaid_${r.account.id}`, pendingTransactionId: r.pendingTransactionId, pending: r.pending, date: r.date, authorizedDate: r.authorizedDate, amountCents: r.amountCents,
        rawDescription: r.raw, merchantName: r.merchantName, paymentChannel: r.paymentChannel, pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed, pfcConfidence: r.pfcConfidence, pfcVersion: r.pfcVersion,
        removedAt: r.removedAt, supersededAt: r.supersededAt, isLate: r.isLate, adjustmentMonth: r.adjustmentMonth, adjustmentBaseCents: r.adjustmentBaseCents,
      } satisfies ExistingTxn])),
      lockedMonths: async () => new Set(),
      apply: async (op: WriteOp) => {
        if (op.type === "create") {
          for (const c of op.rows) {
            const acct = ACCOUNTS.find((a) => a.id === c.accountId)!;
            rows.push(row(c.rawDescription, c.amountCents, acct, c.date, { plaidTransactionId: c.plaidTransactionId, pending: c.pending }));
          }
        } else if (op.type === "update") {
          for (const u of op.rows) Object.assign(rows.find((r) => r.plaidTransactionId === u.plaidTransactionId)!, { raw: u.row.rawDescription, amountCents: u.row.amountCents, date: u.row.date });
        } else if (op.type === "remove") {
          for (const rm of op.rows) rows.find((r) => r.plaidTransactionId === rm.plaidTransactionId)!.removedAt = op.at;
        }
      },
      commitCursor: async (c) => { cursor = c; },
    };
    const tx = (id: string, acct: string, raw: string, amount: number, date: string): PlaidTxnInput => ({ transaction_id: id, account_id: `plaid_${acct}`, pending: false, date, amount, original_description: raw, name: raw });
    const page = (o: Partial<PlaidPage>): PlaidPage => ({ added: [], modified: [], removed: [], next_cursor: "c", has_more: false, ...o });
    const run = (pages: Record<string, PlaidPage>, hook = true) => runSync({
      startCursor: cursor, fetchPage: (async (c: string) => pages[c]) as FetchPage, store: syncStore, now: new Date("2026-06-30T12:00:00Z"), openMonth: "2026-06",
      afterCommit: hook ? (ids) => applyRules(rules, { plaidTransactionIds: ids }) : undefined,
    });

    // sync 1: new rows come in unclassified and are categorized by the hook
    const o1 = await run({ "": page({ next_cursor: "c1", added: [
      tx("t1", BOA2879.id, "CHECKCARD 0611 SAMSCLUB.COM XXXXX67726 AR CKCD 5300", 180.0, "2026-06-11"),
      tx("t2", BOA2879.id, "BANKCARD-1250 DES:MTOT DEP ID:XXXXXXXXXX68309 INDN:LA MICHOACANA YUMMY CO ID:106 CCD", -1845.62, "2026-06-12"),
      tx("t3", BOA2879.id, "Online Banking transfer to CHK 9334 Confirmation# XXXXX3", 4000, "2026-06-15"),
      tx("t4", BOA2879.id, "Some Unknown Vendor", 12.5, "2026-06-15"),
    ] }) });
    assert.equal(o1.status, "synced");
    if (o1.status !== "synced") return;
    assert.equal(o1.rulesError, undefined);
    assert.equal(o1.rules?.changed, 4);
    const g = (id: string) => rows.find((r) => r.plaidTransactionId === id)!;
    assert.deepEqual([g("t1").kind, nameById.get(g("t1").categoryId!), g("t2").kind, g("t4").kind, g("t4").reviewStatus], ["EXPENSE", "Supplies", "CLOVER_SETTLEMENT", null, "NEEDS_REVIEW"], "categorized right after the sync");
    assert.equal(g("t3").kind, "INTERNAL_TRANSFER", "even unpaired, the BoA transfer fallback rule applies");
    assert.equal(g("t3").categorySource, "RULE");
    assert.equal(cursor, "c1", "cursor committed");

    // sync 2: the other side of the transfer arrives two days later: BOTH sides are now paired (t3 was not in this sync's changed set)
    const o2 = await run({ c1: page({ next_cursor: "c2", added: [tx("t5", BOA9334.id, "Online Banking transfer from CHK 2879 Confirmation# XXXXX4", -4000, "2026-06-17")] }) });
    assert.equal(o2.status === "synced" && o2.rules?.changed, 2, "the new row and its partner");
    assert.deepEqual([g("t3").categorySource, g("t5").categorySource, g("t3").pairId === g("t5").pairId && !!g("t3").pairId], ["PAIR", "PAIR", true], "re-paired within the 5-day window");

    // sync 3: nothing categorizable changed -> hook not called
    let called = 0;
    const o3 = await runSync({ startCursor: cursor, fetchPage: (async () => page({ next_cursor: "c3" })) as FetchPage, store: syncStore, now: new Date(), openMonth: "2026-06", afterCommit: async () => { called++; return { considered: 0, changed: 0, unchanged: 0, skippedManual: 0, skippedLocked: 0, needsReview: 0, window: null, legacyCleared: 0 }; } });
    assert.equal(o3.status, "synced");
    assert.equal(called, 0, "no changes: no categorizing pass");

    // sync 4: a modified row (amount changed) is re-evaluated; a removed row un-pairs its partner
    const o4 = await run({ c3: page({ next_cursor: "c4", modified: [tx("t1", BOA2879.id, "CHECKCARD 0611 SAMSCLUB.COM XXXXX67726 AR CKCD 5300", 150.0, "2026-06-11")], removed: [{ transaction_id: "t5" }] }) });
    assert.equal(o4.status, "synced");
    assert.equal(g("t1").amountCents, 15000);
    assert.deepEqual([g("t3").categorySource, g("t3").pairId, g("t3").kind], ["RULE", null, "INTERNAL_TRANSFER"], "the removed row's partner is un-paired");

    // the hook cannot fail the sync: the error is reported, the cursor is already committed
    const failing = await runSync({ startCursor: cursor, fetchPage: (async () => page({ next_cursor: "c5", added: [tx("t6", BOA2879.id, "CREAMLAND", 100, "2026-06-20")] })) as FetchPage, store: syncStore, now: new Date(), openMonth: "2026-06", afterCommit: async () => { throw new Error("categorizing exploded"); } });
    assert.equal(failing.status, "synced");
    if (failing.status === "synced") assert.equal(failing.rulesError, "categorizing exploded");
    assert.equal(cursor, "c5", "cursor advanced despite the hook failing");
    assert.equal(rows.some((r) => r.plaidTransactionId === "t6"), true, "the data is stored");
    // and the next sync's pass picks up what the failed one missed (idempotent, window-based)
    await applyRules(rules, { plaidTransactionIds: ["t6"] });
    assert.equal(g("t6").kind, "EXPENSE");
  }

  // ===== patchFor details =====
  {
    const d = (o: Partial<ReturnType<typeof classify>[number]>) => ({ txnId: "a", direction: "out" as const, kind: "EXPENSE" as const, categoryName: "Rent", status: "AUTO" as const, via: "rule" as const, ruleId: "r1", pairedWith: null, ambiguousPair: false, normalized: "X", ...o });
    assert.deepEqual(patchFor(d({}), categoryIdByName), { kind: "EXPENSE", categoryId: "cat_Rent", categorySource: "RULE", ruleId: "r1", pairId: null, reviewStatus: "AUTO", confirmed: true, normalizedMerchant: "X" });
    assert.equal(patchFor(d({ status: "AUTO_UNCONFIRMED" }), categoryIdByName).confirmed, false);
    assert.equal(patchFor(d({ via: "system", ruleId: "system:card-payment-credit", kind: "CARD_PAYMENT", categoryName: null }), categoryIdByName).ruleId, null, "system rules have no Rule row");
    assert.deepEqual([patchFor(d({ via: "pair", pairedWith: "b", txnId: "z", kind: "INTERNAL_TRANSFER", categoryName: null, ruleId: null }), categoryIdByName).pairId, patchFor(d({ via: "pair", pairedWith: "a", txnId: "b", kind: "INTERNAL_TRANSFER", categoryName: null, ruleId: null }), categoryIdByName).pairId], ["b", "a"], "both sides compute the same pairId");
    const review = patchFor(d({ kind: null, categoryName: null, status: "NEEDS_REVIEW", via: "default", ruleId: null }), categoryIdByName);
    assert.deepEqual([review.kind, review.categorySource, review.reviewStatus, review.confirmed], [null, "NONE", "NEEDS_REVIEW", false]);
    assert.throws(() => patchFor(d({ categoryName: "Nope" }), categoryIdByName), /does not exist/);
  }

  console.log("rules apply ok");
}
main().catch((e) => { console.error(e); process.exit(1); });
