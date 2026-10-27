import { decryptDetailed, encrypt } from "@/lib/crypto";
import { db } from "@/lib/db";

// Re-encrypts every stored Plaid token with the CURRENT ENCRYPTION_KEY. Safe to run repeatedly.
// Returns counts only. Plaintext tokens exist only in local variables here and are never logged.

export type RotationCounts = { total: number; rotated: number; alreadyCurrent: number; failed: number };

export interface TokenStore {
  list(): Promise<{ id: string; accessTokenEnc: string }[]>;
  get(id: string): Promise<string | null>;
  /** Replaces the ciphertext only if it is still `oldEnc` (a concurrent rotation wins). */
  replace(id: string, oldEnc: string, newEnc: string): Promise<boolean>;
}

export async function rotateTokens(store: TokenStore): Promise<RotationCounts> {
  const items = await store.list();
  const counts: RotationCounts = { total: items.length, rotated: 0, alreadyCurrent: 0, failed: 0 };

  for (const item of items) {
    let read: ReturnType<typeof decryptDetailed>;
    try {
      read = decryptDetailed(item.accessTokenEnc);
    } catch (e) {
      // A misconfigured key is not a per-item failure: stop instead of reporting everything as failed.
      if (e instanceof Error && e.message.startsWith("ENCRYPTION_KEY")) throw e;
      counts.failed++;
      continue;
    }
    if (read.key === "current") {
      counts.alreadyCurrent++;
      continue;
    }

    const fresh = encrypt(read.plaintext);
    // Verify the new ciphertext round-trips under the current key BEFORE it replaces the old one.
    const check = decryptDetailed(fresh);
    if (check.key !== "current" || check.plaintext !== read.plaintext) {
      counts.failed++;
      continue;
    }
    if (await store.replace(item.id, item.accessTokenEnc, fresh)) {
      counts.rotated++;
      continue;
    }
    // Changed underneath us (another rotation run): judge the row as it is now.
    const now = await store.get(item.id);
    try {
      if (now && decryptDetailed(now).key === "current") counts.alreadyCurrent++;
      else counts.failed++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}

type PlaidItemClient = { plaidItem: Pick<typeof db.plaidItem, "findMany" | "findUnique" | "updateMany"> };

/** Token store over any Prisma client or transaction (so a rehearsal can run inside a rolled-back transaction). */
export function prismaTokenStoreFor(client: PlaidItemClient): TokenStore {
  return {
    async list() {
      return client.plaidItem.findMany({ select: { id: true, accessTokenEnc: true }, orderBy: { createdAt: "asc" } });
    },
    async get(id) {
      return (await client.plaidItem.findUnique({ where: { id }, select: { accessTokenEnc: true } }))?.accessTokenEnc ?? null;
    },
    async replace(id, oldEnc, newEnc) {
      const { count } = await client.plaidItem.updateMany({ where: { id, accessTokenEnc: oldEnc }, data: { accessTokenEnc: newEnc } });
      return count === 1;
    },
  };
}

export const prismaTokenStore: TokenStore = prismaTokenStoreFor(db);
