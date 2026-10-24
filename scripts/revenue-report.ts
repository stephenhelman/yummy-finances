// Usage: npm run revenue -- --month=2026-09
// Prints the month's revenue figures from synced Clover rows. Read-only.
import "dotenv/config";
import { db } from "../src/lib/db";
import { loadMonthRevenue } from "../src/lib/revenue-db";
import type { Split } from "../src/lib/revenue";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" }).padStart(12);
const row = (label: string, s: Split) => console.log(`  ${label.padEnd(24)}${usd(s.total)}${usd(s.card)}${usd(s.cash)}`);

async function main() {
  const month = process.argv.find((a) => a.startsWith("--month="))?.slice(8);
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Usage: npm run revenue -- --month=YYYY-MM");
  console.log(`DB host: ${new URL(process.env.DATABASE_URL ?? "").host}`);
  const b = await db.business.findFirstOrThrow();
  const r = await loadMonthRevenue({ businessId: b.id, timezone: b.timezone, month });

  console.log(`\nRevenue ${r.month} (${r.timezone})  ${r.startUtc} -> ${r.endUtc}`);
  console.log(`  ${"".padEnd(24)}${"total".padStart(12)}${"card".padStart(12)}${"cash".padStart(12)}`);
  row("Gross sales", r.grossSales);
  row("Refunds", r.refunds);
  row("NET SALES", r.netSales);
  row("Sales tax (memo)", r.salesTaxCollected);
  row("Tips (memo)", r.tips);
  console.log(`  payments counted: ${r.counts.payments.total} (card ${r.counts.payments.card}, cash ${r.counts.payments.cash})`);
  console.log(`  refunds counted:  ${r.counts.refunds.total} (card ${r.counts.refunds.card}, cash ${r.counts.refunds.cash})`);
  console.log(`  ignored: ${r.ignored.payments} non-SUCCESS/excluded payments, ${r.ignored.refunds} voided/failed refunds, ${r.ignored.outsideMonth} outside month`);
  console.log(`  effective tax rate: ${r.effectiveTaxRate === null ? "n/a" : (r.effectiveTaxRate * 100).toFixed(2) + "%"}`);
  for (const w of r.warnings) console.log(`  WARNING [${w.code}] ${w.message}`);
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
