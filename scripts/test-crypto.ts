import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt, decryptDetailed, hasPreviousKey, probeKey } from "../src/lib/crypto";

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");

const secret = "access-sandbox-12345-abcdef";
const a = encrypt(secret);
const b = encrypt(secret);
assert.notEqual(a, b, "IV must differ per call");
assert.ok(!a.includes(secret));
assert.equal(decrypt(a), secret);
assert.equal(decrypt(encrypt("")), "");

const tampered = a.slice(0, -2) + (a.endsWith("AA") ? "BB" : "AA");
assert.throws(() => decrypt(tampered), "tampering must fail auth");

process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
assert.throws(() => decrypt(a), "wrong key must fail");

process.env.ENCRYPTION_KEY = Buffer.from("short").toString("base64");
assert.throws(() => encrypt("x"), /32 bytes/);
// ---- key rotation: ENCRYPTION_KEY_PREVIOUS
{
  const A = randomBytes(32).toString("base64"); // old key
  const B = randomBytes(32).toString("base64"); // new key
  const setKeys = (cur: string, prev?: string) => {
    process.env.ENCRYPTION_KEY = cur;
    if (prev === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS;
    else process.env.ENCRYPTION_KEY_PREVIOUS = prev;
  };

  setKeys(A);
  const oldCt = encrypt("access-production-OLD");

  // new key without previous cannot read old ciphertext
  setKeys(B);
  assert.throws(() => decrypt(oldCt));
  assert.equal(probeKey(oldCt), "none");
  assert.equal(hasPreviousKey(), false);

  // with previous set, old ciphertext is readable and reported as "previous"
  setKeys(B, A);
  assert.equal(hasPreviousKey(), true);
  assert.deepEqual(decryptDetailed(oldCt), { plaintext: "access-production-OLD", key: "previous" });
  assert.equal(decrypt(oldCt), "access-production-OLD");
  assert.equal(probeKey(oldCt), "previous");

  // encrypt ALWAYS uses the current key, even while previous is set
  const newCt = encrypt("access-production-NEW");
  assert.equal(probeKey(newCt), "current");
  assert.deepEqual(decryptDetailed(newCt), { plaintext: "access-production-NEW", key: "current" });
  setKeys(A); // only the OLD key as current: must NOT read what was just encrypted
  assert.throws(() => decrypt(newCt), "new ciphertext is not readable with the old key");
  setKeys(B);
  assert.equal(decrypt(newCt), "access-production-NEW", "and is readable with the new key alone");

  // identical or empty previous is ignored
  setKeys(B, B);
  assert.equal(hasPreviousKey(), false);
  setKeys(B, "   ");
  assert.equal(hasPreviousKey(), false);

  // a ciphertext neither key can read is "none", and tampering is still detected on the fallback path
  setKeys(B, A);
  assert.equal(probeKey("garbage"), "none");
  assert.equal(probeKey("v1.AAAA.BBBB.CCCC"), "none");
  const tampered = oldCt.slice(0, -2) + (oldCt.endsWith("AA") ? "BB" : "AA");
  assert.equal(probeKey(tampered), "none", "tampered old ciphertext is rejected even with the previous key");
  const other = randomBytes(32).toString("base64");
  setKeys(other, A);
  assert.equal(probeKey(newCt), "none", "ciphertext from a third key is unreadable");

  // malformed previous: harmless while the current key works, a clear config error when it is needed
  setKeys(B, "short");
  assert.equal(decrypt(newCt), "access-production-NEW", "current key still works; previous is never consulted");
  assert.throws(() => decrypt(oldCt), /ENCRYPTION_KEY_PREVIOUS must be 32 bytes/);
  assert.throws(() => probeKey(oldCt), /ENCRYPTION_KEY_PREVIOUS/, "config errors are not reported as 'none'");

  // errors never contain plaintext or ciphertext
  setKeys(other);
  try { decrypt(oldCt); } catch (e) { assert.ok(!String((e as Error).message).includes(oldCt) && !String((e as Error).stack).includes("access-production")); }
}

console.log("crypto ok");
