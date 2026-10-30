// Usage:
//   npm run predeploy -- --target prod            check only
//   npm run db:deploy -- --target prod            check, then `prisma migrate deploy`
//   npm run db:status -- --target prod            check, then `prisma migrate status`
// Refuses unless DIRECT_URL's Neon endpoint ID equals YUMMY_PROD_ENDPOINT / YUMMY_DEV_ENDPOINT for the target.
// Prints the endpoint first, before anything runs. Prints no password. Connects to nothing itself.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { checkGuard } from "../src/lib/predeploy-guard";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const target = arg("--target");
const run = arg("--run"); // "deploy" | "status"
const directUrl = process.env.DIRECT_URL;

const res = checkGuard({
  target,
  directUrl,
  databaseUrl: process.env.DATABASE_URL,
  allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT },
});

const p = res.parsed;
console.log(`Target:    ${target ?? "(missing)"}`);
if (p) {
  console.log(`Endpoint:  ${p.endpoint}`);
  console.log(`Host:      ${p.host}`);
  console.log(`Database:  ${p.database}   user: ${p.user}`);
}
if (!res.ok) {
  console.error(`\nREFUSED: ${res.reason}`);
  console.error("Nothing was run. Check DIRECT_URL and the YUMMY_*_ENDPOINT variables.");
  process.exit(1);
}
console.log(`Allowlist: matches YUMMY_${res.target.toUpperCase()}_ENDPOINT\n`);

if (run === "deploy" || run === "status") {
  // Pass the verified URL explicitly so Prisma cannot pick a different one up from elsewhere.
  const r = spawnSync("npx", ["prisma", "migrate", run], { stdio: "inherit", env: { ...process.env, DIRECT_URL: directUrl } });
  process.exit(r.status ?? 1);
}
