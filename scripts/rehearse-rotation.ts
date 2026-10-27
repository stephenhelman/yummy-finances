// Rehearses a key rotation against the configured database INSIDE A TRANSACTION THAT IS ALWAYS ROLLED
// BACK, so no stored token changes. Uses a throwaway "new" key; the configured ENCRYPTION_KEY plays the
// role of the old key. Prints counts only. Usage: npm run rehearse:rotation
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { db } from "../src/lib/db";
import { rotateTokens, prismaTokenStoreFor } from "../src/lib/rotate-tokens";

const ROLLBACK = "rehearsal-rollback";
const digest = (xs: string[]) => createHash("sha256").update(xs.join("|")).digest("hex").slice(0, 12);

async function main() {
  const oldKey = process.env.ENCRYPTION_KEY;
  if (!oldKey) throw new Error("ENCRYPTION_KEY is not set");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}  (changes are rolled back)`);

  const before = digest((await db.plaidItem.findMany({ select: { accessTokenEnc: true }, orderBy: { id: "asc" } })).map((i) => i.accessTokenEnc));

  try {
    await db.$transaction(async (tx) => {
      const store = prismaTokenStoreFor(tx);
      // current = throwaway new key, previous = the key the rows are encrypted with today
      process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64");
      process.env.ENCRYPTION_KEY_PREVIOUS = oldKey;
      console.log("run 1 (rotate):    ", await rotateTokens(store));
      console.log("run 2 (idempotent):", await rotateTokens(store));
      // the old key alone can no longer read them, the new key alone can (that is what the final deploy relies on)
      delete process.env.ENCRYPTION_KEY_PREVIOUS;
      console.log("run 3 (no previous key, new key only):", await rotateTokens(store));
      throw new Error(ROLLBACK);
    }, { timeout: 60_000 });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== ROLLBACK) throw e;
  } finally {
    process.env.ENCRYPTION_KEY = oldKey;
    delete process.env.ENCRYPTION_KEY_PREVIOUS;
  }

  const after = digest((await db.plaidItem.findMany({ select: { accessTokenEnc: true }, orderBy: { id: "asc" } })).map((i) => i.accessTokenEnc));
  console.log(before === after ? "rolled back: stored tokens are byte-for-byte unchanged" : "!! stored tokens CHANGED (unexpected)");
  if (before !== after) process.exitCode = 1;
}
main().catch((e) => { console.error("FAILED:", (e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
