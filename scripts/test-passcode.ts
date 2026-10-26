import assert from "node:assert/strict";
import { ATTEMPT_WINDOW_MS, attemptPasscodeLogin, clientIp, passcodeMatches, passcodeStatus, type PasscodeStore } from "../src/lib/passcode";
import { createSessionToken, verifySessionToken } from "../src/lib/session";

const CODE = "correct horse battery staple";
const env = { LOGIN_PASSCODE: CODE };

function memStore() {
  const log: { event: string; ip: string; at: number }[] = [];
  let clock = 0;
  const store: PasscodeStore = {
    async recentFailures(ip, since) {
      return log.filter((l) => l.event === "failed" && l.ip === ip && l.at >= since.getTime()).map((l) => new Date(l.at));
    },
    async record(event, ip) { log.push({ event, ip, at: clock }); },
  };
  return { store, log, setClock: (t: number) => { clock = t; } };
}

async function main() {
  // status: unset / too short / enabled
  assert.equal(passcodeStatus({}), "unset");
  assert.equal(passcodeStatus({ LOGIN_PASSCODE: "" }), "unset");
  assert.equal(passcodeStatus({ LOGIN_PASSCODE: "x".repeat(19) }), "too_short");
  assert.equal(passcodeStatus({ LOGIN_PASSCODE: "x".repeat(20) }), "enabled");

  // comparison
  assert.equal(passcodeMatches(CODE, CODE), true);
  assert.equal(passcodeMatches(CODE + "x", CODE), false);
  assert.equal(passcodeMatches("", CODE), false);

  // disabled when unset, and when too short (never even consults the store)
  const d = memStore();
  for (const e of [{}, { LOGIN_PASSCODE: "short" }]) {
    assert.deepEqual(await attemptPasscodeLogin("short", "1.1.1.1", d.store, e), { ok: false, reason: "disabled" });
    assert.deepEqual(await attemptPasscodeLogin("anything", "1.1.1.1", d.store, e), { ok: false, reason: "disabled" });
  }
  assert.equal(d.log.length, 0);

  // correct / incorrect
  const a = memStore();
  assert.deepEqual(await attemptPasscodeLogin("nope", "2.2.2.2", a.store, env, 0), { ok: false, reason: "wrong" });
  assert.deepEqual(await attemptPasscodeLogin(CODE, "2.2.2.2", a.store, env, 0), { ok: true });
  assert.deepEqual(a.log.map((l) => l.event), ["failed", "ok"]);
  assert.ok(!JSON.stringify(a.log).includes(CODE) && !JSON.stringify(a.log).includes("nope"), "passcodes are never recorded");

  // rate limit: 5 failures per IP per 15 min, then locked (even for the right passcode)
  const r = memStore();
  for (let i = 0; i < 5; i++) {
    r.setClock(i * 60_000);
    assert.deepEqual(await attemptPasscodeLogin("bad" + i, "3.3.3.3", r.store, env, i * 60_000), { ok: false, reason: "wrong" });
  }
  const t = 5 * 60_000;
  r.setClock(t);
  const locked = await attemptPasscodeLogin(CODE, "3.3.3.3", r.store, env, t);
  assert.equal(locked.ok, false);
  assert.equal(locked.ok === false && locked.reason, "locked");
  assert.equal(locked.ok === false && locked.reason === "locked" && locked.retryAfterMinutes, 10, "oldest failure at t=0 ages out at 15 min");
  assert.equal(r.log.at(-1)!.event, "locked");
  // other IP unaffected
  assert.deepEqual(await attemptPasscodeLogin(CODE, "4.4.4.4", r.store, env, t), { ok: true });
  // locked attempts don't extend the lock; after the window the right passcode works again
  const later = ATTEMPT_WINDOW_MS + 1;
  assert.deepEqual(await attemptPasscodeLogin(CODE, "3.3.3.3", r.store, env, later), { ok: true } as never);

  // session: same cookie format/expiry, attributed as passcode with no email
  process.env.AUTH_SECRET = "x".repeat(40);
  const now = Date.now();
  const pt = await createSessionToken("", now, "passcode");
  const ps = await verifySessionToken(pt, now);
  assert.equal(ps?.via, "passcode");
  assert.equal(ps?.email, "");
  const mt = await verifySessionToken(await createSessionToken("me@x.com", now), now);
  assert.equal(ps!.exp, mt!.exp, "same expiry as a magic-link session");
  assert.equal(mt?.via, undefined);
  assert.equal(await verifySessionToken(pt, now + 15 * 86_400_000), null);
  const [pay, sig] = pt.split(".");
  const forged = Buffer.from(JSON.stringify({ email: "", exp: 9999999999, via: "passcode" })).toString("base64url");
  assert.equal(await verifySessionToken(`${forged}.${sig}`, now), null, "can't forge a passcode session");
  void pay;

  assert.equal(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
  assert.equal(clientIp(new Headers()), "unknown");
  console.log("passcode ok");
}
main();
