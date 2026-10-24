import assert from "node:assert/strict";
import { PLAID_DAYS_REQUESTED, parseRedirectUri, resolvePlaidEnv } from "../src/lib/plaid-config";
import { PLAID_CLIENT_NAME, buildLinkTokenRequest, isRedirectUriProblem } from "../src/lib/plaid-link";
import { plaidErrorSummary } from "../src/lib/plaid";
import { CONSENT_WARNING_DAYS, RECONNECT_STATUSES, classifyErrorCode, classifyItem, defaultIncluded } from "../src/lib/plaid-health";
import { isSameOrigin } from "../src/lib/request";

// production guard
assert.equal(resolvePlaidEnv({ PLAID_ENV: "sandbox" }), "sandbox");
assert.equal(resolvePlaidEnv({ PLAID_ENV: "sandbox", ALLOW_PLAID_PRODUCTION: "true" }), "sandbox");
assert.throws(() => resolvePlaidEnv({ PLAID_ENV: "production" }), /blocked/);
for (const v of ["", "false", "1", "TRUE", "yes", undefined]) {
  assert.throws(() => resolvePlaidEnv({ PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: v }), /blocked/, `flag ${String(v)}`);
}
assert.equal(resolvePlaidEnv({ PLAID_ENV: "production", ALLOW_PLAID_PRODUCTION: "true" }), "production");
assert.throws(() => resolvePlaidEnv({ PLAID_ENV: "development" }), /sandbox/);
assert.throws(() => resolvePlaidEnv({}), /nothing/);
assert.equal(PLAID_DAYS_REQUESTED, 730);

