import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../src/lib/crypto";

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
console.log("crypto ok");
