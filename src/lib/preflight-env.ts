import { parseRedirectUri } from "@/lib/plaid-config";
import { MIN_PASSCODE_LENGTH, passcodeStatus } from "@/lib/passcode";
// Pure environment checks for the preflight. Reports variable NAMES only, never values.

export type CheckStatus = "pass" | "fail" | "warn" | "info";
export type Check = { name: string; status: CheckStatus; message: string };

type Env = Record<string, string | undefined>;

/** Needed by a running deployment (Vercel runtime/build). */
export const REQUIRED_VARS = [
  "DATABASE_URL", // pooled runtime connection
  "ENCRYPTION_KEY",
  "AUTH_SECRET",
  "ADMIN_USER_EMAILS",
  "APP_URL",
  "CRON_SECRET",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "PLAID_ENV",
  "CLOVER_MERCHANT_ID",
  "CLOVER_API_TOKEN",
  "BUSINESS_TIMEZONE", // preflight cross-checks it against Clover and the Business row
] as const;

/** Only needed on a developer machine (migrations and seeding). Vercel does not need them. */
export const CLI_ONLY_VARS = ["DIRECT_URL", "OWNER_EMAIL"] as const;

/** Values that must never appear in output or error text. */
export const SECRET_VARS = [
  "DATABASE_URL", "DIRECT_URL", "ENCRYPTION_KEY", "AUTH_SECRET", "CRON_SECRET",
  "PLAID_SECRET", "CLOVER_API_TOKEN", "APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET", "LOGIN_PASSCODE",
] as const;

/** Replaces any secret value found in text. Defense in depth for error messages from libraries. */
export function scrub(text: string, env: Env): string {
  let out = text;
  for (const name of SECRET_VARS) {
    const v = env[name];
    if (v && v.length >= 6) out = out.split(v).join("[redacted]");
  }
  return out;
}

export function isDeployed(env: Env, context: "cli" | "server"): boolean {
  return env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview" || (context === "server" && env.NODE_ENV === "production");
}

