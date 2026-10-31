// Usage: npm run sync:clover-year -- --year=2025 [--target dev|prod]
// One-time backfill: syncs Clover payments, refunds and orders for every month of a year so a year-over-year line is complete.
// syncCloverMonth(m) covers m and the two months before it (90-day-safe windows inside), so four runs (Mar, Jun, Sep, Dec) cover
// all twelve months. Idempotent: re-running changes nothing. Writes Clover* tables only. Refuses unless DIRECT_URL is the
// allowlisted endpoint for --target (default dev), and prints it first.
import "dotenv/config";
import { db } from "../src/lib/db";
import { syncCloverMonth, LOOKBACK_MONTHS } from "../src/lib/clover/sync";
import { checkGuard } from "../src/lib/predeploy-guard";
import { monthBounds } from "../src/lib/dates";

async function main() {
  const year = process.argv.find((a) => a.startsWith("--year="))?.slice("--year=".length);
  if (!year || !/^20\d\d$/.test(year)) throw new Error("Usage: npm run sync:clover-year -- --year=YYYY [--target dev|prod]");
  const t = process.argv.indexOf("--target");
  const g = checkGuard({ target: t >= 0 ? process.argv[t + 1] : "dev", directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`REFUSED: ${g.reason}`);
  console.log(`Target ${g.target}, endpoint ${g.endpoint}; year ${year}`);

  const business = await db.business.findFirstOrThrow();
  const step = LOOKBACK_MONTHS + 1;
  const targets = Array.from({ length: Math.ceil(12 / step) }, (_, i) => `${year}-${String((i + 1) * step).padStart(2, "0")}`);
  const totals = { payments: 0, refunds: 0, orders: 0, created: 0 };
  for (const month of targets) {
    const r = await syncCloverMonth({ businessId: business.id, timezone: business.timezone, month, maxOrdersById: Infinity });
    for (const m of r.months) {
      totals.payments += m.payments.fetched; totals.refunds += m.refunds.fetched; totals.orders += m.orders?.fetched ?? 0;
      totals.created += m.payments.created + m.refunds.created + (m.orders?.created ?? 0);
      console.log(`${m.month}  payments ${String(m.payments.fetched).padStart(5)} (+${m.payments.created})  refunds ${String(m.refunds.fetched).padStart(4)} (+${m.refunds.created})  orders ${String(m.orders?.fetched ?? 0).padStart(5)} list, +${m.orders?.byId ?? 0} by id (${m.orders?.stillMissing ?? 0} still missing)${m.monthLocked ? "  [LOCKED]" : ""}`);
    }
  }
  console.log(`\nDone: ${totals.payments} payments, ${totals.refunds} refunds, ${totals.orders} orders seen, ${totals.created} rows created.`);

  // what is stored per month now, by saleTime (what a report uses)
  console.log("\nStored successful payments by month:");
  for (let m = 1; m <= 12; m++) {
    const month = `${year}-${String(m).padStart(2, "0")}`;
    const { start, end } = monthBounds(month, business.timezone);
    const [p, r] = await Promise.all([
      db.cloverPayment.aggregate({ where: { businessId: business.id, saleTime: { gte: start, lt: end }, result: "SUCCESS", excluded: false }, _count: { _all: true }, _sum: { amountCents: true, taxCents: true } }),
      db.cloverRefund.count({ where: { businessId: business.id, saleTime: { gte: start, lt: end } } }),
    ]);
    console.log(`  ${month}  ${String(p._count._all).padStart(5)} payments  $${(((p._sum.amountCents ?? 0) - (p._sum.taxCents ?? 0)) / 100).toFixed(2).padStart(10)} before tax  ${String(r).padStart(3)} refunds`);
  }
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
