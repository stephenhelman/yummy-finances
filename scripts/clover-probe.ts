// Read-only Clover probe. Prints a summary to the console and writes a
// redacted JSON report to ./probe-output/ (gitignored). No DB access, no writes
// anywhere except that folder. Run: npm run probe:clover
//
// Goal: learn from the live merchant what the unverified fields mean, chiefly
//   - does payment.amount include tipAmount and/or taxAmount?
//   - what are the payment `result` values and timestamp units?
//   - where does the merchant timezone live?
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CloverApiError, CloverClient, type CloverObject } from "../src/lib/clover/client";
import { findTimezoneFields, redact, shapeOf } from "../src/lib/clover/redact";

const DAY = 86_400_000;
const WINDOW_DAYS = 30;

type Section = { ok: boolean; error?: string; count?: number; usedExpand?: string | null; shape?: unknown; sample?: unknown };

async function attempt<T>(label: string, fn: () => Promise<T>): Promise<{ value?: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (e) {
    const msg = e instanceof CloverApiError ? `HTTP ${e.status}` : (e as Error).message;
    console.log(`  ! ${label}: ${msg}`);
    return { error: msg };
  }
}

/** Try each expand option in order until one is accepted (field names are unverified). */
async function pageWithExpandFallback(
  client: CloverClient,
  path: string,
  expands: (string | undefined)[],
  extra: Record<string, string | number | string[]>,
) {
  let lastErr: string | undefined;
  for (const expand of expands) {
    const r = await attempt(`${path} expand=${expand ?? "(none)"}`, () => client.getPage(path, { ...extra, expand }));
    if (r.value) return { items: r.value, expand: expand ?? null };
    lastErr = r.error;
  }
  return { items: undefined, expand: null, error: lastErr };
}

function section(items: CloverObject[] | undefined, expand: string | null, error?: string): Section {
  if (!items) return { ok: false, error };
  return { ok: true, count: items.length, usedExpand: expand, shape: shapeOf(items), sample: redact(items) };
}

const num = (v: unknown) => (typeof v === "number" ? v : null);

async function main() {
  const client = CloverClient.fromEnv();
  const now = Date.now();
  const since = now - WINDOW_DAYS * DAY;
  const filter = [`createdTime>=${since}`, `createdTime<=${now}`];
  console.log(`Clover probe (read-only), last ${WINDOW_DAYS} days\n`);

  const report: Record<string, unknown> = { generatedAt: new Date(now).toISOString(), windowDays: WINDOW_DAYS };

  // Merchant + properties: where is the timezone?
  const merchant = await attempt("merchant", () => client.getMerchant());
  const props = await attempt("merchant properties", () => client.getMerchantProperties());
  const tzFields = [...findTimezoneFields(merchant.value), ...findTimezoneFields(props.value)];
  report.merchant = { ok: !!merchant.value, error: merchant.error, shape: shapeOf(merchant.value), sample: redact(merchant.value) };
  report.properties = { ok: !!props.value, error: props.error, shape: shapeOf(props.value), sample: redact(props.value) };
  report.timezoneFields = tzFields;
  console.log("Timezone fields found:", tzFields.length ? tzFields.map((f) => `${f.path}=${JSON.stringify(f.value)}`).join(", ") : "NONE (use BUSINESS_TIMEZONE)");

  // Payments: with order expanded we can compare payment.amount to order.total.
  const pay = await pageWithExpandFallback(client, "/payments", ["order,refunds", "order", undefined], { limit: 25, filter });
  report.payments = section(pay.items, pay.expand, pay.error);

  const rows = (pay.items ?? []).map((p) => {
    const order = (p.order && typeof p.order === "object" ? p.order : {}) as Record<string, unknown>;
    return {
      result: typeof p.result === "string" ? p.result : null,
      amount: num(p.amount),
      tipAmount: num(p.tipAmount),
      taxAmount: num(p.taxAmount),
      orderTotal: num(order.total),
      createdTime: num(p.createdTime),
    };
  });
  const results = [...new Set(rows.map((r) => r.result))];
  const ms = rows.map((r) => r.createdTime).filter((t): t is number => t !== null);
  // 13-digit epoch values are milliseconds; 10-digit would be seconds.
  const unit = ms.length ? (String(Math.trunc(ms[0])).length >= 13 ? "milliseconds" : "seconds?") : "unknown";
  report.paymentObservations = { rows, results, timestampUnit: unit };
  console.log(`\nPayments sampled: ${rows.length} (expand used: ${pay.expand ?? "none"})`);
  console.log("  result values:", results.join(", ") || "-");
  console.log("  createdTime unit:", unit);
  console.log("  amount   tip   tax   orderTotal  amount-orderTotal  (cents)");
  for (const r of rows.slice(0, 12)) {
    const d = r.amount !== null && r.orderTotal !== null ? r.amount - r.orderTotal : "n/a";
    console.log(`  ${String(r.amount).padStart(6)} ${String(r.tipAmount).padStart(5)} ${String(r.taxAmount).padStart(5)} ${String(r.orderTotal).padStart(10)} ${String(d).padStart(17)}`);
  }
  console.log("  Read: if amount-orderTotal == tipAmount, amount INCLUDES tip; if 0 (with tip > 0), it does NOT.");

  // Refunds
  const ref = await pageWithExpandFallback(client, "/refunds", ["payment", undefined], { limit: 10, filter });
  report.refunds = section(ref.items, ref.expand, ref.error);
  console.log(`\nRefunds sampled: ${ref.items?.length ?? "error"}`);

  // Orders (discount shape)
  const ord = await pageWithExpandFallback(client, "/orders", ["discounts,lineItems", "discounts", undefined], { limit: 10, filter });
  report.orders = section(ord.items, ord.expand, ord.error);
  console.log(`Orders sampled: ${ord.items?.length ?? "error"}`);

  const dir = join(process.cwd(), "probe-output");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `clover-probe-${new Date(now).toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`\nRedacted report written to ${file}`);
}

main().catch((e) => {
  console.error(e instanceof CloverApiError ? `${e.name}: ${e.message}` : (e as Error).message);
  process.exit(1);
});
