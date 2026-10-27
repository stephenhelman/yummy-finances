import { CountryCode, Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireEnv } from "@/lib/env";
import { buildLinkTokenRequest } from "@/lib/plaid-link";
import { parseRedirectUri, resolvePlaidEnv, type PlaidEnvName } from "@/lib/plaid-config";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { classifyErrorCode, classifyItem, defaultIncluded, type ItemHealth } from "@/lib/plaid-health";
import { claimLock, releaseLock } from "@/lib/job-lock";
import {
  PlaidConnectInProgressError,
  PlaidInstitutionAlreadyConnectedError,
  PlaidInstitutionUnknownError,
  connectWith,
  runExclusive,
  type ConnectDeps,
} from "@/lib/plaid-connect";

// SECURITY: never log access tokens, public tokens or raw SDK errors. The SDK's axios errors
// carry the request body (tokens and the client secret); use plaidErrorSummary() instead.

export { PlaidItemUnusableError };

export { PlaidConnectInProgressError, PlaidInstitutionAlreadyConnectedError, PlaidInstitutionUnknownError };

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

/** Every Item the business has in this Plaid environment, oldest first. */
export async function itemsFor(businessId: string, env: PlaidEnvName) {
  return db.plaidItem.findMany({ where: { businessId, environment: env }, orderBy: { createdAt: "asc" } });
}

const LINK_JOB = "plaid-link"; // a Link session is open (from link token to exchange or exit)
const EXCHANGE_JOB = "plaid-exchange"; // a public token is being exchanged and stored
const LINK_STALE = "10 minutes";
const EXCHANGE_STALE = "2 minutes";

const linkLock = (businessId: string) => ({ claim: () => claimLock(businessId, LINK_JOB, LINK_STALE), release: () => releaseLock(businessId, LINK_JOB) });
const exchangeLock = (businessId: string) => ({ claim: () => claimLock(businessId, EXCHANGE_JOB, EXCHANGE_STALE), release: () => releaseLock(businessId, EXCHANGE_JOB) });

/** Link was closed without connecting: free the slot so the next attempt isn't refused. */
export async function abandonLink(businessId: string): Promise<void> {
  await releaseLock(businessId, LINK_JOB);
}

/**
 * Link token for connecting a (further) bank. Refused while another link or exchange is in flight,
 * which also stops a double click from opening two sessions. Duplicate banks can't be known until
 * the user picks one in Link, so that check happens at exchange.
 */
export async function createLinkToken(businessId: string): Promise<string> {
  const { client } = getPlaid();
  if (!(await linkLock(businessId).claim())) throw new PlaidConnectInProgressError();
  try {
    const res = await client.linkTokenCreate(buildLinkTokenRequest({ userId: businessId, redirectUri: parseRedirectUri() }));
    return res.data.link_token;
  } catch (e) {
    await linkLock(businessId).release();
    throw e;
  }
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "P2002" || /unique constraint/i.test((e as Error)?.message ?? "");

/**
 * Exchanges a Link public_token, stores the encrypted access token and the accounts. A bank that is
 * already connected is refused, and an Item we can't keep is removed at Plaid so a non-recyclable
 * slot isn't silently orphaned. `hintInstitutionId` is Link's own report of the chosen bank.
 */
export async function connectItem(args: { businessId: string; publicToken: string; hintInstitutionId?: string | null }) {
  const { businessId, publicToken, hintInstitutionId } = args;
  const { client, env } = getPlaid();

  const result = await runExclusive(exchangeLock(businessId), async () => {
    // Items from before multi-bank have no institutionId yet; learn it so they count as connected.
    for (const legacy of (await itemsFor(businessId, env)).filter((i) => !i.institutionId)) {
      await checkItemHealth(legacy.id).catch(() => undefined);
    }

    const deps: ConnectDeps<Awaited<ReturnType<typeof db.plaidItem.create>>> = {
      async exchange(token) {
        const r = await client.itemPublicTokenExchange({ public_token: token });
        return { accessToken: r.data.access_token, plaidItemId: r.data.item_id };
      },
      async accounts(accessToken) {
        const r = await client.accountsGet({ access_token: accessToken });
        return { institutionId: r.data.item.institution_id ?? null, accounts: r.data.accounts };
      },
      async institutionName(institutionId) {
        const r = await client.institutionsGetById({ institution_id: institutionId, country_codes: [CountryCode.Us] });
        return r.data.institution.name;
      },
      findByInstitution: (institutionId) =>
        db.plaidItem.findUnique({
          where: { businessId_environment_institutionId: { businessId, environment: env, institutionId } },
          select: { id: true, institutionName: true },
        }),
      async create({ plaidItemId, accessToken, institutionId, institutionName, accounts }) {
        try {
          return await db.$transaction(async (tx) => {
            const item = await tx.plaidItem.create({
              data: { businessId, plaidItemId, environment: env, accessTokenEnc: encrypt(accessToken), institutionId, institutionName, status: "OK" },
            });
            await tx.bankAccount.createMany({
              data: accounts.map((a) => ({
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
          if (isUniqueViolation(e)) throw new PlaidInstitutionAlreadyConnectedError(institutionName);
          throw e;
        }
      },
      async remove(accessToken) {
        await client.itemRemove({ access_token: accessToken });
      },
    };
    return connectWith(deps, publicToken, hintInstitutionId);
  });
  await abandonLink(businessId); // the Link session ended with this exchange (success or refusal)
  return result;
}

/** One of the business's Items in this environment, or an error if the id is not theirs. */
async function loadItem(businessId: string, env: PlaidEnvName, itemId: string) {
  const item = await db.plaidItem.findFirst({ where: { id: itemId, businessId, environment: env } });
  if (!item) throw new Error("That bank connection was not found for this environment");
  return item;
}

/** Link update-mode token for one existing Item (re-authentication). Same production guard. */
export async function createUpdateLinkToken(businessId: string, itemId: string): Promise<string> {
  const { client, env } = getPlaid();
  const item = await loadItem(businessId, env, itemId);
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
  let institutionId: string | null = null;
  try {
    const res = await client.itemGet({ access_token: accessToken });
    institutionId = res.data.item.institution_id ?? null;
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
    data: {
      status: health.status,
      lastErrorCode: health.errorCode,
      lastError: health.message,
      lastCheckedAt: now,
      ...(!item.institutionId && institutionId ? { institutionId } : {}), // learn it for Items from before multi-bank
    },
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
export async function completeReconnect(businessId: string, itemId: string): Promise<ItemHealth> {
  const { env } = getPlaid();
  const item = await loadItem(businessId, env, itemId);
  const health = await checkItemHealth(item.id);
  if (health.status === "OK" || health.status === "PENDING_EXPIRATION") await refreshAccounts(item.id);
  return health;
}
