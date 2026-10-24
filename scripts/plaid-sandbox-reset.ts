// Forces the current SANDBOX Plaid Item into ITEM_LOGIN_REQUIRED (/sandbox/item/reset_login) so the
// reconnect flow can be clicked through. Refuses unless PLAID_ENV=sandbox. Does not touch the DB status:
// run the health check (admin page "Check connection", or the sync) to see it flip.
// Usage: npm run plaid:sandbox-reset
import "dotenv/config";
import { unlockItemToken } from "../src/lib/plaid-item";
import { db } from "../src/lib/db";
import { getPlaid, plaidErrorSummary } from "../src/lib/plaid";

async function main() {
  if (process.env.PLAID_ENV !== "sandbox") throw new Error("plaid:sandbox-reset only runs with PLAID_ENV=sandbox");
  const { client, env } = getPlaid();
  if (env !== "sandbox") throw new Error("plaid:sandbox-reset only runs against the sandbox");
  const business = await db.business.findFirstOrThrow();
  const item = await db.plaidItem.findUnique({ where: { businessId_environment: { businessId: business.id, environment: "sandbox" } } });
  if (!item) throw new Error("No sandbox Item is connected");
  await client.sandboxItemResetLogin({ access_token: unlockItemToken(item, env) });
  console.log(`Sandbox Item (${item.institutionName ?? "bank"}) is now in ITEM_LOGIN_REQUIRED at Plaid.`);
  console.log('Open /admin/connect-bank and click "Check connection" to see the status flip, then use "Reconnect bank".');
}

main()
  .catch((e) => {
    console.error("FAILED:", plaidErrorSummary(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