/** True on a Vercel production deploy or any production build. */
export function isProduction(env: Env): boolean {
  return env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

export function checkEnvVars(env: Env, context: "cli" | "server"): Check[] {
  const checks: Check[] = [];
  const present = (n: string) => !!env[n]?.trim();

  const required = context === "cli" ? [...REQUIRED_VARS, ...CLI_ONLY_VARS] : [...REQUIRED_VARS];
  const missing = required.filter((n) => !present(n));
  checks.push(
    missing.length
      ? { name: "env: required variables", status: "fail", message: `missing: ${missing.join(", ")}` }
      : { name: "env: required variables", status: "pass", message: `all ${required.length} present` },
  );

  const deployed = isDeployed(env, context);

  // Key rotation: ENCRYPTION_KEY_PREVIOUS exists only while tokens are being moved to a new key.
  const previous = env.ENCRYPTION_KEY_PREVIOUS?.trim();
  if (previous) {
    const name = "encryption: ENCRYPTION_KEY_PREVIOUS";
    if (Buffer.from(previous, "base64").length !== 32) {
      checks.push({ name, status: "fail", message: "must decode to 32 bytes (openssl rand -base64 32)" });
    } else if (previous === env.ENCRYPTION_KEY) {
      checks.push({ name, status: "warn", message: "is identical to ENCRYPTION_KEY: remove it" });
    } else {
      checks.push({ name, status: "warn", message: "key rotation in progress. Run /api/admin/rotate-tokens, confirm everything rotated, then remove ENCRYPTION_KEY_PREVIOUS and redeploy" });
    }
  }

  if (present("AUTH_SECRET")) {
    const ok = env.AUTH_SECRET!.length >= 32;
    checks.push({ name: "env: AUTH_SECRET length", status: ok ? "pass" : "fail", message: ok ? "at least 32 characters" : "must be at least 32 characters" });
  }
  if (present("CRON_SECRET")) {
    const ok = env.CRON_SECRET!.length >= 16;
    checks.push({ name: "env: CRON_SECRET length", status: ok ? "pass" : "fail", message: ok ? "at least 16 characters" : "must be at least 16 characters" });
  }
  if (present("APPS_SCRIPT_SECRET")) {
    const ok = env.APPS_SCRIPT_SECRET!.length >= 16;
    checks.push({ name: "env: APPS_SCRIPT_SECRET length", status: ok ? "pass" : "fail", message: ok ? "at least 16 characters" : "must be at least 16 characters" });
  }
  if (present("APPS_SCRIPT_URL")) {
    const ok = /^https:\/\/script\.google\.com\/macros\/s\/[^/\s]+\/exec$/.test(env.APPS_SCRIPT_URL!.trim());
    checks.push({ name: "env: APPS_SCRIPT_URL", status: ok ? "pass" : "fail", message: ok ? "looks like a deployed web app (/exec)" : "must be the Apps Script web app URL: https://script.google.com/macros/s/.../exec" });
  }
  // Login methods: at least one must work. Both mailer variables are needed for email sign-in.
  const mailSet = present("APPS_SCRIPT_URL") && present("APPS_SCRIPT_SECRET");
  const pass = passcodeStatus(env);
  if (isProduction(env) && !mailSet) {
    // Production always needs the mailer, whatever else is configured: the passcode is an emergency fallback only.
    const missingMail = ["APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET"].filter((n) => !present(n));
    checks.push({ name: "env: Apps Script mailer", status: "fail", message: `required in production, missing: ${missingMail.join(", ")}` });
  } else if (present("APPS_SCRIPT_URL") !== present("APPS_SCRIPT_SECRET")) {
    checks.push({ name: "env: Apps Script mailer", status: "fail", message: "APPS_SCRIPT_URL and APPS_SCRIPT_SECRET must be set together" });
  }
  if (isProduction(env) && pass === "enabled") {
    checks.push({ name: "auth: LOGIN_PASSCODE", status: "warn", message: "passcode login is ENABLED in production; it is an emergency fallback, remove LOGIN_PASSCODE once the mailer works" });
  }
  if (pass === "too_short") {
    checks.push({ name: "auth: login methods", status: "fail", message: `LOGIN_PASSCODE is shorter than ${MIN_PASSCODE_LENGTH} characters, so passcode login is disabled` });
  } else if (!mailSet && pass === "unset") {
    checks.push({ name: "auth: login methods", status: "fail", message: "no way to sign in: set APPS_SCRIPT_URL + APPS_SCRIPT_SECRET (email link) and/or LOGIN_PASSCODE" });
  } else if (!mailSet) {
    checks.push({ name: "auth: login methods", status: "warn", message: "passcode only: add the Apps Script mailer (APPS_SCRIPT_URL + APPS_SCRIPT_SECRET) to enable email links" });
  } else {
    checks.push({ name: "auth: login methods", status: "pass", message: pass === "enabled" ? "email link and passcode" : "email link" });
  }

  if (present("ADMIN_USER_EMAILS")) {
    const list = env.ADMIN_USER_EMAILS!.split(",").map((e) => e.trim()).filter(Boolean);
    const bad = list.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    checks.push({
      name: "env: ADMIN_USER_EMAILS",
      status: list.length && !bad.length ? "pass" : "fail",
      message: list.length && !bad.length ? `${list.length} address(es)` : bad.length ? `${bad.length} entry(ies) are not email addresses` : "no addresses",
    });
  }
  if (present("APP_URL")) {
    const url = env.APP_URL!;
    const https = url.startsWith("https://");
    const local = /localhost|127\.0\.0\.1/.test(url);
    checks.push(
      deployed
        ? { name: "env: APP_URL", status: https && !local ? "pass" : "fail", message: https && !local ? "https, not localhost" : "a deployed app needs a public https APP_URL (sign-in links are built from it)" }
        : { name: "env: APP_URL", status: "info", message: https ? "https" : "not https (fine for local development)" },
    );
  }

  // Login bypass: must be inert when deployed. Mirrors src/lib/dev-auth.ts.
  if (env.DEV_AUTH_BYPASS === "true") {
    checks.push(
      deployed
        ? { name: "auth: DEV_AUTH_BYPASS", status: "warn", message: "is set to true but is ignored on Vercel/production builds; remove it from this environment anyway" }
        : { name: "auth: DEV_AUTH_BYPASS", status: "info", message: "login bypass is ACTIVE (local development only)" },
    );
  } else {
    checks.push({ name: "auth: DEV_AUTH_BYPASS", status: "pass", message: "off" });
  }

  // Plaid environment + production guard. Mirrors src/lib/plaid-config.ts.
  const plaidEnv = env.PLAID_ENV;
  if (plaidEnv === "production") {
    const allowed = env.ALLOW_PLAID_PRODUCTION === "true";
    checks.push({ name: "plaid: production guard", status: allowed ? "pass" : "fail", message: allowed ? "PLAID_ENV=production with ALLOW_PLAID_PRODUCTION=true" : "PLAID_ENV=production requires ALLOW_PLAID_PRODUCTION=true; Plaid calls are blocked until set" });
  } else if (plaidEnv === "sandbox") {
    checks.push({ name: "plaid: environment", status: deployed && env.VERCEL_ENV === "production" ? "warn" : "pass", message: deployed && env.VERCEL_ENV === "production" ? "production deploy is configured for the Plaid SANDBOX (no real bank can connect)" : "sandbox" });
    if (env.ALLOW_PLAID_PRODUCTION === "true") checks.push({ name: "plaid: ALLOW_PLAID_PRODUCTION", status: "warn", message: "is true while PLAID_ENV=sandbox; set it only where real banks should connect" });
  } else if (present("PLAID_ENV")) {
    checks.push({ name: "plaid: environment", status: "fail", message: 'PLAID_ENV must be "sandbox" or "production"' });
  }

  // OAuth return address. Plaid also needs it registered in the Dashboard (checked live by runPreflight).
  const redirect = env.PLAID_REDIRECT_URI?.trim();
  if (redirect) {
    try {
      parseRedirectUri(env);
      const expected = `${(env.APP_URL ?? "").replace(/\/+$/, "")}/plaid/oauth`;
      if (!env.APP_URL) checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: "info", message: "set (APP_URL missing, so it can't be compared)" });
      else if (redirect === expected) checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: "pass", message: "matches APP_URL + /plaid/oauth" });
      else checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: deployed ? "fail" : "warn", message: `should be exactly ${expected}` });
    } catch (e) {
      checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: "fail", message: (e as Error).message });
    }
  } else if (plaidEnv === "production") {
    checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: "fail", message: "required in production: banks that use OAuth cannot connect without it (APP_URL + /plaid/oauth, registered in the Plaid Dashboard)" });
  } else {
    checks.push({ name: "plaid: PLAID_REDIRECT_URI", status: "info", message: "not set (only needed to connect OAuth banks)" });
  }

  // Node version: engines pins 22.x; Prisma 7 needs >= 22.12.
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = maj === 22 && min >= 12;
  checks.push({ name: "runtime: Node.js", status: nodeOk ? "pass" : maj > 22 ? "warn" : "fail", message: `${process.versions.node}${nodeOk ? "" : maj > 22 ? " (project targets 22.x)" : " (needs 22.12 or newer 22.x)"}` });

  return checks;
}

