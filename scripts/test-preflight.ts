import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CLI_ONLY_VARS, REQUIRED_VARS, checkEnvVars, isDeployed, scrub, tokenKeyCheck, type TokenProbe } from "../src/lib/preflight-env";
import { PlaidItemUnusableError, unlockItemToken } from "../src/lib/plaid-item";
import { encrypt } from "../src/lib/crypto";

const key = () => randomBytes(32).toString("base64");
const full = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: "postgresql://u:SUPERSECRETDB@host/db", DIRECT_URL: "postgresql://u:SUPERSECRETDIRECT@host/db", ENCRYPTION_KEY: key(),
  AUTH_SECRET: "a".repeat(40), ADMIN_USER_EMAILS: "me@x.com, you@x.com", APP_URL: "https://app.example.com", CRON_SECRET: "c".repeat(24),
  PLAID_CLIENT_ID: "cid", PLAID_SECRET: "PLAIDSECRETVALUE", PLAID_ENV: "sandbox", CLOVER_MERCHANT_ID: "M1", CLOVER_API_TOKEN: "CLOVERTOKENVALUE",
  APPS_SCRIPT_URL: "https://script.google.com/macros/s/AKfycbxDEPLOYMENTID/exec", APPS_SCRIPT_SECRET: "APPSSCRIPTSECRETVALUE", BUSINESS_TIMEZONE: "America/Denver", OWNER_EMAIL: "o@x.com", ...o,
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
  const miss = checkEnvVars(full({ CLOVER_API_TOKEN: undefined, DIRECT_URL: "", AUTH_SECRET: "  " }), "cli");
  const c = by(miss, "env: required variables");
  assert.equal(c.status, "fail");
  assert.match(c.message, /CLOVER_API_TOKEN/);
  assert.match(c.message, /DIRECT_URL/);
  assert.match(c.message, /AUTH_SECRET/);
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

// ---- login methods
{
  const m = (o: Record<string, string | undefined>) => by(checkEnvVars(full(o), "cli"), "auth: login methods");
  const none = { APPS_SCRIPT_URL: undefined, APPS_SCRIPT_SECRET: undefined };
  assert.equal(m({}).status, "pass", "mail only");
  assert.equal(m({ LOGIN_PASSCODE: "p".repeat(20) }).status, "pass", "both");
  assert.equal(m({ ...none, LOGIN_PASSCODE: "p".repeat(20) }).status, "warn", "passcode only warns");
  assert.equal(m({ ...none }).status, "fail", "no method");
  assert.equal(m({ LOGIN_PASSCODE: "short" }).status, "fail", "short passcode fails even with mail");
  assert.equal(m({ ...none, LOGIN_PASSCODE: "p".repeat(19) }).status, "fail");
  assert.equal(by(checkEnvVars(full({ APPS_SCRIPT_SECRET: undefined }), "cli"), "env: Apps Script mailer").status, "fail", "half-configured mailer");
  assert.equal(by(checkEnvVars(full(none), "cli"), "env: required variables").status, "pass", "mailer vars are optional");
  assert.ok(!JSON.stringify(checkEnvVars(full({ LOGIN_PASSCODE: "SECRETPASSCODEVALUE12345" }), "cli")).includes("SECRETPASSCODEVALUE"));
}

