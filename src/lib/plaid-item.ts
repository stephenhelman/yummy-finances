import { decrypt } from "@/lib/crypto";

export type ItemUnusableCode = "ENV_MISMATCH" | "KEY_MISMATCH";

/**
 * A stored Plaid Item that this deployment cannot use. Expected after copying a database between
 * environments (e.g. resetting dev from prod): the rows exist but belong to another Plaid
 * environment or were encrypted with another key. Messages are safe to show: no tokens, no stacks.
 */
export class PlaidItemUnusableError extends Error {
  constructor(
    readonly code: ItemUnusableCode,
    message: string,
  ) {
    super(message);
    this.name = "PlaidItemUnusableError";
  }
}

/** The one way to get an access token out of a PlaidItem row. */
export function unlockItemToken(item: { environment: string; accessTokenEnc: string }, currentEnv: string): string {
  if (item.environment !== currentEnv) {
    throw new PlaidItemUnusableError(
      "ENV_MISMATCH",
      `This bank connection belongs to the "${item.environment}" Plaid environment but PLAID_ENV is "${currentEnv}", so it is ignored here.`,
    );
  }
  try {
    return decrypt(item.accessTokenEnc);
  } catch (e) {
    // A missing/malformed ENCRYPTION_KEY is a configuration error, not a key mismatch: say so.
    if (e instanceof Error && e.message.startsWith("ENCRYPTION_KEY")) throw e;
    throw new PlaidItemUnusableError(
      "KEY_MISMATCH",
      "The stored bank token cannot be decrypted with the current ENCRYPTION_KEY (another key encrypted it, e.g. the database was copied from another environment). Restore the original key, or remove this connection and connect again.",
    );
  }
}
