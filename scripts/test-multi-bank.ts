// Multi-bank rules with no Plaid and no database: connect/duplicate/in-flight logic (plaid-connect),
// per-bank sync isolation (sync-all), and the unique constraint itself on an in-memory Postgres.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  PlaidConnectInProgressError,
  PlaidInstitutionAlreadyConnectedError,
  PlaidInstitutionUnknownError,
  connectWith,
  runExclusive,
  type ConnectDeps,
  type ExclusiveLock,
} from "../src/lib/plaid-connect";
import { syncBanks } from "../src/lib/plaid/sync-all";
import type { ItemSyncResult } from "../src/lib/plaid/sync";

// ---- fake Plaid + store -----------------------------------------------------------------------
type Stored = { id: string; plaidItemId: string; institutionId: string; institutionName: string | null; accessToken: string };
function fakeWorld(institutionOf: Record<string, string | null>) {
  const items: Stored[] = [];
  const removed: string[] = [];
  const names: Record<string, string> = { ins_1: "First Platypus Bank", ins_2: "Tartan Bank" };
  let n = 0;
  const deps: ConnectDeps<Stored> = {
    async exchange(publicToken) {
      n++;
      return { accessToken: `access-${publicToken}`, plaidItemId: `item-${n}` };
    },
    async accounts(accessToken) {
      return { institutionId: institutionOf[accessToken.replace("access-", "")] ?? null, accounts: [{ account_id: `a${n}`, name: "Checking", type: "depository" }] };
    },
    async institutionName(id) {
      return names[id] ?? null;
    },
    async findByInstitution(id) {
      return items.find((i) => i.institutionId === id) ?? null;
    },
    async create(a) {
      // mirrors the DB unique constraint, for a race that gets past findByInstitution
      if (items.some((i) => i.institutionId === a.institutionId)) throw new PlaidInstitutionAlreadyConnectedError(a.institutionName);
      const row = { id: `row${items.length + 1}`, plaidItemId: a.plaidItemId, institutionId: a.institutionId, institutionName: a.institutionName, accessToken: a.accessToken };
      items.push(row);
      return row;
    },
    async remove(accessToken) {
      removed.push(accessToken);
    },
  };
  return { deps, items, removed };
}

const synced = (): ItemSyncResult => ({
  outcome: "synced",
  itemStatus: "OK",
  status: "synced",
  counts: { apiAdded: 2, apiModified: 0, apiRemoved: 0, created: 2, updated: 0, unchanged: 0, removed: 0, superseded: 0, late: 0, audited: 0 },
  pages: 1,
  restarts: 0,
  nextCursor: "c",
});

