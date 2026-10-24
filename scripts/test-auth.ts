import assert from "node:assert/strict";
import { isDevAuthBypass } from "../src/lib/dev-auth";
import { rejectUnlessCron } from "../src/lib/cron";
import { createSessionToken, verifySessionToken } from "../src/lib/session";

async function main() {
  process.env.AUTH_SECRET = "x".repeat(40);
  const now = Date.now();
  const tok = await createSessionToken("Me@Example.com", now);
  assert.equal((await verifySessionToken(tok, now))?.email, "me@example.com");
  assert.equal(await verifySessionToken(tok, now + 15 * 86_400_000), null, "expired");
  const [p, s] = tok.split(".");
  assert.equal(await verifySessionToken(`${p}.${s}A`, now), null, "bad sig");
  const forged = Buffer.from(JSON.stringify({ email: "evil@x.com", exp: 9999999999 })).toString("base64url");
  assert.equal(await verifySessionToken(`${forged}.${s}`, now), null, "forged payload");
  assert.equal(await verifySessionToken(undefined, now), null);
  assert.equal(await verifySessionToken("garbage", now), null);
  process.env.AUTH_SECRET = "y".repeat(40);
  assert.equal(await verifySessionToken(tok, now), null, "different secret");

  process.env.CRON_SECRET = "s3cret";
  const req = (h?: string) => new Request("http://x/api/cron", { headers: h ? { authorization: h } : {} });
  assert.equal(rejectUnlessCron(req("Bearer s3cret")), null);
  assert.equal(rejectUnlessCron(req("Bearer nope!!"))?.status, 401);
  assert.equal(rejectUnlessCron(req())?.status, 401);
  delete process.env.CRON_SECRET;
  assert.equal(rejectUnlessCron(req("Bearer s3cret"))?.status, 500);
  // dev bypass: only an exact "true" outside production/Vercel-deployed builds
  assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: "true", NODE_ENV: "development" }), true);
  assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: "true" }), true);
  assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: "true", NODE_ENV: "production" }), false);
  assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: "true", NODE_ENV: "development", VERCEL_ENV: "production" }), false);
  assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: "true", NODE_ENV: "development", VERCEL_ENV: "preview" }), false);
  for (const v of [undefined, "", "false", "1", "TRUE", "yes"]) assert.equal(isDevAuthBypass({ DEV_AUTH_BYPASS: v, NODE_ENV: "development" }), false);
  console.log("auth ok");
}
main();
