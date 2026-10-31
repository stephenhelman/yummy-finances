// Usage: npm run categories:seed -- --target dev|prod
// DEV ONLY. Writes the accountant's category template (idempotent; keeps the owner's edits). Refuses unless DIRECT_URL's Neon
// endpoint is the allowlisted one for --target, and prints it first. Refuses --target prod: production gets the template and the
// category mapping together from the Rules release, so it never sits with old categories archived and nothing mapped.
import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";
import { checkGuard } from "../src/lib/predeploy-guard";
import { seedTemplate } from "../src/lib/report/seed-template";

async function main() {
  const i = process.argv.indexOf("--target");
  const g = checkGuard({ target: i >= 0 ? process.argv[i + 1] : undefined, directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`REFUSED: ${g.reason}`);
  if (g.target === "prod") throw new Error("REFUSED: on production the Rules release (apply-rules) seeds the template AND maps your old categories in one step. Running the seed alone would archive the old categories and leave production in between.");
  console.log(`Target ${g.target}, endpoint ${g.endpoint}`);
  const db = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DIRECT_URL! }) });
  try {
    const business = await db.business.findFirstOrThrow();
    console.log("Template:", JSON.stringify(await seedTemplate(db, business.id)));
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
