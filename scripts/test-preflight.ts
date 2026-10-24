import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CLI_ONLY_VARS, REQUIRED_VARS, checkEnvVars, isDeployed, scrub } from "../src/lib/preflight-env";
import { PlaidItemUnusableError, unlockItemToken } from "../src/lib/plaid-item";
import { encrypt } from "../src/lib/crypto";

const key = () => randomBytes(32).toString("base64");
const full = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: "postgresql://u:SUPERSECRETDB@host/db", DIRECT_URL: "postgresql://u:SUPERSECRETDIRECT@host/db", ENCRYPTION_KEY: key(),
  AUTH_SECRET: "a".repeat(40), ADMIN_USER_EMAILS: "me@x.com, you@x.com", APP_URL: "https://app.example.com", CRON_SECRET: "c".repeat(24),
  PLAID_CLIENT_ID: "cid", PLAID_SECRET: "PLAIDSECRETVALUE", PLAID_ENV: "sandbox", CLOVER_MERCHANT_ID: "M1", CLOVER_API_TOKEN: "CLOVERTOKENVALUE",
  RESEND_API_KEY: "re_RESENDKEYVALUE", EMAIL_FROM: "P&L <pl@example.com>", BUSINESS_TIMEZONE: "America/Denver", OWNER_EMAIL: "o@x.com", ...o,
});
const by = (cs: ReturnType<typeof checkEnvVars>, name: string) => cs.find((c) => c.name === name)!;

// ---- scrub: secret values never survive in text
{
  const env = full();
  const msg = `connect failed for ${env.DATABASE_URL} with key ${env.CLOVER_API_TOKEN} and ${env.PLAID_SECRET}`;
  const out = scrub(msg, env);
  for (const s of ["SUPERSECRETDB", "CLOVERTOKENVALUE", "PLAIDSECRETVALUE"]) assert.ok(!out.includes(s), s);
  assert.ok(out.includes("[redacted]"));
  assert.equal(scrub("nothing secret", env), "nothing secret");
  assert.equal(scrub("tiny abc", { AUTH_SECRET: "abc" }), "tiny abc", "very short values are not blindly replaced");
}

// ---- required variables: names only
{
  const ok = checkEnvVars(full(), "cli");
  assert.equal(by(ok, "env: required variables").status, "pass");
  const miss = checkEnvVars(full({ CLOVER_API_TOKEN: undefined, DIRECT_URL: "", RESEND_API_KEY: "  " }), "cli");
  const c = by(miss, "env: required variables");
  assert.equal(c.status, "fail");
  assert.match(c.message, /CLOVER_API_TOKEN/);
  assert.match(c.message, /DIRECT_URL/);
  assert.match(c.message, /RESEND_API_KEY/);
  // no value from the environment appears in any message
  const all = JSON.stringify(checkEnvVars(full(), "cli"));
  for (const v of Object.values(full())) if (v && v.length > 8 && !["sandbox"].includes(v)) assert.ok(!all.includes(v), "value leaked");
  // Vercel never needs the direct DB URL or the seed-time owner email; a developer machine does.
  const serverEnv = full({ DIRECT_URL: undefined, OWNER_EMAIL: undefined });
  assert.equal(by(checkEnvVars(serverEnv, "server"), "env: required variables").status, "pass");
  const cliMissing = by(checkEnvVars(serverEnv, "cli"), "env: required variables");
  assert.equal(cliMissing.status, "fail");
  assert.match(cliMissing.message, /DIRECT_URL.*OWNER_EMAIL/);
  assert.deepEqual([...CLI_ONLY_VARS], ["DIRECT_URL", "OWNER_EMAIL"]);
  assert.equal((REQUIRED_VARS as readonly string[]).includes("DIRECT_URL"), false);
}

// ---- DEV_AUTH_BYPASS
{
  assert.equal(by(checkEnvVars(full(), "cli"), "auth: DEV_AUTH_BYPASS").status, "pass");
  assert.equal(by(checkEnvVars(full({ DEV_AUTH_BYPASS: "true" }), "cli"), "auth: DEV_AUTH_BYPASS").status, "info");
  assert.equal(by(checkEnvVars(full({ DEV_AUTH_BYPASS: "true", VERCEL_ENV: "production" }), "cli"), "auth: DEV_AUTH_BYPASS").status, "warn");
  assert.equal(by(checkEnvVars(full({ DEV_AUTH_BYPASS: "true", VERCEL_ENV: "preview" }), "cli"), "auth: DEV_AUTH_BYPASS").status, "warn");
  assert.equal(by(checkEnvVars(full({ DEV_AUTH_BYPASS: "true", NODE_ENV: "production" }), "server"), "auth: DEV_AUTH_BYPASS").status, "warn");
}

