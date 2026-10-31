import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { callAppsScript } from "@/lib/apps-script";
import { CloverClient } from "@/lib/clover/client";
import { decrypt, encrypt, hasPreviousKey, probeKey } from "@/lib/crypto";
import { db } from "@/lib/db";
import { getPlaid, plaidErrorSummary } from "@/lib/plaid";
import { buildLinkTokenRequest } from "@/lib/plaid-link";
import { parseRedirectUri } from "@/lib/plaid-config";
import { backfillCompletedAt } from "@/lib/rules/readiness";
import { autoSendCheck, checkEnvVars, rulesReadinessCheck, scrub, tokenKeyCheck, type Check } from "@/lib/preflight-env";

export type { Check };

/** Runs a check, turning any exception into a scrubbed failure (never a stack trace). */
async function attempt(name: string, env: NodeJS.ProcessEnv, fn: () => Promise<Check | Check[]>): Promise<Check[]> {
  try {
    const r = await fn();
    return Array.isArray(r) ? r : [r];
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown error";
    return [{ name, status: "fail", message: scrub(msg, env).slice(0, 300) }];
  }
}

export async function runPreflight(opts: { context: "cli" | "server"; env?: NodeJS.ProcessEnv }): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const out: Check[] = [...checkEnvVars(env, opts.context)];
  const has = (n: string) => !!env[n]?.trim();

  // Encryption key
  if (has("ENCRYPTION_KEY")) {
    out.push(
      ...(await attempt("encryption: key", env, async () => {
        const bytes = Buffer.from(env.ENCRYPTION_KEY!, "base64").length;
        if (bytes !== 32) return { name: "encryption: key", status: "fail", message: `decodes to ${bytes} bytes, need 32 (openssl rand -base64 32)` };
        if (decrypt(encrypt("preflight")) !== "preflight") return { name: "encryption: key", status: "fail", message: "round trip failed" };
        return { name: "encryption: key", status: "pass", message: "32 bytes, encrypt/decrypt round trip ok" };
      })),
    );
  }

  // Database + business row
  let businessTz: string | null = null;
  if (has("DATABASE_URL")) {
    const dbChecks = await attempt("database: reachable", env, async () => {
      await db.$queryRaw`SELECT 1`;
      const businesses = await db.business.findMany({ select: { timezone: true } });
      const checks: Check[] = [{ name: "database: reachable", status: "pass", message: "query ok" }];
      if (businesses.length === 1) {
        businessTz = businesses[0].timezone;
        checks.push({ name: "database: business row", status: "pass", message: "exactly one (seeded)" });
      } else {
        checks.push({ name: "database: business row", status: "fail", message: `${businesses.length} found, need exactly 1 (run the seed)` });
      }
      return checks;
    });
    out.push(...dbChecks);

    if (dbChecks[0]?.status === "pass") {
      out.push(...(await attempt("migrations", env, async () => migrationsCheck())));
      out.push(
        ...(await attempt("rules: classification", env, async () => {
          const business = await db.business.findFirst({ select: { id: true } });
          if (!business) return { name: "rules: classification", status: "info", message: "no business row yet" };
          return rulesReadinessCheck(await db.rule.count({ where: { businessId: business.id, active: true } }), await backfillCompletedAt(db, business.id));
        })),
      );
      out.push(...(await attempt("encryption: stored bank tokens", env, async () => plaidItemsCheck(env))));
    }
  }

  // Clover
  if (has("CLOVER_MERCHANT_ID") && has("CLOVER_API_TOKEN")) {
    out.push(
      ...(await attempt("clover: merchant", env, async () => {
        const client = CloverClient.fromEnv(env);
        await client.getMerchant();
        const props = await client.getMerchantProperties();
        const checks: Check[] = [{ name: "clover: merchant", status: "pass", message: "token reaches /merchants/{mId}" }];
        const cloverTz = typeof props.timezone === "string" ? props.timezone : null;
        const expected = env.BUSINESS_TIMEZONE;
        if (!cloverTz) checks.push({ name: "clover: timezone", status: "fail", message: "properties.timezone missing" });
        else if (cloverTz !== expected) checks.push({ name: "clover: timezone", status: "fail", message: `Clover says ${cloverTz} but BUSINESS_TIMEZONE is ${expected ?? "unset"}` });
        else if (businessTz && businessTz !== cloverTz) checks.push({ name: "clover: timezone", status: "fail", message: `Clover and BUSINESS_TIMEZONE say ${cloverTz} but the Business row says ${businessTz}` });
        else checks.push({ name: "clover: timezone", status: "pass", message: `${cloverTz} matches BUSINESS_TIMEZONE${businessTz ? " and the Business row" : ""}` });
        return checks;
      })),
    );
  }

  // Plaid client for the configured environment (builds only; makes no Plaid call)
  if (has("PLAID_CLIENT_ID") && has("PLAID_SECRET") && has("PLAID_ENV")) {
    out.push(
      ...(await attempt("plaid: client", env, async () => {
        const saved = { PLAID_ENV: process.env.PLAID_ENV, ALLOW: process.env.ALLOW_PLAID_PRODUCTION, ID: process.env.PLAID_CLIENT_ID, SECRET: process.env.PLAID_SECRET };
        if (opts.env) Object.assign(process.env, { PLAID_ENV: env.PLAID_ENV, PLAID_REDIRECT_URI: env.PLAID_REDIRECT_URI, ALLOW_PLAID_PRODUCTION: env.ALLOW_PLAID_PRODUCTION, PLAID_CLIENT_ID: env.PLAID_CLIENT_ID, PLAID_SECRET: env.PLAID_SECRET });
        try {
          const { client, env: plaidEnv } = getPlaid();
          const checks: Check[] = [{ name: "plaid: client", status: "pass", message: `builds for ${plaidEnv}` }];
          // Plaid only issues a link token for a redirect_uri that is registered in its Dashboard. Creating
          // one is harmless (no Item exists until a user finishes Link), so it proves the registration.
          const redirectUri = parseRedirectUri(process.env);
          if (redirectUri) {
            try {
              await client.linkTokenCreate(buildLinkTokenRequest({ userId: "preflight", redirectUri }));
              checks.push({ name: "plaid: redirect URI registered", status: "pass", message: "Plaid accepted a link token with it" });
            } catch (e) {
              const summary = plaidErrorSummary(e);
              checks.push({ name: "plaid: redirect URI registered", status: "fail", message: /redirect uri/i.test(summary) ? "not registered in the Plaid Dashboard (Developers > API > Allowed redirect URIs)" : scrub(summary, env).slice(0, 200) });
            }
          }
          return checks;
        } finally {
          if (opts.env) { process.env.PLAID_ENV = saved.PLAID_ENV; process.env.ALLOW_PLAID_PRODUCTION = saved.ALLOW; process.env.PLAID_CLIENT_ID = saved.ID; process.env.PLAID_SECRET = saved.SECRET; }
        }
      })),
    );
  }

  out.push(autoSendCheck(env));

  // Apps Script mailer
  if (has("APPS_SCRIPT_URL") && has("APPS_SCRIPT_SECRET")) {
    out.push(
      ...(await attempt("apps script: ping", env, async () => {
        await callAppsScript({ type: "ping" }, { env, timeoutMs: 20_000 });
        return { name: "apps script: ping", status: "pass", message: "web app reachable and accepted the secret" };
      })),
    );
  }

  return out;
}

