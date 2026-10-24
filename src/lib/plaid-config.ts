export type PlaidEnvName = "sandbox" | "production";

/** Transactions history window for new Items. Plaid cannot change this after the Item exists. */
export const PLAID_DAYS_REQUESTED = 730;

/**
 * Resolves PLAID_ENV and enforces the production guard: Trial-plan Items are limited (10) and
 * non-recyclable, so production is refused unless ALLOW_PLAID_PRODUCTION is exactly "true".
 * The retired "development" environment and anything unknown are rejected.
 */
export function resolvePlaidEnv(env: Record<string, string | undefined> = process.env): PlaidEnvName {
  const name = env.PLAID_ENV;
  if (name === "sandbox") return "sandbox";
  if (name === "production") {
    if (env.ALLOW_PLAID_PRODUCTION !== "true") {
      throw new Error("PLAID_ENV=production is blocked: set ALLOW_PLAID_PRODUCTION=true to allow real Plaid Items (limited, non-recyclable)");
    }
    return "production";
  }
  throw new Error(`PLAID_ENV must be "sandbox" or "production" (got ${name ? `"${name}"` : "nothing"})`);
}

/**
 * Optional OAuth return address, e.g. https://app.example.com/plaid/oauth. When set it is sent as
 * redirect_uri on every link token (new connection and update mode). It must be https (http://localhost
 * is accepted for the sandbox only) and must be registered in the Plaid Dashboard under Allowed
 * redirect URIs, or Plaid refuses the link token.
 */
export function parseRedirectUri(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env.PLAID_REDIRECT_URI?.trim();
  if (!raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("PLAID_REDIRECT_URI is not a valid URL");
  }
  const sandboxLocal = env.PLAID_ENV === "sandbox" && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  if (u.protocol !== "https:" && !sandboxLocal) {
    throw new Error("PLAID_REDIRECT_URI must be https (http://localhost is allowed in the sandbox only)");
  }
  if (u.search || u.hash) throw new Error("PLAID_REDIRECT_URI must not contain a query string or fragment");
  return raw;
}
