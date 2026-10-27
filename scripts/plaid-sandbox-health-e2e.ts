// Sandbox end-to-end: account selection, item health, update-mode token. Dev DB, no browser.
// Usage: npm run plaid:sandbox-health-e2e   (removes the sandbox Item at Plaid and in the DB when done)
// Never prints any token.
import "dotenv/config";
import assert from "node:assert/strict";
import { Products } from "plaid";
import { db } from "../src/lib/db";
import { decrypt } from "../src/lib/crypto";
import { PLAID_DAYS_REQUESTED } from "../src/lib/plaid-config";
import { checkItemHealth, completeReconnect, connectItem, abandonLink, createLinkToken, createUpdateLinkToken, getPlaid, plaidErrorSummary, refreshAccounts } from "../src/lib/plaid";
import { removeSandbox } from "./plaid-sandbox-remove";

async function main() {
  const { client, env } = getPlaid();
  assert.equal(env, "sandbox", "sandbox only");
  const business = await db.business.findFirstOrThrow();
  await removeSandbox(business.id);

  try {
    // --- connect, then check the type-based include defaults
    const pt = await client.sandboxPublicTokenCreate({
      institution_id: "ins_109508",
      initial_products: [Products.Transactions],
      options: { override_username: "user_good", override_password: "pass_good", transactions: { days_requested: PLAID_DAYS_REQUESTED } },
    });
    const item = await connectItem({ businessId: business.id, publicToken: pt.data.public_token });
    const accounts = await db.bankAccount.findMany({ where: { plaidItemId: item.id } });
    for (const a of accounts) assert.equal(a.included, a.type === "depository" || a.type === "credit", `${a.name} default`);
    assert.ok(accounts.every((a) => !a.includedSetByUser));
    const inc = accounts.filter((a) => a.included).length;
    console.log(`defaults ok: ${inc} of ${accounts.length} included (depository+credit); loans/investments off`);

    // --- user choices survive a refresh; non-user rows follow Plaid; deleted rows come back
    const checking = accounts.find((a) => a.subtype === "checking")!;
    const mortgage = accounts.find((a) => a.subtype === "mortgage")!;
    const savings = accounts.find((a) => a.subtype === "savings")!;
    await db.bankAccount.update({ where: { id: checking.id }, data: { included: false, includedSetByUser: true } }); // user excludes checking
    await db.bankAccount.update({ where: { id: mortgage.id }, data: { included: true, includedSetByUser: true } }); // user includes a loan
    await db.bankAccount.update({ where: { id: savings.id }, data: { included: false } }); // drifted, NOT set by user
    await db.bankAccount.delete({ where: { id: accounts.find((a) => a.subtype === "student")!.id } });
    const r = await refreshAccounts(item.id);
    const after = new Map((await db.bankAccount.findMany({ where: { plaidItemId: item.id } })).map((a) => [a.id, a]));
    assert.equal(after.get(checking.id)!.included, false, "user exclusion survives refresh");
    assert.equal(after.get(mortgage.id)!.included, true, "user inclusion survives refresh");
    assert.equal(after.get(savings.id)!.included, true, "non-user value re-derived from type");
    assert.equal(r.created, 1);
    assert.equal((await db.bankAccount.findMany({ where: { plaidItemId: item.id } })).length, accounts.length);
    console.log(`refresh ok: created ${r.created}, updated ${r.updated}; user choices preserved`);

    // --- health: OK
    let h = await checkItemHealth(item.id);
    let row = await db.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(h.status, "OK");
    assert.equal(row.status, "OK");
    assert.equal(row.lastErrorCode, null);
    assert.ok(row.lastCheckedAt);
    console.log(`health: ${row.status}, lastCheckedAt set`);

    // --- force login required
    const access = decrypt(row.accessTokenEnc);
    await client.sandboxItemResetLogin({ access_token: access });
    h = await checkItemHealth(item.id);
    row = await db.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(h.status, "LOGIN_REQUIRED");
    assert.equal(row.status, "LOGIN_REQUIRED");
    assert.equal(row.lastErrorCode, "ITEM_LOGIN_REQUIRED");
    console.log(`after reset_login: status=${row.status} lastErrorCode=${row.lastErrorCode}`);

    // --- update-mode token works server-side; normal connect token still refused
    const upd = await createUpdateLinkToken(business.id, item.id);
    assert.ok(upd.startsWith("link-sandbox-"));
    console.log("update-mode link_token created");
    // several banks are allowed, so a connect token is still issued (duplicates are refused at exchange)
    assert.ok((await createLinkToken(business.id)).startsWith("link-sandbox-"));
    await abandonLink(business.id);

    // --- completeReconnect is honest: Link not completed, so Plaid still says login required
    const re = await completeReconnect(business.id, item.id);
    assert.equal(re.status, "LOGIN_REQUIRED", "status is not assumed OK");
    console.log(`completeReconnect without a real Link session -> ${re.status} (not blindly OK)`);
  } finally {
    const n = await removeSandbox(business.id);
    console.log(`cleaned up (${n} sandbox item removed at Plaid and in DB)`);
  }
  console.log("plaid sandbox health e2e ok");
}

main()
  .catch((e) => {
    console.error("FAILED:", plaidErrorSummary(e));
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
