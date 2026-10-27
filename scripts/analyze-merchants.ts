// Usage: npm run analyze:merchants
// READ-ONLY exploration of real transactions before the rules/normalization step. The whole run is one
// Postgres transaction set to READ ONLY, so nothing can be written even by mistake. Output goes to
// ./probe-output/merchants.md (gitignored; it contains real merchant descriptors) and a short console summary.
// The key normalizer here is a throwaway for exploration; it is NOT the step 14 normalizer.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";

// ---------------------------------------------------------------------------------------------
// Types and helpers
// ---------------------------------------------------------------------------------------------
type Tx = {
  id: string;
  date: string; // YYYY-MM-DD
  cents: number; // Plaid sign: + = money out
  raw: string;
  merchant: string | null;
  pfcP: string | null;
  pfcD: string | null;
  acctId: string;
  acct: string; // "Chase ••1234 (checking)"
  bank: string;
  type: string | null;
};

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const cell = (s: string | null | undefined, n = 56) => (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, n);
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const dayStr = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d: string) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(`${d}T00:00:00Z`).getUTCDay()];
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const mostCommon = (xs: (string | null)[]): string | null => {
  const m = new Map<string, number>();
  for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

/** Throwaway: uppercase, strip dates/store numbers/digits/punctuation and bank noise words, keep 3 tokens. */
const NOISE = new Set(["POS", "PURCHASE", "DEBIT", "CARD", "CHECKCARD", "VISA", "RECURRING", "SQ", "TST", "ACH", "WEB", "PPD", "CCD", "ID", "DES", "INDN", "CO"]);
function roughKey(raw: string): string {
  const s = raw
    .toUpperCase()
    .replace(/X{3,}\w*/g, " ") // Plaid masks long numbers as XXXXX1234
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, " ")
    .replace(/[#*]\s*\d*/g, " ")
    .replace(/\d+/g, " ")
    .replace(/[^A-Z&\s]/g, " ");
  const tokens = s.split(/\s+/).filter((t) => t.length > 1 && !NOISE.has(t));
  return tokens.slice(0, 3).join(" ") || "(blank)";
}

type Group = {
  key: string;
  txns: Tx[];
  total: number;
  samples: string[];
  merchant: string | null;
  pfc: string;
  accts: string[];
  banks: string[];
  first: string;
  last: string;
  months: string[];
};

function groupBy(txns: Tx[], sign: 1 | -1): Group[] {
  const map = new Map<string, Tx[]>();
  for (const t of txns) {
    const k = roughKey(t.raw);
    (map.get(k) ?? map.set(k, []).get(k)!).push(t);
  }
  const out: Group[] = [];
  for (const [key, ts] of map) {
    const freq = new Map<string, number>();
    for (const t of ts) freq.set(t.raw, (freq.get(t.raw) ?? 0) + 1);
    const dates = ts.map((t) => t.date).sort();
    out.push({
      key,
      txns: ts,
      total: ts.reduce((a, t) => a + sign * t.cents, 0),
      samples: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r),
      merchant: mostCommon(ts.map((t) => t.merchant)),
      pfc: [mostCommon(ts.map((t) => t.pfcP)), mostCommon(ts.map((t) => t.pfcD))].filter(Boolean).join(" / "),
      accts: [...new Set(ts.map((t) => t.acct))],
      banks: [...new Set(ts.map((t) => t.bank))],
      first: dates[0],
      last: dates[dates.length - 1],
      months: [...new Set(dates.map((d) => d.slice(0, 7)))].sort(),
    });
  }
  return out.sort((a, b) => b.total - a.total);
}

// ---------------------------------------------------------------------------------------------
// Load (read-only)
// ---------------------------------------------------------------------------------------------
async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").host;
  console.log(`DB host: ${host}  (read-only transaction)`);

  const loaded = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); // enforced by Postgres for everything below
      const business = await tx.business.findFirstOrThrow();
      const since = new Date(Date.now() - 365 * 86_400_000);
      const sinceDay = since.toISOString().slice(0, 10);
      const accounts = await tx.bankAccount.findMany({ include: { plaidItem: { select: { institutionName: true, environment: true } } }, orderBy: [{ plaidItemId: "asc" }, { name: "asc" }] });
      const rows = await tx.bankTransaction.findMany({
        where: { pending: false, removedAt: null, supersededAt: null, date: { gte: new Date(`${sinceDay}T00:00:00Z`) } },
        select: { id: true, date: true, amountCents: true, rawDescription: true, merchantName: true, pfcPrimary: true, pfcDetailed: true, accountId: true },
      });
      const allCounts = await tx.bankTransaction.groupBy({ by: ["accountId"], where: { pending: false, removedAt: null, supersededAt: null }, _count: true, _min: { date: true }, _max: { date: true } });
      const clover = await tx.cloverPayment.findMany({ where: { excluded: false, result: "SUCCESS", isCash: false }, select: { amountCents: true, tipCents: true, saleTime: true } });
      const cloverRefunds = await tx.cloverRefund.findMany({ where: { status: "SUCCESS", voided: false, isCash: false }, select: { amountCents: true, saleTime: true } });
      return { business, sinceDay, accounts, rows, allCounts, clover, cloverRefunds };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const { business, sinceDay, accounts, rows, allCounts, clover, cloverRefunds } = loaded;
  const tz = business.timezone;
  const acctById = new Map(accounts.map((a) => [a.id, a]));
  const label = (a: (typeof accounts)[number]) => `${a.plaidItem.institutionName ?? "Bank"} ••${a.mask ?? "????"} (${a.subtype ?? a.type ?? "?"})`;

  const all: Tx[] = rows.flatMap((r) => {
    const a = acctById.get(r.accountId);
    if (!a || !a.included) return []; // INCLUDED accounts only
    return [{ id: r.id, date: r.date.toISOString().slice(0, 10), cents: r.amountCents, raw: r.rawDescription, merchant: r.merchantName, pfcP: r.pfcPrimary, pfcD: r.pfcDetailed, acctId: r.accountId, acct: label(a), bank: a.plaidItem.institutionName ?? "Bank", type: a.type }];
  });
  // A 12-month window touches up to 13 calendar months (partial first and current month).
  const windowMonths = new Set(Array.from({ length: 366 }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 7))).size;
  const outflows = all.filter((t) => t.cents > 0);
  const inflows = all.filter((t) => t.cents < 0);

  const md: string[] = [];
  const log = (s = "") => md.push(s);
  log(`# Merchant analysis (read-only)`);
  log(`Generated ${new Date().toISOString()} · database ${host} · window ${sinceDay} to today · timezone ${tz}`);
  log(`Posted, non-removed, non-superseded transactions on **included** accounts only. The key normalizer is a throwaway.`);
  log();

  // ---- 5. per-account summary ------------------------------------------------------------
  log(`## 1. Accounts`);
  const counts = new Map(allCounts.map((c) => [c.accountId, c]));
  const accountRows = accounts.map((a) => {
    const c = counts.get(a.id);
    const w = all.filter((t) => t.acctId === a.id);
    const o = w.filter((t) => t.cents > 0), i = w.filter((t) => t.cents < 0);
    return [
      cell(a.plaidItem.institutionName), cell(a.name), a.mask ?? "", `${a.type ?? ""}/${a.subtype ?? ""}`, a.included ? "yes" : "no",
      c?._count ?? 0, c?._min.date?.toISOString().slice(0, 10) ?? "", c?._max.date?.toISOString().slice(0, 10) ?? "",
      a.included ? `${o.length} / ${usd(o.reduce((s, t) => s + t.cents, 0))}` : "(excluded)", a.included ? `${i.length} / ${usd(-i.reduce((s, t) => s + t.cents, 0))}` : "(excluded)",
    ];
  });
  log(table(["Bank", "Account", "Mask", "Type", "Included", "Txns (all time)", "First", "Last", "Out, 12mo (n / $)", "In, 12mo (n / $)"], accountRows));
  log();

  // ---- 1. outflows -----------------------------------------------------------------------
  const outGroups = groupBy(outflows, 1);
  const outTotal = outGroups.reduce((a, g) => a + g.total, 0);
  log(`## 2. Outflows by rough key`);
  log(`${outflows.length} outflow transactions, ${usd(outTotal)} total, ${outGroups.length} groups.`);
  log();
  const outRows = (gs: Group[]) =>
    gs.map((g, i) => [
      i + 1, cell(g.key, 40), cell(g.samples[0]), g.samples.slice(1).map((s) => cell(s, 40)).join(" ; "), cell(g.merchant, 30), cell(g.pfc, 50),
      cell(g.accts.join("; "), 60), g.txns.length, usd(g.total), usd(Math.round(g.total / g.txns.length)), g.first, g.last, `${g.months.length}/${windowMonths} ${g.months.length >= windowMonths - 2 ? "(steady)" : ""}`.trim(),
    ]);
  const outHead = ["#", "Key", "Sample 1", "Samples 2-3", "Plaid merchant", "Plaid category", "Accounts", "Count", "Total", "Avg", "First", "Last", "Months"];
  log(table(outHead, outRows(outGroups.slice(0, 100))));
  log();

  // ---- 4. coverage -----------------------------------------------------------------------
  const cum = (n: number) => outGroups.slice(0, n).reduce((a, g) => a + g.total, 0);
  log(`## 3. Coverage of outflow dollars by the biggest groups`);
  log(table(["Top N groups", "Dollars", "% of outflow dollars"], [10, 20, 30, 50, 100].map((n) => [n, usd(cum(n)), `${((cum(n) / outTotal) * 100).toFixed(1)}%`])));
  log();

  // ---- 3. transfers ----------------------------------------------------------------------
  type Pair = { out: Tx; inn: Tx; gap: number; kind: string; ambiguous: boolean };
  const pairs: Pair[] = [];
  const usedIn = new Set<string>();
  const inByAmount = new Map<number, Tx[]>();
  for (const t of inflows) (inByAmount.get(-t.cents) ?? inByAmount.set(-t.cents, []).get(-t.cents)!).push(t);
  for (const o of [...outflows].filter((t) => t.cents >= 100).sort((a, b) => b.cents - a.cents)) {
    const cands = (inByAmount.get(o.cents) ?? []).filter((i) => !usedIn.has(i.id) && i.acctId !== o.acctId && Math.abs(dayNum(i.date) - dayNum(o.date)) <= 5);
    if (!cands.length) continue;
    cands.sort((a, b) => Math.abs(dayNum(a.date) - dayNum(o.date)) - Math.abs(dayNum(b.date) - dayNum(o.date)));
    const best = cands[0];
    const g = Math.abs(dayNum(best.date) - dayNum(o.date));
    const ambiguous = cands.filter((c) => Math.abs(dayNum(c.date) - dayNum(o.date)) === g).length > 1;
    usedIn.add(best.id);
    const kind = o.type === "credit" || best.type === "credit" ? "credit-card payment" : o.bank !== best.bank ? "cross-bank transfer" : "same-bank transfer";
    pairs.push({ out: o, inn: best, gap: g, kind, ambiguous });
  }
  const pairedOutIds = new Set(pairs.map((p) => p.out.id));
  const pairedInIds = new Set(pairs.map((p) => p.inn.id));
  log(`## 4. Likely transfers and card payments (matched across included accounts, same amount, within 5 days)`);
  const kinds = ["cross-bank transfer", "credit-card payment", "same-bank transfer"];
  log(table(["Kind", "Pairs", "Total", "Ambiguous (several equal candidates)"], kinds.map((k) => { const ps = pairs.filter((p) => p.kind === k); return [k, ps.length, usd(ps.reduce((a, p) => a + p.out.cents, 0)), ps.filter((p) => p.ambiguous).length]; })));
  log();
  const patterns = new Map<string, Pair[]>();
  for (const p of pairs) { const k = `${p.kind} | ${p.out.acct} -> ${p.inn.acct} | ${roughKey(p.out.raw)}`; (patterns.get(k) ?? patterns.set(k, []).get(k)!).push(p); }
  log(`### Recurring patterns`);
  log(table(["Kind | from -> to | outflow key", "Pairs", "Total", "Typical gap (days)", "Sample outflow descriptor", "Sample inflow descriptor"],
    [...patterns.entries()].sort((a, b) => b[1].reduce((s, p) => s + p.out.cents, 0) - a[1].reduce((s, p) => s + p.out.cents, 0)).slice(0, 25)
      .map(([k, ps]) => [cell(k, 130), ps.length, usd(ps.reduce((a, p) => a + p.out.cents, 0)), median(ps.map((p) => p.gap)), cell(ps[0].out.raw, 50), cell(ps[0].inn.raw, 50)])));
  log();
  log(`### Largest matched pairs`);
  log(table(["Out date", "In date", "Amount", "Kind", "From", "To", "Outflow descriptor"], [...pairs].sort((a, b) => b.out.cents - a.out.cents).slice(0, 30).map((p) => [p.out.date, p.inn.date, usd(p.out.cents), p.kind, cell(p.out.acct, 34), cell(p.inn.acct, 34), cell(p.out.raw, 50)])));
  log();
  const TRANSFERISH = /TRANSFER|XFER|ONLINE PMT|PAYMENT TO|WIRE|ZELLE|VENMO|CASH ?APP|AUTOPAY|EPAY|CRD|CREDIT CARD|PAYMENT THANK/i;
  const unmatched = [...outflows, ...inflows].filter((t) => !pairedOutIds.has(t.id) && !pairedInIds.has(t.id) && (TRANSFERISH.test(t.raw) || /^TRANSFER|^LOAN_PAYMENTS/.test(t.pfcP ?? "")));
  const unmatchedGroups = groupBy(unmatched.filter((t) => t.cents > 0), 1).slice(0, 25);
  log(`### Transfer-looking outflows with NO match on the other included accounts (counterparty probably not connected)`);
  log(table(["Key", "Sample", "Plaid category", "Account(s)", "Count", "Total"], unmatchedGroups.map((g) => [cell(g.key, 40), cell(g.samples[0]), cell(g.pfc, 45), cell(g.accts.join("; "), 50), g.txns.length, usd(g.total)])));
  log();

  // ---- 2. inflows ------------------------------------------------------------------------
  const inGroups = groupBy(inflows, -1);
  const inTotal = inGroups.reduce((a, g) => a + g.total, 0);
  log(`## 5. Inflows by rough key`);
  log(`${inflows.length} inflow transactions, ${usd(inTotal)} total, ${inGroups.length} groups.`);
  log();
  log(table(outHead, outRows(inGroups.slice(0, 60))));
  log();

  // settlements: descriptor regex + cadence
  const SETTLE = /CLOVER|FISERV|FIRST DATA|FIRSTDATA|\bFD\b|TSYS|ELAVON|HEARTLAND|SQUARE|STRIPE|MERCH|SETTLE|BANKCARD|CARD DEP|CARD PROC|PAYMENT PROCESS|MASTERCARD|\bMC\b|DISCOVER|AMEX|VISA/i;
  const settleGroups = inGroups.filter((g) => g.samples.some((s) => SETTLE.test(s)) || (g.merchant && SETTLE.test(g.merchant)));
  log(`## 6. Deposits that look like card settlements`);
  log(`### 6a. By descriptor (Clover / Fiserv / First Data / processor words)`);
  if (!settleGroups.length) log(`_No inflow group matched the processor words. See 6b, which matches amounts instead._`);
  for (const g of settleGroups.slice(0, 8)) {
    const dates = [...new Set(g.txns.map((t) => t.date))].sort();
    const gaps = dates.slice(1).map((d, i) => dayNum(d) - dayNum(dates[i]));
    const wd = new Map<string, number>();
    for (const t of g.txns) wd.set(weekday(t.date), (wd.get(weekday(t.date)) ?? 0) + 1);
    const perWeek = g.txns.length / Math.max(1, (dayNum(g.last) - dayNum(g.first)) / 7 + 1);
    log(`- **${cell(g.key, 50)}** (${cell(g.accts.join("; "), 60)}): ${g.txns.length} deposits, ${usd(g.total)}, ${g.first} to ${g.last}, about ${perWeek.toFixed(1)}/week, median gap ${median(gaps)} day(s). Weekdays: ${[...wd.entries()].sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d} ${n}`).join(", ")}. Sample: \`${cell(g.samples[0], 80)}\``);
  }
  log();

  // 6b. match deposits to Clover card totals (overlap window only)
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const cardDay = new Map<number, number>();
  for (const p of clover) { const k = dayNum(dayOf(p.saleTime)); cardDay.set(k, (cardDay.get(k) ?? 0) + p.amountCents + p.tipCents); }
  for (const r of cloverRefunds) { const k = dayNum(dayOf(r.saleTime)); cardDay.set(k, (cardDay.get(k) ?? 0) - r.amountCents); }
  const cloverDays = [...cardDay.keys()].sort((a, b) => a - b);
  log(`### 6b. By amount: deposits that equal Clover card sales for the days before them`);
  type Match = { dep: Tx; lag: number; span: number; ratio: number; mode: "fees netted" | "gross (fees separate)" };
  const matches: Match[] = [];
  let tested = 0;
  if (cloverDays.length) {
    const lo = cloverDays[0] + 6, hi = cloverDays[cloverDays.length - 1] + 5;
    const windowSum = (endDay: number, k: number) => { let s = 0; for (let d = endDay - k + 1; d <= endDay; d++) s += cardDay.get(d) ?? 0; return s; };
    const NOT_SETTLEMENT = /TRANSFER|ZELLE|PAYMENT THANK|BKOFAMERICA|PAYROLL|REFUND|COUNTER CREDIT|DEPOSIT/i; // transfers and cash deposits match by coincidence
    for (const dep of inflows.filter((t) => -t.cents >= 2000 && dayNum(t.date) >= lo && dayNum(t.date) <= hi && !NOT_SETTLEMENT.test(t.raw))) {
      tested++;
      const amt = -dep.cents, D = dayNum(dep.date);
      let best: Match | null = null;
      for (let span = 1; span <= 5 && !best; span++) {
        for (let lag = 0; lag <= 4 && !best; lag++) {
          const s = windowSum(D - lag, span);
          if (s <= 0) continue;
          const ratio = amt / s;
          if (Math.abs(ratio - 1) <= 0.002) best = { dep, lag, span, ratio, mode: "gross (fees separate)" };
          else if (ratio >= 0.95 && ratio <= 0.99) best = { dep, lag, span, ratio, mode: "fees netted" };
        }
      }
      if (best) matches.push(best);
    }
    log(`Clover card data covers ${dayStr(cloverDays[0])} to ${dayStr(cloverDays[cloverDays.length - 1])}. Tested ${tested} inflows of $20 or more in that window, excluding transfers, Zelle, cash deposits and refunds (deposits expected to equal the card sales, tips included, of 1 to 5 days ending 0 to 4 days earlier). **${matches.length} matched.** A match is a strong hint, not proof: short windows are preferred to limit coincidences.`);
    log();
    const netted = matches.filter((m) => m.mode === "fees netted");
    const grossM = matches.filter((m) => m.mode === "gross (fees separate)");
    log(`- Fees netted out of the deposit: ${netted.length} deposits${netted.length ? `, average deposit/sales ratio ${(netted.reduce((a, m) => a + m.ratio, 0) / netted.length).toFixed(4)} (implied fee about ${((1 - netted.reduce((a, m) => a + m.ratio, 0) / netted.length) * 100).toFixed(2)}%)` : ""}`);
    log(`- Gross deposit (fees billed separately): ${grossM.length} deposits`);
    log();
    const byWd = new Map<string, Match[]>();
    for (const m of matches) (byWd.get(weekday(m.dep.date)) ?? byWd.set(weekday(m.dep.date), []).get(weekday(m.dep.date))!).push(m);
    log(table(["Deposit weekday", "Matched deposits", "Typical window (days of sales)", "Typical lag (days before deposit)", "Average deposit"],
      ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].filter((d) => byWd.has(d)).map((d) => { const ms = byWd.get(d)!; return [d, ms.length, median(ms.map((m) => m.span)), median(ms.map((m) => m.lag)), usd(Math.round(ms.reduce((a, m) => a + -m.dep.cents, 0) / ms.length))]; })));
    log();
    const matchKeys = new Map<string, Match[]>();
    for (const m of matches) { const k = `${roughKey(m.dep.raw)} | ${m.dep.acct}`; (matchKeys.get(k) ?? matchKeys.set(k, []).get(k)!).push(m); }
    log(`Descriptor groups the matched deposits belong to:`);
    log(table(["Key | account", "Matched deposits", "Total", "Sample descriptor"], [...matchKeys.entries()].sort((a, b) => b[1].length - a[1].length).map(([k, ms]) => [cell(k, 80), ms.length, usd(ms.reduce((a, m) => a + -m.dep.cents, 0)), cell(ms[0].dep.raw, 60)])));
    log();
    log(`Examples:`);
    log(table(["Deposit date", "Deposit", "Window", "Clover card sales", "Ratio", "Mode"], matches.slice(0, 12).map((m) => [m.dep.date, usd(-m.dep.cents), `${m.span}d ending ${m.lag}d earlier`, usd(Math.round(-m.dep.cents / m.ratio)), m.ratio.toFixed(4), m.mode])));

    // 6c. Strict cadence test: each deposit should equal the card sales of the days SINCE THE PREVIOUS
    // deposit (shifted back by a fixed lag). Pick the lag that explains the most deposits.
    log(`### 6c. Cadence test on the processor deposit group`);
    const proc = settleGroups[0];
    if (proc) {
      const byDay = new Map<number, number>();
      for (const t of proc.txns) byDay.set(dayNum(t.date), (byDay.get(dayNum(t.date)) ?? 0) - t.cents);
      const depDays = [...byDay.keys()].filter((d) => d >= cloverDays[0] + 8).sort((a, b) => a - b);
      const prevOf = (d: number) => { const all = [...byDay.keys()].sort((a, b) => a - b); const i = all.indexOf(d); return i > 0 ? all[i - 1] : null; };
      const sumRange = (a: number, b: number) => { let s = 0; for (let d = a; d <= b; d++) s += cardDay.get(d) ?? 0; return s; };
      const res: { lag: number; n: number; ok: number; med: number }[] = [];
      for (let lag = 0; lag <= 3; lag++) {
        const ratios: number[] = [];
        for (const d of depDays) {
          const prev = prevOf(d);
          if (prev === null || d - prev > 5) continue;
          const sales = sumRange(prev - lag + 1, d - lag);
          if (sales > 0) ratios.push(byDay.get(d)! / sales);
        }
        res.push({ lag, n: ratios.length, ok: ratios.filter((r) => r >= 0.94 && r <= 0.995).length, med: median(ratios.map((r) => Math.round(r * 10000))) / 10000 });
      }
      log(`Group: \`${proc.key}\`. ${depDays.length} business-day deposits inside the Clover window. For each lag (days between the last day of sales included and the deposit date), how many deposits equal the sales of the days since the previous deposit (ratio 0.94 to 0.995, i.e. fees netted):`);
      log(table(["Lag (days)", "Deposits tested", "Explained", "Share", "Median deposit / sales"], res.map((r) => [r.lag, r.n, r.ok, r.n ? `${((r.ok / r.n) * 100).toFixed(0)}%` : "-", r.med.toFixed(4)])));
      const bestLag = [...res].sort((a, b) => b.ok - a.ok)[0];
      log(`Best explanation: lag ${bestLag.lag} (${bestLag.ok} of ${bestLag.n}), median deposit/sales ${bestLag.med.toFixed(4)} (implied fee about ${((1 - bestLag.med) * 100).toFixed(2)}%).`);
      const dowCount = new Map<string, number>();
      for (const d of byDay.keys()) dowCount.set(weekday(dayStr(d)), (dowCount.get(weekday(dayStr(d))) ?? 0) + 1);
      log(`Deposit weekdays (all 12 months): ${[...dowCount.entries()].map(([d, n]) => `${d} ${n}`).join(", ")}. Saturday/Sunday deposits: ${(dowCount.get("Sat") ?? 0) + (dowCount.get("Sun") ?? 0)}.`);
    } else log(`_No processor-looking deposit group found._`);
  } else log(`_No Clover card data in the database to compare against._`);
  log();

  // ---- personal-looking descriptors --------------------------------------------------------
  log(`## 7. Descriptors that look personal rather than business (heuristic flags; the owner decides)`);
  const reasons: [RegExp | ((g: Group) => boolean), string][] = [
    [(g) => /^(ENTERTAINMENT|TRAVEL|PERSONAL_CARE|MEDICAL)/.test(g.pfc), "Plaid category is personal-leaning"],
    [(g) => /FOOD_AND_DRINK_(RESTAURANT|FAST_FOOD|COFFEE|BEER_WINE)/.test(g.pfc), "dining out"],
    [/ZELLE|VENMO|CASH ?APP|APPLE CASH|PAYPAL INST/i, "person-to-person payment"],
    [/\bATM\b|CASH WITHDRAWAL/i, "ATM / cash withdrawal"],
    [/NETFLIX|SPOTIFY|HULU|DISNEY|ITUNES|APPLE COM|PRIME VIDEO|YOUTUBE|HBO|PEACOCK|PARAMOUNT|ICLOUD|GOOGLE ONE/i, "streaming / personal subscription"],
    [/MORTGAGE|\bHOA\b/i, "home loan / HOA"],
    [(g) => /MORTGAGE|STUDENT|AUTO|CAR_PAYMENT|EWA|BNPL|CASH_ADVANCE/.test(g.pfc), "personal-leaning loan payment category"],
  ];
  const ambiguous = /WALMART|TARGET|COSTCO|SAMS|H E B|HEB|AMAZON|HOME DEPOT|LOWE|DOLLAR|WALGREENS|CVS/i;
  const flagged = outGroups.map((g) => ({ g, why: reasons.filter(([t]) => (typeof t === "function" ? t(g) : g.samples.some((s) => t.test(s)) || (g.merchant ? t.test(g.merchant) : false))).map(([, w]) => w) })).filter((f) => f.why.length);
  log(table(["Key", "Sample descriptor", "Why flagged", "Account(s)", "Count", "Total"], flagged.slice(0, 40).map(({ g, why }) => [cell(g.key, 36), cell(g.samples[0], 56), why.join("; "), cell(g.accts.join("; "), 50), g.txns.length, usd(g.total)])));
  const amb = outGroups.filter((g) => g.samples.some((s) => ambiguous.test(s)) && !flagged.some((f) => f.g === g));
  if (amb.length) {
    log();
    log(`General retailers that could be shop supplies or household (ambiguous):`);
    log(table(["Key", "Sample descriptor", "Count", "Total"], amb.slice(0, 15).map((g) => [cell(g.key, 36), cell(g.samples[0], 56), g.txns.length, usd(g.total)])));
  }
  log();

  // ---- write ---------------------------------------------------------------------------------
  const dir = join(process.cwd(), "probe-output");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "merchants.md");
  writeFileSync(file, md.join("\n") + "\n", { mode: 0o600 });

  console.log(`\nIncluded accounts: ${accounts.filter((a) => a.included).length} of ${accounts.length}`);
  console.log(`Outflows: ${outflows.length} txns, ${usd(outTotal)}, ${outGroups.length} groups. Top 20 cover ${((cum(20) / outTotal) * 100).toFixed(1)}%.`);
  console.log(`Inflows:  ${inflows.length} txns, ${usd(inTotal)}. Settlement-looking by descriptor: ${settleGroups.length} group(s). Matched to Clover card sales: ${matches.length} of ${tested} tested.`);
  console.log(`Transfers/card payments matched across accounts: ${pairs.length} pairs (${usd(pairs.reduce((a, p) => a + p.out.cents, 0))}).`);
  console.log(`Full report: ${file}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