// ---- production requires the mailer regardless of the passcode
{
  const pc = "p".repeat(20), none = { APPS_SCRIPT_URL: undefined, APPS_SCRIPT_SECRET: undefined };
  for (const prod of [{ VERCEL_ENV: "production" }, { NODE_ENV: "production" }]) {
    const c = by(checkEnvVars(full({ ...prod, ...none, LOGIN_PASSCODE: pc }), "server"), "env: Apps Script mailer");
    assert.equal(c.status, "fail");
    assert.match(c.message, /APPS_SCRIPT_URL, APPS_SCRIPT_SECRET/);
    assert.equal(by(checkEnvVars(full({ ...prod, APPS_SCRIPT_SECRET: undefined }), "server"), "env: Apps Script mailer").status, "fail");
    assert.ok(!checkEnvVars(full(prod), "server").some((x) => x.name === "env: Apps Script mailer" && x.status === "fail"), "configured mailer passes");
    assert.equal(by(checkEnvVars(full({ ...prod, LOGIN_PASSCODE: pc }), "server"), "auth: LOGIN_PASSCODE").status, "warn");
  }
  // outside production the passcode alone is still acceptable
  assert.ok(!checkEnvVars(full({ ...none, LOGIN_PASSCODE: pc }), "cli").some((x) => x.name === "env: Apps Script mailer"));
  assert.equal(by(checkEnvVars(full({ ...none, LOGIN_PASSCODE: pc }), "cli"), "auth: login methods").status, "warn");
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

// ---- key rotation states
{
  const k = () => randomBytes(32).toString("base64");
  const name = "encryption: ENCRYPTION_KEY_PREVIOUS";
  const cur = k();
  const find = (e: ReturnType<typeof full>) => checkEnvVars(e, "cli").find((c) => c.name === name);
  assert.equal(find(full({ ENCRYPTION_KEY: cur })), undefined, "nothing reported when not rotating");
  assert.equal(find(full({ ENCRYPTION_KEY: cur, ENCRYPTION_KEY_PREVIOUS: "" })), undefined);
  const rotating = find(full({ ENCRYPTION_KEY: cur, ENCRYPTION_KEY_PREVIOUS: k() }))!;
  assert.equal(rotating.status, "warn", "warns while a previous key is set");
  assert.match(rotating.message, /rotate-tokens/);
  assert.equal(find(full({ ENCRYPTION_KEY: cur, ENCRYPTION_KEY_PREVIOUS: "short" }))!.status, "fail", "malformed previous key fails");
  assert.equal(find(full({ ENCRYPTION_KEY: cur, ENCRYPTION_KEY_PREVIOUS: cur }))!.status, "warn", "identical previous key warns");
  const all = JSON.stringify(checkEnvVars(full({ ENCRYPTION_KEY: cur, ENCRYPTION_KEY_PREVIOUS: "secretprevious1234567890" }), "cli"));
  assert.ok(!all.includes(cur) && !all.includes("secretprevious"), "no key material in messages");

  // stored-token states. probe = how a token reads under the current/previous keys.
  const item = (environment: string, tag: string) => ({ environment, accessTokenEnc: tag });
  const probe = (map: Record<string, TokenProbe>) => (enc: string) => map[enc] ?? "none";
  const tname = "encryption: stored bank tokens";

  assert.equal(tokenKeyCheck([], "production", false, probe({})).status, "info", "no bank yet");
  assert.equal(tokenKeyCheck([item("production", "a"), item("production", "b")], "production", false, probe({ a: "current", b: "current" })).status, "pass");
  // previous UNSET and a token cannot be read: fail
  const failing = tokenKeyCheck([item("production", "a"), item("production", "b")], "production", false, probe({ a: "current", b: "none" }));
  assert.equal(failing.status, "fail");
  assert.match(failing.message, /1 of 2 token\(s\) cannot be decrypted with the current ENCRYPTION_KEY/);
  assert.equal(failing.name, tname);
  // a token that still reads only via the previous key means rotation is not finished: warn
  assert.equal(tokenKeyCheck([item("production", "a")], "production", true, probe({ a: "previous" })).status, "warn", "rotation not finished");
  assert.match(tokenKeyCheck([item("production", "a")], "production", true, probe({ a: "previous" })).message, /rotate-tokens/);
  // previous SET: all on current is fine; unreadable by both keys still fails
  assert.equal(tokenKeyCheck([item("production", "a")], "production", true, probe({ a: "current" })).status, "pass");
  const both = tokenKeyCheck([item("production", "a")], "production", true, probe({ a: "none" }));
  assert.equal(both.status, "fail");
  assert.match(both.message, /current or previous key/);
  // another environment's tokens are expected to be unreadable (a dev database copied from prod): not a failure
  const copied = tokenKeyCheck([item("production", "p1"), item("production", "p2")], "sandbox", false, probe({}));
  assert.notEqual(copied.status, "fail");
  assert.match(copied.message, /2 belong to another Plaid environment/);
  const mixedEnv = tokenKeyCheck([item("sandbox", "s"), item("production", "p")], "sandbox", false, probe({ s: "current" }));
  assert.equal(mixedEnv.status, "pass");
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
