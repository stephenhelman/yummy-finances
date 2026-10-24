import { CountryCode, Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { buildLinkTokenRequest } from "@/lib/plaid-link";
import { parseRedirectUri, resolvePlaidEnv, type PlaidEnvName } from "@/lib/plaid-config";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { classifyErrorCode, classifyItem, defaultIncluded, type ItemHealth } from "@/lib/plaid-health";

// SECURITY: never log access tokens, public tokens or raw SDK errors. The SDK's axios errors
// carry the request body (tokens and the client secret); use plaidErrorSummary() instead.

export { PlaidItemUnusableError };

export class PlaidAlreadyConnectedError extends Error {
  constructor() {
    super("A bank is already connected for this environment");
    this.name = "PlaidAlreadyConnectedError";
  }
}

/** The one place a Plaid client is built, so the production guard cannot be bypassed. */
export function getPlaid(): { client: PlaidApi; env: PlaidEnvName } {
  const env = resolvePlaidEnv();
  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[env],
      baseOptions: {
        headers: { "PLAID-CLIENT-ID": requireEnv("PLAID_CLIENT_ID"), "PLAID-SECRET": requireEnv("PLAID_SECRET") },
      },
    }),
  );
  return { client, env };
}

/** Safe, loggable description of a Plaid failure: code and message only. */
export function plaidErrorSummary(e: unknown): string {
  const data = (e as { response?: { data?: { error_code?: string; error_type?: string; error_message?: string } } })?.response?.data;
  if (data?.error_code) return `${data.error_type ?? "PLAID_ERROR"}/${data.error_code}: ${data.error_message ?? ""}`.trim();
  return e instanceof Error ? e.message : "unknown error";
}

async function currentItem(businessId: string, env: PlaidEnvName) {
  return db.plaidItem.findUnique({ where: { businessId_environment: { businessId, environment: env } } });
}

export async function createLinkToken(businessId: string): Promise<string> {
  const { client, env } = getPlaid();
  // One Item per environment: don't start a Link flow that would be refused (reconnect is a later step).
  if (await currentItem(businessId, env)) throw new PlaidAlreadyConnectedError();
  const res = await client.linkTokenCreate(buildLinkTokenRequest({ userId: businessId, redirectUri: parseRedirectUri() }));
  return res.data.link_token;
}

/**
 * Exchanges a Link public_token, stores the encrypted access token and the accounts.
 * If we cannot persist after a successful exchange, the new Item is removed at Plaid so a
 * non-recyclable slot isn't silently orphaned.
 */
export async function connectItem(args: { businessId: string; publicToken: string }) {
  const { businessId, publicToken } = args;
  const { client, env } = getPlaid();
  if (await currentItem(businessId, env)) throw new PlaidAlreadyConnectedError();

  const exchange = await client.itemPublicTokenExchange({ public_token: publicToken });
  const accessToken = exchange.data.access_token;
  const plaidItemId = exchange.data.item_id;

  try {
    const accounts = await client.accountsGet({ access_token: accessToken });
    let institutionName: string | null = null;
    const institutionId = accounts.data.item.institution_id;
    if (institutionId) {
      try {
        const inst = await client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
        institutionName = inst.data.institution.name;
      } catch {
        institutionName = null; // cosmetic; don't fail the connection over it
      }
    }

    return await db.$transaction(async (tx) => {
      const item = await tx.plaidItem.create({
        data: {
          businessId,
          plaidItemId,
          environment: env,
          accessTokenEnc: encrypt(accessToken),
          institutionName,
          status: "OK",
        },
      });
      await tx.bankAccount.createMany({
        data: accounts.data.accounts.map((a) => ({
          businessId,
          plaidItemId: item.id,
          plaidAccountId: a.account_id,
          name: a.name,
          mask: a.mask ?? null,
          type: a.type,
          subtype: a.subtype ?? null,
          included: defaultIncluded(a.type),
        })),
      });
      return item;
    });
  } catch (e) {
    try {
      await client.itemRemove({ access_token: accessToken });
    } catch {
      // Log the Item id (not a secret) so the orphan can be removed by hand.
      console.error(`Plaid: failed to persist Item ${plaidItemId} and failed to remove it; remove it manually`);
    }
    throw e;
  }
}

