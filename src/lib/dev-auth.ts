/**
 * Local-development escape hatch for the magic-link login (until email is set up).
 * Enabled only when DEV_AUTH_BYPASS is exactly "true" AND this is not a production
 * build or a Vercel production deploy. A deployed build can never bypass auth, even
 * if the variable is set by mistake.
 */
export function isDevAuthBypass(env: Record<string, string | undefined> = process.env): boolean {
  if (env.DEV_AUTH_BYPASS !== "true") return false;
  if (env.NODE_ENV === "production") return false;
  if (env.VERCEL_ENV === "production" || env.VERCEL_ENV === "preview") return false;
  return true;
}
