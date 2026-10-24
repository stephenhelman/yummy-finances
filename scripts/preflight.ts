// Usage: npm run preflight
// Checks the environment it runs in (whatever .env / shell variables are loaded). Prints variable NAMES and
// outcomes only, never values. Exits non-zero on any failure.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { db } from "../src/lib/db";
import { runPreflight, type Check } from "../src/lib/preflight";
import { scrub } from "../src/lib/preflight-env";

const ICON = { pass: "PASS", fail: "FAIL", warn: "WARN", info: "INFO" } as const;

async function main() {
  const checks: Check[] = await runPreflight({ context: "cli" });

  // Authoritative migration state from the Prisma CLI (needs DIRECT_URL). Only its exit code is used.
  if (process.env.DIRECT_URL) {
    const r = spawnSync("npx", ["prisma", "migrate", "status"], { encoding: "utf8", env: process.env });
    const ok = r.status === 0 && /up to date/i.test(r.stdout);
    checks.push({ name: "migrations: prisma migrate status", status: ok ? "pass" : "fail", message: ok ? "database schema is up to date" : "not clean (run `npx prisma migrate status` for details)" });
  }

  let failed = 0;
  console.log(`Preflight (${process.env.PLAID_ENV ?? "no PLAID_ENV"}; database ${hostOf(process.env.DATABASE_URL)})\n`);
  for (const c of checks) {
    if (c.status === "fail") failed++;
    console.log(`${ICON[c.status]}  ${c.name} - ${scrub(c.message, process.env)}`);
  }
  console.log(`\n${failed ? `${failed} check(s) FAILED` : "All required checks passed"}`);
  await db.$disconnect();
  process.exit(failed ? 1 : 0);
}

function hostOf(url?: string): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "unset";
  }
}

main().catch((e) => {
  console.error("Preflight crashed:", scrub((e as Error).message, process.env));
  process.exit(2);
});
