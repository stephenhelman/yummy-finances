import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptDetailed, encrypt, probeKey } from "../src/lib/crypto";
import { rotateTokens, type TokenStore } from "../src/lib/rotate-tokens";

const A = randomBytes(32).toString("base64"); // old key
const B = randomBytes(32).toString("base64"); // new key
const setKeys = (cur: string, prev?: string) => {
  process.env.ENCRYPTION_KEY = cur;
  if (prev === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS;
  else process.env.ENCRYPTION_KEY_PREVIOUS = prev;
};

class MemStore implements TokenStore {
  rows = new Map<string, string>();
  replaceCalls = 0;
  beforeReplace?: (id: string) => void; // simulate a concurrent writer
  async list() { return [...this.rows].map(([id, accessTokenEnc]) => ({ id, accessTokenEnc })); }
  async get(id: string) { return this.rows.get(id) ?? null; }
  async replace(id: string, oldEnc: string, newEnc: string) {
    this.replaceCalls++;
    this.beforeReplace?.(id);
    if (this.rows.get(id) !== oldEnc) return false;
    this.rows.set(id, newEnc);
    return true;
  }
}

// Nothing may be logged while rotating: capture all console output and check at the end.
const logged: string[] = [];
for (const m of ["log", "info", "warn", "error", "debug"] as const) console[m] = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
const out = (...a: unknown[]) => process.stdout.write(a.join(" ") + "\n");

async function main() {
  // ---- everything on the old key
  setKeys(A);
  const store = new MemStore();
  const plain = { p1: "access-production-111", p2: "access-production-222", p3: "access-production-333" };
  for (const [id, p] of Object.entries(plain)) store.rows.set(id, encrypt(p));
  const before = new Map(store.rows);

  setKeys(B, A); // rotation window
  const r1 = await rotateTokens(store);
  assert.deepEqual(r1, { total: 3, rotated: 3, alreadyCurrent: 0, failed: 0 });
  for (const [id, p] of Object.entries(plain)) {
    assert.notEqual(store.rows.get(id), before.get(id), "ciphertext replaced");
    assert.deepEqual(decryptDetailed(store.rows.get(id)!), { plaintext: p, key: "current" }, "same token, now on the current key");
  }

  // ---- idempotent: a second run changes nothing
  const afterFirst = new Map(store.rows);
  const calls = store.replaceCalls;
  const r2 = await rotateTokens(store);
  assert.deepEqual(r2, { total: 3, rotated: 0, alreadyCurrent: 3, failed: 0 });
  assert.equal(store.replaceCalls, calls, "no writes on the second run");
  assert.deepEqual([...store.rows], [...afterFirst], "ciphertexts untouched");

  // ---- after removing the previous key everything still reads
  setKeys(B);
  for (const id of Object.keys(plain)) assert.equal(probeKey(store.rows.get(id)!), "current");
  assert.deepEqual(await rotateTokens(store), { total: 3, rotated: 0, alreadyCurrent: 3, failed: 0 });

  // ---- mixed: current + previous + unreadable. Unreadable is counted and left alone.
  setKeys(A);
  const mixed = new MemStore();
  mixed.rows.set("old1", encrypt("access-production-OLD1"));
  mixed.rows.set("old2", encrypt("access-production-OLD2"));
  setKeys(B);
  mixed.rows.set("cur", encrypt("access-production-CUR"));
  mixed.rows.set("junk", "v1.not.a.ciphertext");
  const third = randomBytes(32).toString("base64");
  setKeys(third);
  mixed.rows.set("foreign", encrypt("access-production-FOREIGN"));
  setKeys(B, A);
  const junkBefore = mixed.rows.get("junk"), foreignBefore = mixed.rows.get("foreign");
  const rm = await rotateTokens(mixed);
  assert.deepEqual(rm, { total: 5, rotated: 2, alreadyCurrent: 1, failed: 2 });
  assert.equal(mixed.rows.get("junk"), junkBefore);
  assert.equal(mixed.rows.get("foreign"), foreignBefore, "unreadable rows are never modified");
  assert.equal(probeKey(mixed.rows.get("old1")!), "current");

  // ---- without the previous key, old-key rows cannot be rotated (and are not damaged)
  setKeys(A);
  const stranded = new MemStore();
  stranded.rows.set("s1", encrypt("access-production-S1"));
  const strandedBefore = stranded.rows.get("s1");
  setKeys(B);
  assert.deepEqual(await rotateTokens(stranded), { total: 1, rotated: 0, alreadyCurrent: 0, failed: 1 });
  assert.equal(stranded.rows.get("s1"), strandedBefore);

  // ---- empty table
  assert.deepEqual(await rotateTokens(new MemStore()), { total: 0, rotated: 0, alreadyCurrent: 0, failed: 0 });

  // ---- concurrent rotation: another run got there first
  setKeys(A);
  const race = new MemStore();
  race.rows.set("r1", encrypt("access-production-R1"));
  setKeys(B, A);
  race.beforeReplace = (id) => race.rows.set(id, encrypt("access-production-R1")); // someone else already wrote a current-key value
  assert.deepEqual(await rotateTokens(race), { total: 1, rotated: 0, alreadyCurrent: 1, failed: 0 });
  // ...or the row changed to something we still cannot read
  setKeys(A);
  const race2 = new MemStore();
  race2.rows.set("r2", encrypt("access-production-R2"));
  setKeys(B, A);
  race2.beforeReplace = (id) => race2.rows.set(id, "v1.changed.under.us");
  assert.deepEqual(await rotateTokens(race2), { total: 1, rotated: 0, alreadyCurrent: 0, failed: 1 });

  // ---- a key misconfiguration aborts instead of reporting every token as failed
  setKeys(A);
  const cfg = new MemStore();
  cfg.rows.set("c1", encrypt("access-production-C1"));
  setKeys(B, "short");
  await assert.rejects(rotateTokens(cfg), /ENCRYPTION_KEY_PREVIOUS/);
  delete process.env.ENCRYPTION_KEY;
  await assert.rejects(rotateTokens(cfg), /ENCRYPTION_KEY is not set/);

  // ---- the result carries counts only
  setKeys(B, A);
  assert.deepEqual(Object.keys(r1).sort(), ["alreadyCurrent", "failed", "rotated", "total"]);
  assert.ok(Object.values(r1).every((v) => typeof v === "number"));

  // ---- the route rejects callers without CRON_SECRET before touching anything
  process.env.CRON_SECRET = "s".repeat(24);
  const { POST } = await import("../src/app/api/admin/rotate-tokens/route");
  const url = "https://app.example.com/api/admin/rotate-tokens";
  assert.equal((await POST(new Request(url, { method: "POST" }))).status, 401);
  assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer wrong" } }))).status, 401);
  delete process.env.CRON_SECRET;
  assert.equal((await POST(new Request(url, { method: "POST", headers: { authorization: "Bearer x" } }))).status, 500, "unconfigured secret refuses");

  // ---- nothing was logged, and nothing logged contains a token or ciphertext
  const dump = logged.join("\n");
  assert.ok(!/access-production|v1\./.test(dump), "no token or ciphertext in logs");
  out("rotation ok");
}
main().catch((e) => { process.stderr.write(String(e?.stack ?? e) + "\n"); process.exit(1); });
