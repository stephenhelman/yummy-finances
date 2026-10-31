// Usage: npm run sync:clover -- --month=2026-09
// Syncs the month plus the two months before it (late offline uploads) into the DB
// named by DATABASE_URL and prints counts. Read-only against Clover; writes Clover* tables only.
import "dotenv/config";
import { db } from "../src/lib/db";
import { syncCloverMonth } from "../src/lib/clover/sync";
import { monthBounds } from "../src/lib/dates";

async function main() {
  const month = process.argv.find((a) => a.startsWith("--month="))?.slice("--month=".length);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Usage: npm run sync:clover -- --month=YYYY-MM");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}`);

  const business = await db.business.findFirstOrThrow();
  const report = await syncCloverMonth({ businessId: business.id, timezone: business.timezone, month });
  console.log(`\nSync target ${report.month} (${report.timezone}), tenders: ${report.tenders}`);
  for (const m of report.months) {
    const p = m.payments, r = m.refunds;
    console.log(`\n${m.month}${m.monthLocked ? "  [LOCKED]" : ""}  ${m.startUtc} -> ${m.endUtc}`);
    console.log(`  payments fetched ${p.fetched}  created ${p.created}  updated ${p.updated}  unchanged ${p.unchanged}  outsideWindow ${p.outsideWindow}`);
    console.log(`           unknownTender ${p.unknownTender}  testMode ${p.testMode}  lateCreated ${p.lateCreated}  updatedInLockedMonth ${p.updatedInLockedMonth}`);
    console.log(`  refunds  fetched ${r.fetched}  created ${r.created}  updated ${r.updated}  unchanged ${r.unchanged}  outsideWindow ${r.outsideWindow}`);
    console.log(`           unknownTender ${r.unknownTender}  lateCreated ${r.lateCreated}  updatedInLockedMonth ${r.updatedInLockedMonth}`);
    if (m.orders) console.log(`  orders   fetched ${m.orders.fetched}  created ${m.orders.created}  updated ${m.orders.updated}  unchanged ${m.orders.unchanged}  withDiscount ${m.orders.withDiscount}`);
    if (p.updatedInLockedMonth || r.updatedInLockedMonth) console.log("  WARNING: rows in a LOCKED month changed in Clover; the snapshot is unchanged.");
  }
  console.log(`\nRefunds linked now: ${report.refundsLinked}, unlinked (payment not in DB): ${report.refundsUnlinked}`);

  // Stored state for the target month, by saleTime (what month assignment uses).
  const { start, end } = monthBounds(month, business.timezone);
  const window = { businessId: business.id, saleTime: { gte: start, lt: end } };
  const byResult = await db.cloverPayment.groupBy({ by: ["result"], where: window, _count: true });
  console.log(`\nStored payments in ${month} by saleTime:`, byResult.map((r) => `${r.result}=${r._count}`).join("  "));
  const bySource = await db.cloverPayment.groupBy({ by: ["saleTimeSource"], where: window, _count: true });
  console.log("  saleTime source:", bySource.map((r) => `${r.saleTimeSource}=${r._count}`).join("  "));
  const offline = await db.cloverPayment.findMany({
    where: { ...window, clientCreatedTime: { not: null } },
    select: { createdTime: true, saleTime: true, amountCents: true, tipCents: true, result: true, saleTimeSource: true },
  });
  // Device and server clocks differ by a second or two on normal sales; list only real offline lag.
  const shifted = offline.filter((o) => Math.abs(o.createdTime.getTime() - o.saleTime.getTime()) > 5 * 60_000);
  console.log(`  rows where device time is >5 min before server time (offline uploads): ${shifted.length}`);
  for (const o of shifted) {
    console.log(`    $${(o.amountCents / 100).toFixed(2)} ${o.result}  saleTime ${o.saleTime.toISOString()}  server createdTime ${o.createdTime.toISOString()}  (${o.saleTimeSource})`);
  }
}

main()
  .catch((e) => { console.error((e as Error).message); process.exitCode = 1; })
  .finally(() => db.$disconnect());