/** Applied vs on-disk migrations: pending or failed migrations are failures. */
async function migrationsCheck(): Promise<Check[]> {
  const dir = join(process.cwd(), "prisma", "migrations");
  const rows = await db.$queryRaw<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
    SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"`;
  const applied = new Set(rows.filter((r) => r.finished_at && !r.rolled_back_at).map((r) => r.migration_name));
  const broken = rows.filter((r) => !r.finished_at && !r.rolled_back_at).map((r) => r.migration_name);
  if (broken.length) return [{ name: "migrations", status: "fail", message: `failed/unfinished: ${broken.join(", ")}` }];
  if (!existsSync(dir)) return [{ name: "migrations", status: "warn", message: `${applied.size} applied; migration folders not available here to compare` }];
  const onDisk = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "migration.sql"))).map((d) => d.name);
  const pending = onDisk.filter((m) => !applied.has(m));
  const unknown = [...applied].filter((m) => !onDisk.includes(m));
  if (pending.length) return [{ name: "migrations", status: "fail", message: `pending: ${pending.join(", ")} (run prisma migrate deploy)` }];
  if (unknown.length) return [{ name: "migrations", status: "warn", message: `database has migrations this build doesn't know: ${unknown.join(", ")}` }];
  return [{ name: "migrations", status: "pass", message: `${applied.size} applied, none pending` }];
}

async function plaidItemsCheck(env: NodeJS.ProcessEnv): Promise<Check[]> {
  const items = await db.plaidItem.findMany({ select: { environment: true, accessTokenEnc: true, status: true } });
  const current = env.PLAID_ENV ?? "";
  const checks: Check[] = [tokenKeyCheck(items, current, hasPreviousKey(), probeKey)];
  const mine = items.filter((i) => i.environment === current);
  if (mine.length) {
    const unhealthy = mine.filter((i) => i.status !== "OK").length;
    checks.push({ name: "plaid: stored items", status: unhealthy ? "warn" : "pass", message: `${mine.length} for ${current}${unhealthy ? `, ${unhealthy} not healthy: see /admin/connections` : ", status ok"}` });
  }
  return checks;
}
