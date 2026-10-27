// Connecting a bank (public_token -> stored Item), with every side effect behind ConnectDeps so the
// rules can be tested without Plaid or a database. plaid.ts wires in the real thing.

/** This institution already has an Item for the business and environment. */
export class PlaidInstitutionAlreadyConnectedError extends Error {
  constructor(readonly institutionName: string | null = null) {
    super("This bank is already connected");
    this.name = "PlaidInstitutionAlreadyConnectedError";
  }
}

/** Another link or exchange is already in flight for this business. */
export class PlaidConnectInProgressError extends Error {
  constructor() {
    super("A bank connection is already in progress");
    this.name = "PlaidConnectInProgressError";
  }
}

/** Plaid did not say which institution the Item belongs to, so duplicates can't be ruled out. */
export class PlaidInstitutionUnknownError extends Error {
  constructor() {
    super("Plaid did not identify the bank for this connection");
    this.name = "PlaidInstitutionUnknownError";
  }
}

export type PlaidAccountInput = { account_id: string; name: string; mask?: string | null; type: string; subtype?: string | null };

export interface ConnectDeps<TItem> {
  exchange(publicToken: string): Promise<{ accessToken: string; plaidItemId: string }>;
  accounts(accessToken: string): Promise<{ institutionId: string | null; accounts: PlaidAccountInput[] }>;
  institutionName(institutionId: string): Promise<string | null>;
  /** The existing Item for this institution (this business and environment), if any. */
  findByInstitution(institutionId: string): Promise<{ id: string; institutionName: string | null } | null>;
  /** Must throw PlaidInstitutionAlreadyConnectedError if the unique constraint trips (a lost race). */
  create(args: { plaidItemId: string; accessToken: string; institutionId: string; institutionName: string | null; accounts: PlaidAccountInput[] }): Promise<TItem>;
  remove(accessToken: string, plaidItemId: string): Promise<void>;
}

/**
 * Exchanges a Link public_token and stores the Item. `hintInstitutionId` is what Link reported
 * on success (client-supplied, so advisory): it only lets us refuse a known duplicate before the
 * exchange creates a non-recyclable Item. The authoritative check uses the institution Plaid
 * reports for the Item itself. If we can't keep the Item for any reason it is removed at Plaid.
 */
export async function connectWith<TItem>(deps: ConnectDeps<TItem>, publicToken: string, hintInstitutionId?: string | null): Promise<TItem> {
  if (hintInstitutionId) {
    const known = await deps.findByInstitution(hintInstitutionId);
    if (known) throw new PlaidInstitutionAlreadyConnectedError(known.institutionName);
  }

  const { accessToken, plaidItemId } = await deps.exchange(publicToken);
  try {
    const { institutionId, accounts } = await deps.accounts(accessToken);
    if (!institutionId) throw new PlaidInstitutionUnknownError();
    const existing = await deps.findByInstitution(institutionId);
    if (existing) throw new PlaidInstitutionAlreadyConnectedError(existing.institutionName);

    let institutionName: string | null = null;
    try {
      institutionName = await deps.institutionName(institutionId);
    } catch {
      institutionName = null; // cosmetic; don't fail the connection over it
    }
    return await deps.create({ plaidItemId, accessToken, institutionId, institutionName, accounts });
  } catch (e) {
    try {
      await deps.remove(accessToken, plaidItemId);
    } catch {
      // Log the Item id (not a secret) so the orphan can be removed by hand.
      console.error(`Plaid: failed to keep Item ${plaidItemId} and failed to remove it; remove it manually`);
    }
    throw e;
  }
}

export interface ExclusiveLock {
  claim(): Promise<boolean>;
  release(): Promise<void>;
}

/** Runs `fn` only if the lock can be claimed (else PlaidConnectInProgressError); always releases it. */
export async function runExclusive<T>(lock: ExclusiveLock, fn: () => Promise<T>): Promise<T> {
  if (!(await lock.claim())) throw new PlaidConnectInProgressError();
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}
