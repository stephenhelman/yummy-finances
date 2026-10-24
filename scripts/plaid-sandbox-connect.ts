// Connects a SANDBOX bank to the dev DB through the real connectItem() path and leaves it connected.
// Usage: npm run plaid:sandbox-connect [-- --user=user_transactions_dynamic]
// Default user is Plaid's dynamic-transactions user (history that changes on each sync).
import "dotenv/config";
import { Products } from "plaid";
import { db } from "../src/lib/db";
import { PLAID_DAYS_REQUESTED } from "../src/lib/plaid-config";
import { connectItem, getPlaid, plaidErrorSummary } from "../src/lib/plaid";

async function main() {
  const { client, env } = getPlaid();
  if (env !== "sandbox") throw new Error("sandbox only");
  const user = process.argv.find((a) => a.startsWith("--user="))?.slice(7) ?? "user_transactions_dynamic";
  const business = await db.business.findFirstOrThrow();
  const pt = await client.sandboxPublicTokenCreate({
    institution_id: "ins_109508",
    initial_products: [Products.Transactions],
    options: { override_username: user, override_password: "pass_good", transactions: { days_requested: PLAID_DAYS_REQUESTED } },
  });
  const item = await connectItem({ businessId: business.id, publicToken: pt.data.public_token });
  console.log(`Connected sandbox bank "${item.institutionName}" as ${user}. (Remove with: npm run plaid:sandbox-remove)`);
}
main()
  .catch((e) => {
    console.error("FAILED:", plaidErrorSummary(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
