// Usage: npm run sync:plaid
// Syncs every Plaid Item's transactions (each on its own; one failing does not stop the others) into the DB named by DATABASE_URL and prints a report.
import "dotenv/config";
import { db } from "../src/lib/db";
import { getPlaid } from "../src/lib/plaid";
import { PLAID_DAYS_REQUESTED } from "../src/lib/plaid-config";
import { syncPlaidItem } from "../src/lib/plaid/sync";

async function main() {
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const { env } = getPlaid();
  const business = await db.business.findFirstOrThrow();
  const items = await db.plaidItem.findMany({ where: { businessId: business.id, environment: env }, orderBy: { createdAt: "asc" } });
  if (!items.length) throw new Error(`No ${env} Plaid Item is connected`);

  let failed = 0;
  for (const item of items) {
    console.log(`\n=== ${item.institutionName ?? "bank"} (${item.id}) ===`);
    try {
      await syncOne(business.id, item.id, env);
    } catch (e) {
      failed++;
      console.error("FAILED:", (e as Error).message);
    }
  }
  if (failed) process.exitCode = 1;
}

async function syncOne(businessId: string, itemId: string, env: string) {
  const business = { id: businessId };
  const item = { id: itemId };
  const r = await syncPlaidItem(item.id);
  const fresh = await db.plaidItem.findUniqueOrThrow({ where: { id: item.id } });
  console.log(`Item: ${fresh.institutionName ?? "bank"} (${env})  status=${r.itemStatus}${fresh.lastErrorCode ? `  error=${fresh.lastErrorCode}` : ""}`);

  if (r.outcome === "skipped") {
    console.log(r.message ? `SKIPPED: ${r.message}` : `SKIPPED: Item is ${r.itemStatus}${r.errorCode ? ` (${r.errorCode})` : ""}. Reconnect on /admin/connect-bank, then sync again.`);
    return;
  }
  if (r.outcome === "not_ready") {
    console.log("NOT READY: Plaid is still preparing this Item's transactions. Try again shortly. Nothing was changed.");
    return;
  }

  const c = r.counts;
  console.log(`\nPages: ${r.pages}  restarts: ${r.restarts}`);
  console.log(`Plaid reported:  added ${c.apiAdded}   modified ${c.apiModified}   removed ${c.apiRemoved}`);
  console.log(`Applied:         created ${c.created}   updated ${c.updated}   unchanged ${c.unchanged}   removed ${c.removed}   superseded ${c.superseded}`);
  console.log(`Late (locked-month) rows: ${c.late}   needing manual review (audit log): ${c.audited}`);

  const base = { businessId: business.id, account: { plaidItemId: item.id } };
  const live = { ...base, removedAt: null, supersededAt: null };
  const [pending, posted, removed, superseded, range] = await Promise.all([
    db.bankTransaction.count({ where: { ...live, pending: true } }),
    db.bankTransaction.count({ where: { ...live, pending: false } }),
    db.bankTransaction.count({ where: { ...base, removedAt: { not: null } } }),
    db.bankTransaction.count({ where: { ...base, supersededAt: { not: null } } }),
    db.bankTransaction.aggregate({ where: base, _min: { date: true }, _max: { date: true }, _count: true }),
  ]);
  console.log(`\nStored: ${range._count} rows   live pending ${pending}   live posted ${posted}   removed ${removed}   superseded ${superseded}`);
  const min = range._min.date, max = range._max.date;
  if (min && max) {
    const spanDays = Math.round((max.getTime() - min.getTime()) / 86_400_000);
    const ageDays = Math.round((Date.now() - min.getTime()) / 86_400_000);
    console.log(`Dates: earliest ${min.toISOString().slice(0, 10)}   latest ${max.toISOString().slice(0, 10)}   (earliest is ${ageDays} days ago; requested ${PLAID_DAYS_REQUESTED})`);
    console.log(`       span ${spanDays} days`);
  } else console.log("Dates: no transactions stored");

  console.log("\nPer account (included flag is applied at report time, not here):");
  const accounts = await db.bankAccount.findMany({ where: { plaidItemId: item.id }, orderBy: { name: "asc" } });
  for (const a of accounts) {
    const [n, p] = await Promise.all([
      db.bankTransaction.count({ where: { accountId: a.id } }),
      db.bankTransaction.count({ where: { accountId: a.id, pending: true, removedAt: null, supersededAt: null } }),
    ]);
    console.log(`  ${(a.name + (a.mask ? " ••••" + a.mask : "")).padEnd(40)} ${a.included ? "synced    " : "not synced"}  ${String(n).padStart(5)} txns  (${p} pending)`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
