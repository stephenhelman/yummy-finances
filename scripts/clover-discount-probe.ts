// Read-only (Clover GET only). Shows how discounts appear on orders and whether they reconcile with payments, so the
// discount sync is built on the real shape. Prints amounts, counts and discount NAMES only: no customers, notes or ids.
// Usage: npm run probe:clover-discounts [days=45]
import "dotenv/config";
import { CloverClient, type CloverObject } from "../src/lib/clover/client";

const days = Number(process.argv[2] ?? 45);
const els = (v: unknown): CloverObject[] => (v && typeof v === "object" && Array.isArray((v as { elements?: unknown }).elements) ? ((v as { elements: CloverObject[] }).elements) : []);
const num = (v: unknown) => (typeof v === "number" ? v : null);
const usd = (c: number | null) => (c === null ? "n/a" : (c / 100).toFixed(2));

async function main() {
  const client = CloverClient.fromEnv();
  const end = Date.now();
  const orders = await client.listOrders(end - days * 86_400_000, end, "discounts,lineItems,lineItems.discounts,lineItems.modifications,payments");
  console.log(`${orders.length} orders in the last ${days} days`);

  const withDiscount = orders.filter((o) => els(o.discounts).length || els(o.lineItems).some((l) => els(l.discounts).length));
  console.log(`${withDiscount.length} with any discount (order-level or line-level)`);
  console.log(`order keys: ${Object.keys(orders[0] ?? {}).sort().join(", ")}`);
  const sampleLine = els(orders.find((o) => els(o.lineItems).length)?.lineItems)[0];
  console.log(`lineItem keys: ${Object.keys(sampleLine ?? {}).sort().join(", ")}`);
  const sampleDisc = els(withDiscount[0]?.discounts)[0] ?? els(els(withDiscount[0]?.lineItems).find((l) => els(l.discounts).length)?.discounts)[0];
  console.log(`discount keys: ${Object.keys(sampleDisc ?? {}).sort().join(", ")}\n`);

  // Pre-discount subtotal from the lines: price + modifier amounts (each line element is one unit).
  const lineTotal = (l: CloverObject) => (num(l.price) ?? 0) + els(l.modifications).reduce((a, m) => a + (num(m.amount) ?? 0), 0);
  const afterDiscounts = (o: CloverObject) => els(o.payments).filter((p) => p.result === "SUCCESS").reduce((a, p) => a + (num(p.amount) ?? 0) - (num(p.taxAmount) ?? 0), 0);

  // Sanity: with no discount at all, Σ lines should equal what was paid before tax.
  const plain = orders.filter((o) => !els(o.discounts).length && !els(o.lineItems).some((l) => els(l.discounts).length) && afterDiscounts(o) > 0);
  const plainOk = plain.filter((o) => Math.abs(els(o.lineItems).reduce((a, l) => a + lineTotal(l), 0) - afterDiscounts(o)) <= 1).length;
  console.log(`undiscounted paid orders: Σ(price+modifiers) = payments.amount − tax for ${plainOk} of ${plain.length}`);

  const H = { onlyFixed: [0, 0], onlyPct: [0, 0], both_pctFirst: [0, 0], both_fixedFirst: [0, 0], lineLevel: [0, 0] } as Record<string, number[]>;
  const miss: string[] = [];
  for (const o of orders) {
    const lines = els(o.lineItems);
    const od = els(o.discounts);
    const ld = lines.flatMap((l) => els(l.discounts));
    if (!od.length && !ld.length) continue;
    const A = afterDiscounts(o);
    if (A <= 0) continue;
    const S = lines.reduce((a, l) => a + lineTotal(l), 0);
    const fixed = od.filter((d) => num(d.amount) !== null).reduce((a, d) => a + Math.abs(num(d.amount) ?? 0), 0);
    const pcts = od.filter((d) => num(d.percentage) !== null && num(d.amount) === null).map((d) => (num(d.percentage) as number) / 100);
    const pctFactor = pcts.reduce((a, p) => a * (1 - p), 1);
    const bucket = ld.length ? "lineLevel" : pcts.length && fixed ? "both" : pcts.length ? "onlyPct" : "onlyFixed";
    const test = (key: string, predicted: number) => { H[key][1]++; if (Math.abs(predicted - A) <= 1) H[key][0]++; };
    if (bucket === "onlyFixed") test("onlyFixed", S - fixed);
    else if (bucket === "onlyPct") test("onlyPct", S * pctFactor);
    else if (bucket === "both") { test("both_pctFirst", S * pctFactor - fixed); test("both_fixedFirst", (S - fixed) * pctFactor); }
    else H.lineLevel[1]++;
    if (bucket === "onlyPct" && Math.abs(S * pctFactor - A) > 1 && miss.length < 6) miss.push(`S=${usd(S)} pct=${pcts.join("+")} A=${usd(A)} (S×factor=${usd(Math.round(S * pctFactor))}) lines=${lines.length}`);
  }
  for (const [k, [ok, n]] of Object.entries(H)) console.log(`${k.padEnd(16)} predicted payments.amount − tax exactly (±1¢) for ${ok} of ${n}`);
  if (miss.length) console.log(`percent-only misses:\n  ${miss.join("\n  ")}`);
  const names = new Map<string, number>();
  for (const o of withDiscount) for (const d of [...els(o.discounts), ...els(o.lineItems).flatMap((l) => els(l.discounts))]) names.set(String(d.name ?? "?"), (names.get(String(d.name ?? "?")) ?? 0) + 1);
  console.log(`discount names: ${[...names].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} ×${c}`).join(", ")}`);
}
main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; });
