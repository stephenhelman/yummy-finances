// End-to-end Plaid SANDBOX check against the dev DB (no browser). Creates a link token,
// mints a sandbox public_token (user_good / pass_good) and runs the real connectItem().
// Usage: npm run plaid:sandbox-e2e [-- --keep]   (--keep leaves the Item so the admin page can be viewed)
// Never prints any token.
import "dotenv/config";
import assert from "node:assert/strict";
import { Products } from "plaid";
import { decrypt } from "../src/lib/crypto";
import { db } from "../src/lib/db";
import { PLAID_DAYS_REQUESTED } from "../src/lib/plaid-config";
import { PlaidConnectInProgressError, PlaidInstitutionAlreadyConnectedError, connectItem, createLinkToken, getPlaid, plaidErrorSummary } from "../src/lib/plaid";
import { removeSandbox } from "./plaid-sandbox-remove";

async function main() {
  const keep = process.argv.includes("--keep");
  const { client, env } = getPlaid();
  assert.equal(env, "sandbox", "this script only runs against the Plaid sandbox");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}   Plaid env: ${env}`);

  const business = await db.business.findFirstOrThrow();
  await removeSandbox(business.id); // start clean

  // 1. link token (server route logic)
  const linkToken = await createLinkToken(business.id);
  assert.ok(linkToken.startsWith("link-sandbox-"), "got a sandbox link token");
  const meta = await client.linkTokenGet({ link_token: linkToken });
  const cfg = meta.data.metadata as { products?: string[]; transactions?: { days_requested?: number } } | undefined;
  console.log(`link_token ok; products=${JSON.stringify(cfg?.products)} days_requested=${cfg?.transactions?.days_requested ?? "(not echoed by Plaid)"}`);
  if (cfg?.transactions?.days_requested !== undefined) assert.equal(cfg.transactions.days_requested, PLAID_DAYS_REQUESTED);

  // 2. what Link would hand back after user_good / pass_good
  const pt = await client.sandboxPublicTokenCreate({
    institution_id: "ins_109508", // First Platypus Bank
    initial_products: [Products.Transactions],
    options: { override_username: "user_good", override_password: "pass_good", transactions: { days_requested: PLAID_DAYS_REQUESTED } },
  });

  // 3. exchange + store (the real code path)
  const item = await connectItem({ businessId: business.id, publicToken: pt.data.public_token });
  console.log(`connected: ${item.institutionName} status=${item.status} env=${item.environment}`);

  // 4. verify what was stored
  const row = await db.plaidItem.findUniqueOrThrow({ where: { id: item.id }, include: { accounts: true } });
  assert.ok(!row.accessTokenEnc.includes("access-sandbox"), "access token is not stored in plaintext");
  assert.match(row.accessTokenEnc, /^v1\./);
  const plain = decrypt(row.accessTokenEnc);
  assert.ok(plain.startsWith("access-sandbox-"));
  const live = await client.accountsGet({ access_token: plain }); // decrypted token works
  assert.equal(live.data.accounts.length, row.accounts.length);
  assert.ok(row.accounts.length > 0);
  assert.equal(row.cursor, null);
  console.log(`accounts stored: ${row.accounts.length}`);
  for (const a of row.accounts) console.log(`  ${a.name} ••••${a.mask} (${a.type}/${a.subtype})`);

  // 5. the same institution again is refused (and its new Item removed at Plaid); a second link is
  //    refused while one is in flight; a different institution connects as a second bank
  assert.equal(row.institutionId, "ins_109508");
  const pt2 = await client.sandboxPublicTokenCreate({ institution_id: "ins_109508", initial_products: [Products.Transactions] });
  await assert.rejects(connectItem({ businessId: business.id, publicToken: pt2.data.public_token }), PlaidInstitutionAlreadyConnectedError);
  console.log("same institution refused");
  await createLinkToken(business.id);
  await assert.rejects(createLinkToken(business.id), PlaidConnectInProgressError);
  console.log("second link token refused while one is in flight");
  const pt3 = await client.sandboxPublicTokenCreate({
    institution_id: "ins_109511", // Tartan Bank
    initial_products: [Products.Transactions],
    options: { override_username: "user_good", override_password: "pass_good", transactions: { days_requested: PLAID_DAYS_REQUESTED } },
  });
  const second = await connectItem({ businessId: business.id, publicToken: pt3.data.public_token });
  assert.notEqual(second.id, item.id);
  assert.equal(await db.plaidItem.count({ where: { businessId: business.id, environment: "sandbox" } }), 2);
  console.log(`second bank connected: ${second.institutionName}`);

  if (keep) console.log("\n--keep: sandbox Item left in dev DB (remove with: npm run plaid:sandbox-remove)");
  else {
    await removeSandbox(business.id);
    console.log("cleaned up");
  }
  console.log("plaid sandbox e2e ok");
}

main()
  .catch((e) => {
    console.error("FAILED:", plaidErrorSummary(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
