// Usage: npm run test:passcode-db
// Exercises the real DB path of the passcode rate limit (src/lib/passcode-db.ts) against the database named by
// DATABASE_URL (use the dev branch). Uses a TEST-NET IP, then deletes only the audit rows it created.
import "dotenv/config";
import assert from "node:assert/strict";
import { db } from "../src/lib/db";
import { ATTEMPT_WINDOW_MS, attemptPasscodeLogin } from "../src/lib/passcode";
import { passcodeStore } from "../src/lib/passcode-db";

const IP = "203.0.113.77"; // RFC 5737 documentation range, never a real client
const CODE = "db-test-passcode-0123456789";
const BAD = "wrong-guess-should-never-be-stored";

async function main() {
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const env = { LOGIN_PASSCODE: CODE };
  const start = new Date();
  try {
    for (let i = 1; i <= 5; i++) assert.deepEqual(await attemptPasscodeLogin(BAD, IP, passcodeStore, env), { ok: false, reason: "wrong" }, `attempt ${i}`);
    const sixth = await attemptPasscodeLogin(CODE, IP, passcodeStore, env); // right passcode, but already locked
    assert.equal(sixth.ok === false && sixth.reason, "locked");
    console.log("attempts 1-5 wrong, 6th locked (even with the right passcode):", JSON.stringify(sixth));

    const rows = await db.auditLog.findMany({ where: { createdAt: { gte: start }, payload: { path: ["ip"], equals: IP } }, orderBy: { createdAt: "asc" } });
    console.log("audit rows:", rows.map((r) => `${r.action} actor=${r.actor} payload=${JSON.stringify(r.payload)}`));
    assert.deepEqual(rows.map((r) => r.action), [...Array(5).fill("login_passcode_failed"), "login_passcode_locked"]);
    assert.ok(rows.every((r) => r.actor === "passcode" && JSON.stringify(r.payload) === JSON.stringify({ ip: IP })));
    assert.ok(!JSON.stringify(rows).includes(BAD) && !JSON.stringify(rows).includes(CODE), "no passcode in audit rows");

    // another IP is unaffected
    const other = await attemptPasscodeLogin(BAD, "203.0.113.78", passcodeStore, env);
    assert.equal(other.ok === false && other.reason, "wrong");

    // expiry: the same DB rows, evaluated after the window, no longer count
    const later = Date.now() + ATTEMPT_WINDOW_MS + 60_000;
    assert.deepEqual(await attemptPasscodeLogin(CODE, IP, passcodeStore, env, later), { ok: true });
    console.log("lock expired after the 15 minute window; right passcode accepted");
    console.log("passcode db ok");
  } finally {
    const del = await db.auditLog.deleteMany({
      where: { createdAt: { gte: start }, action: { startsWith: "login_passcode_" }, OR: [{ payload: { path: ["ip"], equals: IP } }, { payload: { path: ["ip"], equals: "203.0.113.78" } }] },
    });
    console.log(`cleaned up ${del.count} test audit row(s)`);
    await db.$disconnect();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