export type TokenProbe = "current" | "previous" | "none";

/**
 * Can every stored bank token be read? Only tokens for the environment being checked count: after
 * a database is copied from another environment, its tokens are expected to be unreadable and are
 * ignored. With ENCRYPTION_KEY_PREVIOUS unset, any unreadable token is a failure; while it is set,
 * tokens still on the old key are a warning (rotation not finished).
 */
export function tokenKeyCheck(
  items: { environment: string; accessTokenEnc: string }[],
  currentEnv: string,
  previousKeySet: boolean,
  probe: (ciphertext: string) => TokenProbe,
): Check {
  const name = "encryption: stored bank tokens";
  if (!items.length) return { name, status: "info", message: "no bank connected yet" };

  const mine = items.filter((i) => i.environment === currentEnv);
  const foreign = items.length - mine.length;
  const note = foreign ? `; ${foreign} belong to another Plaid environment and are not checked` : "";
  const results = mine.map((i) => probe(i.accessTokenEnc));
  const none = results.filter((r) => r === "none").length;
  const onPrevious = results.filter((r) => r === "previous").length;

  if (none > 0) {
    return { name, status: "fail", message: `${none} of ${mine.length} token(s) cannot be decrypted with ${previousKeySet ? "the current or previous key" : "the current ENCRYPTION_KEY"}${note}` };
  }
  if (onPrevious > 0) {
    return { name, status: "warn", message: `${onPrevious} of ${mine.length} token(s) still use the previous key: run /api/admin/rotate-tokens${note}` };
  }
  return { name, status: mine.length ? "pass" : "info", message: mine.length ? `${mine.length} token(s) decrypt with the current key${note}` : `none for ${currentEnv}${note}` };
}

/** Has the rules release run on this database? A warning (not a failure): older deploys predate it. */
/** Automatic monthly sending (the 3rd review nudge, the 5th sync -> lock -> send). Off by default; ON needs the mailer and the cron secret. */
export function autoSendCheck(env: Env): Check {
  const on = env.REPORTS_AUTO_SEND === "true";
  if (!on) return { name: "reports: automatic sending", status: "info", message: env.REPORTS_AUTO_SEND ? `REPORTS_AUTO_SEND is "${env.REPORTS_AUTO_SEND}": only "true" turns it on, so it is OFF` : "OFF (set REPORTS_AUTO_SEND=true to turn on the 3rd and 5th jobs)" };
  const missing = ["APPS_SCRIPT_URL", "APPS_SCRIPT_SECRET", "CRON_SECRET"].filter((k) => !env[k]?.trim());
  return missing.length
    ? { name: "reports: automatic sending", status: "fail", message: `ON, but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not set: the jobs would fail` }
    : { name: "reports: automatic sending", status: "pass", message: "ON: review nudge on the 3rd, sync -> lock -> send on the 5th (a month with unreviewed transactions is never locked automatically)" };
}

export function rulesReadinessCheck(activeRules: number, backfillAt: Date | null): Check {
  const name = "rules: classification";
  if (activeRules === 0) {
    return { name, status: "warn", message: "no rules stored yet: run the rules release (POST /api/admin/apply-rules); transaction categories are not available until then" };
  }
  if (!backfillAt) {
    return { name, status: "warn", message: `${activeRules} rules stored but the backfill has not run: call POST /api/admin/apply-rules (transaction categories are not trustworthy until then)` };
  }
  return { name, status: "pass", message: `${activeRules} active rules; backfill completed ${backfillAt.toISOString().slice(0, 10)}` };
}