async function loadItem(businessId: string, env: PlaidEnvName) {
  const item = await currentItem(businessId, env);
  if (!item) throw new Error("No bank is connected for this environment");
  return item;
}

/** Link update-mode token for the existing Item (re-authentication). Same production guard. */
export async function createUpdateLinkToken(businessId: string): Promise<string> {
  const { client, env } = getPlaid();
  const item = await loadItem(businessId, env);
  const accessToken = unlockItemToken(item, env);
  const res = await client.linkTokenCreate(buildLinkTokenRequest({ userId: businessId, redirectUri: parseRedirectUri(), accessToken }));
  return res.data.link_token;
}

/**
 * Calls /item/get and records the result on the PlaidItem (status, lastErrorCode, lastCheckedAt).
 * A network failure (no Plaid response) is rethrown and leaves the stored status untouched.
 * Called after reconnects now; by sync and cron later.
 */
export async function checkItemHealth(itemId: string, now = new Date()): Promise<ItemHealth> {
  const { client, env } = getPlaid();
  const item = await db.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
  const accessToken = unlockItemToken(item, env); // throws PlaidItemUnusableError for a foreign/undecryptable Item

  let health: ItemHealth;
  try {
    const res = await client.itemGet({ access_token: accessToken });
    health = classifyItem(
      { error: res.data.item.error, consentExpirationTime: res.data.item.consent_expiration_time },
      now,
    );
  } catch (e) {
    const data = (e as { response?: { data?: { error_code?: string; error_message?: string } } })?.response?.data;
    if (!data?.error_code) throw e; // not a Plaid answer: don't guess a status
    health = { status: classifyErrorCode(data.error_code), errorCode: data.error_code, message: data.error_message ?? null };
  }

  await db.plaidItem.update({
    where: { id: item.id },
    data: { status: health.status, lastErrorCode: health.errorCode, lastError: health.message, lastCheckedAt: now },
  });
  return health;
}

/**
 * Re-reads accounts from Plaid. New accounts get the type-based default. Existing accounts get
 * fresh name/mask/type; their `included` flag is only re-derived while the user has never set
 * it. Accounts that disappear at the bank are kept (their history stays).
 */
export async function refreshAccounts(itemId: string): Promise<{ created: number; updated: number }> {
  const { client, env } = getPlaid();
  const item = await db.plaidItem.findUniqueOrThrow({ where: { id: itemId } });
  const res = await client.accountsGet({ access_token: unlockItemToken(item, env) });
  const existing = new Map((await db.bankAccount.findMany({ where: { plaidItemId: item.id } })).map((a) => [a.plaidAccountId, a]));

  let created = 0, updated = 0;
  for (const a of res.data.accounts) {
    const fields = { name: a.name, mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null };
    const prev = existing.get(a.account_id);
    if (!prev) {
      await db.bankAccount.create({
        data: { businessId: item.businessId, plaidItemId: item.id, plaidAccountId: a.account_id, ...fields, included: defaultIncluded(a.type) },
      });
      created++;
    } else {
      await db.bankAccount.update({
        where: { id: prev.id },
        data: prev.includedSetByUser ? fields : { ...fields, included: defaultIncluded(a.type) },
      });
      updated++;
    }
  }
  return { created, updated };
}

/**
 * After a Link update-mode session: re-check health (the status is whatever Plaid reports, not
 * assumed OK) and refresh accounts, respecting the user's included choices.
 */
export async function completeReconnect(businessId: string): Promise<ItemHealth> {
  const { env } = getPlaid();
  const item = await loadItem(businessId, env);
  const health = await checkItemHealth(item.id);
  if (health.status === "OK" || health.status === "PENDING_EXPIRATION") await refreshAccounts(item.id);
  return health;
}