// ---- Plaid production guard + environment
{
  assert.equal(by(checkEnvVars(full({ PLAID_ENV: "production" }), "cli"), "plaid: production guard").status, "fail");
  assert.equal(by(checkEnvVars(full({ PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: "yes" }), "cli"), "plaid: production guard").status, "fail");
  assert.equal(by(checkEnvVars(full({ PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: "true" }), "cli"), "plaid: production guard").status, "pass");
  assert.equal(by(checkEnvVars(full({ PLAID_ENV: "development" }), "cli"), "plaid: environment").status, "fail");
  assert.equal(by(checkEnvVars(full({ VERCEL_ENV: "production" }), "cli"), "plaid: environment").status, "warn", "prod deploy on sandbox is flagged");
  assert.equal(by(checkEnvVars(full({ ALLOW_PLAID_PRODUCTION: "true" }), "cli"), "plaid: ALLOW_PLAID_PRODUCTION").status, "warn");
}

// ---- APP_URL, secrets, emails
{
  assert.equal(by(checkEnvVars(full({ APP_URL: "http://localhost:3000", VERCEL_ENV: "production" }), "cli"), "env: APP_URL").status, "fail");
  assert.equal(by(checkEnvVars(full({ APP_URL: "http://localhost:3000" }), "cli"), "env: APP_URL").status, "info");
  assert.equal(by(checkEnvVars(full({ AUTH_SECRET: "short" }), "cli"), "env: AUTH_SECRET length").status, "fail");
  assert.equal(by(checkEnvVars(full({ CRON_SECRET: "short" }), "cli"), "env: CRON_SECRET length").status, "fail");
  assert.equal(by(checkEnvVars(full({ ADMIN_USER_EMAILS: "not-an-email" }), "cli"), "env: ADMIN_USER_EMAILS").status, "fail");
  assert.equal(by(checkEnvVars(full(), "cli"), "env: ADMIN_USER_EMAILS").message, "2 address(es)");
  assert.equal(isDeployed({ VERCEL_ENV: "preview" }, "cli"), true);
  assert.equal(isDeployed({}, "cli"), false);
  assert.equal(isDeployed({ NODE_ENV: "production" }, "server"), true);
  assert.equal(by(checkEnvVars(full(), "cli"), "runtime: Node.js").status, "pass", `running on Node ${process.versions.node}`);
}

// ---- PLAID_REDIRECT_URI
{
  const app = "https://app.example.com";
  const name = "plaid: PLAID_REDIRECT_URI";
  assert.equal(by(checkEnvVars(full(), "cli"), name).status, "info", "sandbox: optional");
  assert.equal(by(checkEnvVars(full({ PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: "true" }), "cli"), name).status, "fail", "production: required");
  assert.equal(by(checkEnvVars(full({ APP_URL: app, PLAID_REDIRECT_URI: `${app}/plaid/oauth` }), "cli"), name).status, "pass");
  assert.equal(by(checkEnvVars(full({ APP_URL: `${app}/`, PLAID_REDIRECT_URI: `${app}/plaid/oauth` }), "cli"), name).status, "pass", "trailing slash on APP_URL tolerated");
  assert.equal(by(checkEnvVars(full({ APP_URL: app, PLAID_REDIRECT_URI: `${app}/oauth` }), "cli"), name).status, "warn", "mismatch warns locally");
  assert.equal(by(checkEnvVars(full({ APP_URL: app, PLAID_REDIRECT_URI: `${app}/oauth`, VERCEL_ENV: "production" }), "cli"), name).status, "fail", "mismatch fails when deployed");
  assert.equal(by(checkEnvVars(full({ PLAID_REDIRECT_URI: "http://app.example.com/plaid/oauth", PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: "true" }), "cli"), name).status, "fail", "http rejected");
}

// ---- unusable Plaid items: wrong environment, wrong key
{
  process.env.ENCRYPTION_KEY = key();
  const enc = encrypt("access-sandbox-abc123");
  const item = { environment: "sandbox", accessTokenEnc: enc };
  assert.equal(unlockItemToken(item, "sandbox"), "access-sandbox-abc123");

  assert.throws(() => unlockItemToken({ ...item, environment: "production" }, "sandbox"), (e: unknown) => {
    assert.ok(e instanceof PlaidItemUnusableError && e.code === "ENV_MISMATCH");
    assert.match(e.message, /"production".*PLAID_ENV is "sandbox"/);
    return true;
  });

  process.env.ENCRYPTION_KEY = key(); // a different key, as after copying a DB from another environment
  assert.throws(() => unlockItemToken(item, "sandbox"), (e: unknown) => {
    assert.ok(e instanceof PlaidItemUnusableError && e.code === "KEY_MISMATCH");
    assert.match(e.message, /ENCRYPTION_KEY/);
    assert.ok(!e.message.includes(enc) && !e.message.includes("access-sandbox"), "no ciphertext or token in the message");
    assert.equal(e.stack?.includes(enc), false);
    return true;
  });

  // a missing key is a config error, not a key mismatch
  delete process.env.ENCRYPTION_KEY;
  assert.throws(() => unlockItemToken(item, "sandbox"), (e: unknown) => {
    assert.ok(e instanceof Error && !(e instanceof PlaidItemUnusableError));
    assert.match(e.message, /ENCRYPTION_KEY is not set/);
    return true;
  });
}

console.log("preflight ok");
