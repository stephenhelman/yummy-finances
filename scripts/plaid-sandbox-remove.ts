// Removes this business's SANDBOX Plaid Item(s) at Plaid and in the DB. Refuses anything else.
// Usage: npm run plaid:sandbox-remove
import "dotenv/config";
import { decrypt } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { getPlaid, plaidErrorSummary } from "../src/lib/plaid";

export async function removeSandbox(businessId: string): Promise<number> {
  const { client, env } = getPlaid();
  if (env !== "sandbox") throw new Error("plaid:sandbox-remove only runs with PLAID_ENV=sandbox");
  const items = await db.plaidItem.findMany({ where: { businessId, environment: "sandbox" } });
  for (const it of items) {
    try {
      await client.itemRemove({ access_token: decrypt(it.accessTokenEnc) });
    } catch (e) {
      console.warn(`itemRemove failed for sandbox item (continuing): ${plaidErrorSummary(e)}`);
    }
    await db.bankTransaction.deleteMany({ where: { account: { plaidItemId: it.id } } });
    await db.bankAccount.deleteMany({ where: { plaidItemId: it.id } });
    await db.plaidItem.delete({ where: { id: it.id } });
  }
  return items.length;
}

if (process.argv[1]?.endsWith("plaid-sandbox-remove.ts")) {
  (async () => {
    const b = await db.business.findFirstOrThrow();
    console.log(`removed ${await removeSandbox(b.id)} sandbox item(s)`);
  })()
    .catch((e) => {
      console.error("FAILED:", plaidErrorSummary(e));
      process.exitCode = 1;
    })
    .finally(() => db.$disconnect());
}
