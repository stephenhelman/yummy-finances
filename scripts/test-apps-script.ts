import assert from "node:assert/strict";
import { AppsScriptError, callAppsScript } from "../src/lib/apps-script";
import { sendLoginEmail } from "../src/lib/email";
import { buildMonthlyReportPayload, sendMonthlyReport } from "../src/lib/report";

const SECRET = "SUPERSECRETSCRIPTVALUE";
const env = { APPS_SCRIPT_URL: "https://script.google.com/macros/s/ID/exec", APPS_SCRIPT_SECRET: SECRET };
const reply = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const rec = () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response('{"ok":true}');
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

async function main() {
  // ping + login_email wire format
  const r = rec();
  await callAppsScript({ type: "ping" }, { env, fetchImpl: r.fetchImpl });
  await sendLoginEmail({ to: "a@x.com", link: "https://app.vercel.app/auth/verify?token=t", expiresMinutes: 15 }, { env, fetchImpl: r.fetchImpl });
  assert.equal(r.calls[0].url, env.APPS_SCRIPT_URL);
  assert.deepEqual(r.calls[0].body, { type: "ping", secret: SECRET });
  assert.deepEqual(r.calls[1].body, { type: "login_email", to: "a@x.com", link: "https://app.vercel.app/auth/verify?token=t", expiresMinutes: 15, secret: SECRET });

  // failures: never leak the secret or the payload
  const fails: [string, typeof fetch][] = [
    ["rejected", reply(`{"ok":false,"error":"bad ${SECRET}"}`)],
    ["web page", reply("<html>Sign in to Google</html>")],
    ["network", (async () => { throw new Error(`boom ${SECRET}`); }) as unknown as typeof fetch],
  ];
  for (const [name, fetchImpl] of fails) {
    await assert.rejects(
      () => sendLoginEmail({ to: "victim@x.com", link: "https://l/?token=TOKEN123", expiresMinutes: 15 }, { env, fetchImpl }),
      (e: Error) => {
        assert.ok(e instanceof AppsScriptError, name);
        for (const s of [SECRET, "victim@x.com", "TOKEN123"]) assert.ok(!e.message.includes(s), `${name} leaked ${s}`);
        return true;
      },
    );
  }
  await assert.rejects(() => callAppsScript({ type: "ping" }, { env: {}, fetchImpl: r.fetchImpl }), /APPS_SCRIPT_URL/);
  await assert.rejects(() => callAppsScript({ type: "ping" }, { env: { APPS_SCRIPT_URL: "u" }, fetchImpl: r.fetchImpl }), /APPS_SCRIPT_SECRET/);

  // mapper
  const biz = { name: "Yummy", ownerEmail: "o@x.com", ccEmail: "o@x.com" };
  const snap = {
    month: "2026-09", status: "LOCKED" as "LOCKED" | "DRAFT",
    dataJson: {
      sections: [
        { section: "OPEX", lines: [{ name: "Rent", cents: 150000 }] },
        { section: "REVENUE", lines: [{ name: "Net sales", cents: 1000000 }, { name: "Catering", cents: 50000 }] },
        { section: "COGS", lines: [{ name: "Dairy", cents: 300000 }] },
      ],
      cashNotes: ["Cash deposit pending"],
      warnings: [{ code: "UNKNOWN_TENDER", message: "Unknown tender" }],
    },
  };
  const p = buildMonthlyReportPayload(snap, biz);
  assert.equal(p.year, 2026); assert.equal(p.month, 9);
  assert.deepEqual(p.sections.map((s) => [s.key, s.subtotalCents]), [["REVENUE", 1050000], ["COGS", 300000], ["OPEX", 150000]]);
  assert.equal(p.lines.length, 4);
  assert.equal(p.netCents, 600000);
  assert.deepEqual(p.warnings, ["Unknown tender"]);
  assert.deepEqual(p.recipients, ["o@x.com"], "deduped");
  assert.throws(() => buildMonthlyReportPayload({ ...snap, status: "DRAFT" as const }, biz), /not locked/);
  assert.throws(() => buildMonthlyReportPayload({ ...snap, dataJson: { sections: [{ section: "OPEX", lines: [{ name: "x", cents: 1.5 }] }] } }, biz), /malformed/);
  assert.throws(() => buildMonthlyReportPayload({ ...snap, dataJson: null }, biz), /no P&L/);
  const r2 = rec();
  await sendMonthlyReport(snap, biz, { env, fetchImpl: r2.fetchImpl });
  assert.equal(r2.calls[0].body.type, "monthly_report");
  assert.equal(r2.calls[0].body.secret, SECRET);
  console.log("apps-script ok");
}
main();
