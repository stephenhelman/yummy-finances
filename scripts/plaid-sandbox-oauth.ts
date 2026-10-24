// Server-side check of the OAuth path against Plaid's SANDBOX OAuth institution (Platypus OAuth Bank).
// Uses a temporary Plaid Item that is removed at the end. Does NOT touch the database or the sandbox
// Item that is connected there. The browser leg (bank redirect and the /plaid/oauth page) cannot run here.
// Usage: npm run plaid:sandbox-oauth
import "dotenv/config";
import assert from "node:assert/strict";
import { Products } from "plaid";
import { getPlaid, plaidErrorSummary } from "../src/lib/plaid";
import { buildLinkTokenRequest, isRedirectUriProblem } from "../src/lib/plaid-link";
import { PLAID_DAYS_REQUESTED, parseRedirectUri } from "../src/lib/plaid-config";

const OAUTH_INSTITUTION = "ins_127287"; // Platypus OAuth Bank

async function main() {
  const { client, env } = getPlaid();
  assert.equal(env, "sandbox", "sandbox only");
  const redirectUri = parseRedirectUri();
  console.log(`PLAID_REDIRECT_URI: ${redirectUri ?? "(not set)"}`);

  const inst = await client.institutionsGetById({ institution_id: OAUTH_INSTITUTION, country_codes: ["US" as never] });
  console.log(`institution: ${inst.data.institution.name}  oauth=${inst.data.institution.oauth}`);
  assert.equal(inst.data.institution.oauth, true);

  // 1. A new-connection link token, with and without the redirect URI.
  const plain = await client.linkTokenCreate(buildLinkTokenRequest({ userId: "oauth-test" }));
  assert.ok(plain.data.link_token.startsWith("link-sandbox-"));
  console.log("link token without redirect_uri: created");
  if (redirectUri) {
    try {
      const r = await client.linkTokenCreate(buildLinkTokenRequest({ userId: "oauth-test", redirectUri }));
      assert.ok(r.data.link_token.startsWith("link-sandbox-"));
      console.log("link token WITH redirect_uri (new connection): created -> the URI is registered in the Plaid Dashboard");
    } catch (e) {
      const s = plaidErrorSummary(e);
      console.log(`link token WITH redirect_uri (new connection): REFUSED -> ${s}`);
      assert.ok(isRedirectUriProblem(s), "refusal should be recognised as a redirect-URI problem");
      console.log("  (recognised as a redirect-URI problem; the app shows a clear message for this)");
    }
  } else {
    // Prove the failure mode we'd hit in production if the URI were not registered.
    try {
      await client.linkTokenCreate(buildLinkTokenRequest({ userId: "oauth-test", redirectUri: "https://not-registered.example.com/plaid/oauth" }));
      console.log("unregistered redirect_uri was ACCEPTED (unexpected)");
    } catch (e) {
      const s = plaidErrorSummary(e);
      assert.ok(isRedirectUriProblem(s));
      console.log(`unregistered redirect_uri: refused as expected -> ${s}`);
    }
  }

  // 2. An Item at the OAuth institution, created the way Link would hand it back.
  const pt = await client.sandboxPublicTokenCreate({
    institution_id: OAUTH_INSTITUTION,
    initial_products: [Products.Transactions],
    options: { transactions: { days_requested: PLAID_DAYS_REQUESTED } },
  });
  const ex = await client.itemPublicTokenExchange({ public_token: pt.data.public_token });
  const access = ex.data.access_token;
  try {
    console.log("OAuth institution Item: public_token minted and exchanged");
    const accounts = await client.accountsGet({ access_token: access });
    console.log(`accounts: ${accounts.data.accounts.length} (${accounts.data.accounts.map((a) => a.type).filter((v, i, a) => a.indexOf(v) === i).join(", ")})`);
    const item = await client.itemGet({ access_token: access });
    console.log(`item/get: institution=${item.data.item.institution_id} error=${item.data.item.error?.error_code ?? "none"}`);
    const sync = await client.transactionsSync({ access_token: access, options: { include_original_description: true }, count: 50 });
    console.log(`transactions/sync: status=${sync.data.transactions_update_status} added=${sync.data.added.length}`);

    // 3. Update mode for this Item, with the redirect URI (what Reconnect sends).
    const upd = buildLinkTokenRequest({ userId: "oauth-test", accessToken: access, redirectUri });
    assert.equal(upd.redirect_uri, redirectUri);
    assert.equal(upd.products, undefined);
    try {
      const r = await client.linkTokenCreate(upd);
      assert.ok(r.data.link_token.startsWith("link-sandbox-"));
      console.log(`update-mode link token ${redirectUri ? "WITH redirect_uri" : "(no redirect_uri configured)"}: created`);
    } catch (e) {
      console.log(`update-mode link token: REFUSED -> ${plaidErrorSummary(e)}`);
    }
  } finally {
    await client.itemRemove({ access_token: access });
    console.log("temporary OAuth Item removed at Plaid");
  }
  console.log("plaid sandbox oauth (server side) ok");
}

main().catch((e) => {
  console.error("FAILED:", plaidErrorSummary(e));
  process.exitCode = 1;
});
