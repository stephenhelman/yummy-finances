// Pure helpers for the pre-migration guard (scripts/predeploy-check.ts). No I/O, no database.
// Exists because Yummy migrations were once applied to another project's database: a migration may only
// run when the target's Neon endpoint ID is one the owner has explicitly allowlisted for that target.

export type Target = "prod" | "dev";

export type Parsed = { host: string; endpoint: string; database: string; user: string };

/** Neon host: ep-<name>-<id>[-pooler].<region>.<provider>.neon.tech -> endpoint ID without "-pooler". */
export function parseNeonUrl(raw: string | undefined): Parsed | { error: string } {
  if (!raw) return { error: "connection URL is not set" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: "connection URL is not a valid URL" };
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return { error: "connection URL is not a postgres:// URL" };
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(".neon.tech")) return { error: `host ${host} is not a Neon host (*.neon.tech)` };
  const first = host.split(".")[0];
  const endpoint = first.replace(/-pooler$/, "");
  if (!/^ep-[a-z0-9-]+$/.test(endpoint)) return { error: `cannot read a Neon endpoint ID (ep-...) from host ${host}` };
  return { host, endpoint, database: decodeURIComponent(u.pathname.replace(/^\//, "")), user: decodeURIComponent(u.username) };
}

export type GuardInput = {
  target: string | undefined;
  directUrl: string | undefined;
  databaseUrl?: string | undefined; // if set, must point at the same endpoint as directUrl
  allow: { prod?: string | undefined; dev?: string | undefined };
};

export type GuardResult = { ok: true; endpoint: string; target: Target; parsed: Parsed } | { ok: false; reason: string; parsed?: Parsed };

const clean = (s: string | undefined) => (s ?? "").trim().toLowerCase();

export function checkGuard(i: GuardInput): GuardResult {
  if (i.target !== "prod" && i.target !== "dev") return { ok: false, reason: "pass --target prod or --target dev" };
  const target: Target = i.target;
  const parsed = parseNeonUrl(i.directUrl);
  if ("error" in parsed) return { ok: false, reason: `DIRECT_URL: ${parsed.error}` };

  const allowed = clean(i.allow[target]);
  const envName = target === "prod" ? "YUMMY_PROD_ENDPOINT" : "YUMMY_DEV_ENDPOINT";
  if (!allowed) return { ok: false, parsed, reason: `${envName} is not set. Refusing: there is no allowlisted endpoint for ${target}.` };
  if (!/^ep-[a-z0-9-]+$/.test(allowed)) return { ok: false, parsed, reason: `${envName} must look like ep-xxxx-xxxx-xxxxxxxx (no host, no -pooler)` };

  const other = clean(i.allow[target === "prod" ? "dev" : "prod"]);
  if (other && other === allowed) return { ok: false, parsed, reason: "YUMMY_PROD_ENDPOINT and YUMMY_DEV_ENDPOINT are identical; they must differ" };
  if (parsed.endpoint !== allowed) {
    const hint = other && parsed.endpoint === other ? ` (that is the ${target === "prod" ? "DEV" : "PROD"} endpoint)` : " (not in the allowlist)";
    return { ok: false, parsed, reason: `DIRECT_URL endpoint ${parsed.endpoint} does not match ${envName}${hint}` };
  }

  if (i.databaseUrl) {
    const d = parseNeonUrl(i.databaseUrl);
    if ("error" in d) return { ok: false, parsed, reason: `DATABASE_URL: ${d.error}` };
    if (d.endpoint !== parsed.endpoint) return { ok: false, parsed, reason: `DATABASE_URL points at ${d.endpoint} but DIRECT_URL at ${parsed.endpoint}` };
  }
  return { ok: true, endpoint: parsed.endpoint, target, parsed };
}