async function main() {
  // ---- two institutions connect -------------------------------------------------------------
  {
    const w = fakeWorld({ pt1: "ins_1", pt2: "ins_2" });
    const a = await connectWith(w.deps, "pt1", "ins_1");
    const b = await connectWith(w.deps, "pt2", "ins_2");
    assert.deepEqual(w.items.map((i) => i.institutionName), ["First Platypus Bank", "Tartan Bank"]);
    assert.notEqual(a.id, b.id);
    assert.deepEqual(w.removed, [], "nothing removed at Plaid");
  }

  // ---- duplicate institution refused, and the just-created Item is removed at Plaid -----------
  {
    const w = fakeWorld({ pt1: "ins_1", pt2: "ins_1", pt3: "ins_1" });
    await connectWith(w.deps, "pt1");
    await assert.rejects(connectWith(w.deps, "pt2"), (e) => e instanceof PlaidInstitutionAlreadyConnectedError && e.institutionName === "First Platypus Bank");
    assert.deepEqual(w.removed, ["access-pt2"], "the new Item was removed at Plaid");
    assert.equal(w.items.length, 1);

    // Link's own report of the bank refuses a known duplicate BEFORE the exchange creates an Item
    await assert.rejects(connectWith(w.deps, "pt3", "ins_1"), PlaidInstitutionAlreadyConnectedError);
    assert.deepEqual(w.removed, ["access-pt2"], "no exchange, so nothing to remove");

    // a client-supplied hint can't block a different bank
    const w2 = fakeWorld({ pt1: "ins_2" });
    await connectWith(w2.deps, "pt1", "ins_1");
    assert.equal(w2.items.length, 1);
  }

  // ---- an Item Plaid can't place in an institution is not kept ---------------------------------
  {
    const w = fakeWorld({ pt1: null });
    await assert.rejects(connectWith(w.deps, "pt1"), PlaidInstitutionUnknownError);
    assert.deepEqual(w.removed, ["access-pt1"]);
    assert.equal(w.items.length, 0);
  }

  // ---- a failed removal still surfaces the original error --------------------------------------
  {
    const w = fakeWorld({ pt1: "ins_1", pt2: "ins_1" });
    await connectWith(w.deps, "pt1");
    w.deps.remove = async () => {
      throw new Error("plaid down");
    };
    const log = console.error;
    console.error = () => undefined;
    await assert.rejects(connectWith(w.deps, "pt2"), PlaidInstitutionAlreadyConnectedError);
    console.error = log;
  }

  // ---- in-flight connection is refused (double submit) -----------------------------------------
  {
    let held = false;
    const lock: ExclusiveLock = {
      async claim() {
        if (held) return false;
        held = true;
        return true;
      },
      async release() {
        held = false;
      },
    };
    const w = fakeWorld({ pt1: "ins_1", pt2: "ins_2" });
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const slow: ConnectDeps<Stored> = { ...w.deps, exchange: async (t) => (await gate, w.deps.exchange(t)) };
    const first = runExclusive(lock, () => connectWith(slow, "pt1"));
    await assert.rejects(runExclusive(lock, () => connectWith(w.deps, "pt2")), PlaidConnectInProgressError);
    unblock();
    await first;
    assert.equal(held, false, "lock released after success");
    await runExclusive(lock, () => connectWith(w.deps, "pt2")); // free again
    assert.equal(w.items.length, 2);

    await assert.rejects(runExclusive(lock, async () => { throw new Error("x"); }), /x/);
    assert.equal(held, false, "lock released after failure");
  }

  // ---- one Item in LOGIN_REQUIRED while the other syncs ------------------------------------------
  {
    const items = [
      { id: "i1", institutionName: "Chase" },
      { id: "i2", institutionName: "Wells Fargo" },
      { id: "i3", institutionName: "Credit Union" },
    ];
    const seen: string[] = [];
    const out = await syncBanks(
      items,
      async (id) => {
        seen.push(id);
        if (id === "i1") return { outcome: "skipped", itemStatus: "LOGIN_REQUIRED", errorCode: "ITEM_LOGIN_REQUIRED" };
        if (id === "i2") return synced();
        throw new Error("Plaid transactions sync failed: ITEM_ERROR/INSTITUTION_DOWN"); // ERROR-style failure
      },
      (e) => (e as Error).message,
    );
    assert.deepEqual(seen, ["i1", "i2", "i3"], "every bank is attempted, in order");
    assert.equal(out[0].result.outcome, "skipped");
    assert.equal(out[1].result.outcome, "synced", "the healthy bank synced");
    assert.deepEqual(out[2].result, { outcome: "failed", error: "Plaid transactions sync failed: ITEM_ERROR/INSTITUTION_DOWN" });
    assert.deepEqual(out.map((o) => o.institution), ["Chase", "Wells Fargo", "Credit Union"]);
    assert.deepEqual(await syncBanks([], async () => synced(), String), []);
  }

  // ---- the unique constraint, on the real migrations -------------------------------------------
  {
    const pg = new PGlite();
    const dir = join(process.cwd(), "prisma/migrations");
    for (const m of readdirSync(dir).filter((d) => /^\d+_/.test(d)).sort()) await pg.exec(readFileSync(join(dir, m, "migration.sql"), "utf8"));
    await pg.exec(`INSERT INTO "Business"(id,name,timezone,"ownerEmail","updatedAt") VALUES ('b1','t','America/Denver','o@x.com',now())`);
    const ins = (id: string, env: string, inst: string | null) =>
      pg.exec(`INSERT INTO "PlaidItem"(id,"businessId","plaidItemId",environment,"accessTokenEnc","institutionId","updatedAt") VALUES ('${id}','b1','p_${id}','${env}','enc',${inst ? `'${inst}'` : "NULL"},now())`);
    await ins("x1", "sandbox", "ins_1");
    await ins("x2", "sandbox", "ins_2"); // second bank, same business and environment
    await assert.rejects(ins("x3", "sandbox", "ins_1"), /duplicate key|unique/i, "same institution twice");
    await ins("x4", "production", "ins_1"); // same bank in the other environment is a different Item
    await ins("x5", "sandbox", null); // pre-multi-bank rows have no institutionId yet and must still load
    await ins("x6", "sandbox", null);
    await pg.close();
  }

  console.log("multi bank ok");
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
