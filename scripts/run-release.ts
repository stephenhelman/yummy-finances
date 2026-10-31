// Usage: npm run release:dev
// Runs the SAME release the production route runs (template seed + rules + category mapping + apply + marker) against dev.
// Refuses unless DIRECT_URL is the allowlisted dev endpoint. Production uses POST /api/admin/apply-rules instead.
import "dotenv/config";
import { checkGuard } from "../src/lib/predeploy-guard";
import { db } from "../src/lib/db";
import { prismaReleaseDeps, runRulesRelease } from "../src/lib/rules/release";

async function main() {
  const g = checkGuard({ target: "dev", directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`REFUSED: ${g.reason}`);
  console.log(`Target dev, endpoint ${g.endpoint}`);
  const business = await db.business.findFirstOrThrow();
  console.log(JSON.stringify(await runRulesRelease(prismaReleaseDeps(db, business.id, "release-dev")), null, 2));
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
