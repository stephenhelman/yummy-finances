import type { ItemSyncResult } from "@/lib/plaid/sync";

export type BankSyncResult = {
  itemId: string;
  institution: string | null;
  result: ItemSyncResult | { outcome: "failed"; error: string };
};

/**
 * Syncs every bank one after another. Each Item stands alone (its own cursor, its own health): one
 * that is LOGIN_REQUIRED, ERROR or throws is reported and the rest still sync.
 */
export async function syncBanks(
  items: { id: string; institutionName: string | null }[],
  syncOne: (itemId: string) => Promise<ItemSyncResult>,
  describeError: (e: unknown) => string,
): Promise<BankSyncResult[]> {
  const out: BankSyncResult[] = [];
  for (const item of items) {
    try {
      out.push({ itemId: item.id, institution: item.institutionName, result: await syncOne(item.id) });
    } catch (e) {
      out.push({ itemId: item.id, institution: item.institutionName, result: { outcome: "failed", error: describeError(e) } }); // message only: never the SDK error object
    }
  }
  return out;
}