// error summaries never contain request data (tokens/secrets ride on the axios config)
{
  const err = Object.assign(new Error("Request failed with status code 400"), {
    config: { data: JSON.stringify({ access_token: "access-sandbox-SECRET", secret: "SECRETKEY" }) },
    response: { data: { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required" } },
  });
  const s = plaidErrorSummary(err);
  assert.equal(s, "ITEM_ERROR/ITEM_LOGIN_REQUIRED: login required");
  assert.ok(!s.includes("SECRET"));
  assert.ok(!plaidErrorSummary(Object.assign(new Error("boom"), { config: { data: "access-sandbox-SECRET" } })).includes("SECRET"));
}

// CSRF origin check
const req = (origin?: string) => new Request("https://app.example.com/api/plaid/exchange", { method: "POST", headers: origin ? { origin } : {} });
assert.equal(isSameOrigin(req("https://app.example.com")), true);
assert.equal(isSameOrigin(req("https://evil.example.com")), false);
assert.equal(isSameOrigin(req()), false);

// account defaults by Plaid type
assert.equal(defaultIncluded("depository"), true);
assert.equal(defaultIncluded("credit"), true);
for (const t of ["loan", "investment", "other", "brokerage", "", null, undefined]) assert.equal(defaultIncluded(t), false, String(t));

// item health classification
{
  const now = new Date("2026-10-24T12:00:00Z");
  const ok = classifyItem({ error: null, consentExpirationTime: null }, now);
  assert.deepEqual(ok, { status: "OK", errorCode: null, message: null });
  assert.equal(classifyItem({ error: undefined, consentExpirationTime: undefined }, now).status, "OK");

  const login = classifyItem({ error: { error_code: "ITEM_LOGIN_REQUIRED", error_message: "login" }, consentExpirationTime: null }, now);
  assert.deepEqual(login, { status: "LOGIN_REQUIRED", errorCode: "ITEM_LOGIN_REQUIRED", message: "login" });
  for (const c of ["ITEM_LOCKED", "USER_PERMISSION_REVOKED", "ACCESS_NOT_GRANTED", "INVALID_CREDENTIALS", "INVALID_MFA"]) {
    assert.equal(classifyErrorCode(c), "LOGIN_REQUIRED", c);
  }
  for (const c of ["INSTITUTION_DOWN", "INSTITUTION_NOT_RESPONDING", "INSTITUTION_NO_LONGER_SUPPORTED", "INTERNAL_SERVER_ERROR", "ITEM_NOT_FOUND", "INVALID_ACCESS_TOKEN"]) {
    assert.equal(classifyErrorCode(c), "ERROR", c);
  }

  const day = 86_400_000;
  const soon = new Date(now.getTime() + (CONSENT_WARNING_DAYS - 1) * day).toISOString();
  const far = new Date(now.getTime() + (CONSENT_WARNING_DAYS + 1) * day).toISOString();
  assert.equal(classifyItem({ error: null, consentExpirationTime: soon }, now).status, "PENDING_EXPIRATION");
  assert.equal(classifyItem({ error: null, consentExpirationTime: far }, now).status, "OK");
  assert.equal(classifyItem({ error: null, consentExpirationTime: "garbage" }, now).status, "OK");
  assert.equal(classifyItem({ error: { error_code: "ITEM_LOGIN_REQUIRED" }, consentExpirationTime: soon }, now).status, "LOGIN_REQUIRED", "error beats expiry warning");

  assert.deepEqual([...RECONNECT_STATUSES], ["LOGIN_REQUIRED", "PENDING_EXPIRATION"]);
}

// redirect URI (OAuth)
{
  assert.equal(parseRedirectUri({}), undefined);
  assert.equal(parseRedirectUri({ PLAID_REDIRECT_URI: "  " }), undefined);
  assert.equal(parseRedirectUri({ PLAID_REDIRECT_URI: "https://app.example.com/plaid/oauth", PLAID_ENV: "production" }), "https://app.example.com/plaid/oauth");
  assert.throws(() => parseRedirectUri({ PLAID_REDIRECT_URI: "http://app.example.com/plaid/oauth", PLAID_ENV: "production" }), /https/);
  assert.throws(() => parseRedirectUri({ PLAID_REDIRECT_URI: "http://localhost:3000/plaid/oauth", PLAID_ENV: "production" }), /https/);
  assert.equal(parseRedirectUri({ PLAID_REDIRECT_URI: "http://localhost:3000/plaid/oauth", PLAID_ENV: "sandbox" }), "http://localhost:3000/plaid/oauth");
  assert.throws(() => parseRedirectUri({ PLAID_REDIRECT_URI: "http://evil.example/plaid/oauth", PLAID_ENV: "sandbox" }), /https/, "http only for localhost");
  assert.throws(() => parseRedirectUri({ PLAID_REDIRECT_URI: "not a url" }), /valid URL/);
  assert.throws(() => parseRedirectUri({ PLAID_REDIRECT_URI: "https://a.com/plaid/oauth?x=1", PLAID_ENV: "production" }), /query/);

  const uri = "https://app.example.com/plaid/oauth";
  const initial = buildLinkTokenRequest({ userId: "biz1", redirectUri: uri });
  const update = buildLinkTokenRequest({ userId: "biz1", redirectUri: uri, accessToken: "access-x" });
  assert.equal(initial.redirect_uri, uri, "new connections carry the redirect URI");
  assert.equal(update.redirect_uri, uri, "update-mode reconnects carry it too");
  assert.deepEqual(initial.products, ["transactions"]);
  assert.equal(initial.transactions?.days_requested, PLAID_DAYS_REQUESTED);
  assert.equal(update.products, undefined, "update mode sends no products");
  assert.equal(update.transactions, undefined);
  assert.equal(update.access_token, "access-x");
  assert.equal(initial.access_token, undefined);
  assert.equal("redirect_uri" in buildLinkTokenRequest({ userId: "biz1" }), false, "omitted when not configured");
  assert.equal("redirect_uri" in buildLinkTokenRequest({ userId: "biz1", accessToken: "a" }), false);
  assert.ok(PLAID_CLIENT_NAME.length <= 30, "Link shows at most 30 characters");
  assert.equal(PLAID_CLIENT_NAME, "Yummy Finances");
  assert.equal(isRedirectUriProblem("INVALID_REQUEST/INVALID_FIELD: OAuth redirect URI must be configured in the developer dashboard."), true);
  assert.equal(isRedirectUriProblem("INVALID_REQUEST/INVALID_API_KEYS: invalid"), false);
}

console.log("plaid ok");
