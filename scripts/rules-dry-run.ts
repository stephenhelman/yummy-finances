// Usage: npm run rules:dry-run
// DRY RUN of the categorization engine over the REAL transactions in the configured database.
// Everything is read inside a Postgres READ ONLY transaction (writes are impossible) and classified in
// memory. Output: ./probe-output/rules-dry-run.md (gitignored; it contains real descriptors) + a console summary.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { classify, ruleMatches, sortRules } from "../src/lib/rules/engine";
import { mergeTruncatedKeys, normalizeDescriptor } from "../src/lib/rules/normalize";
import { applyPlannedCategoryChanges } from "../src/lib/rules/categories";
import { cashNotesFor } from "../src/lib/rules/cash-notes";
import { quickPicksFor } from "../src/lib/rules/review";
import { OWNER_DECISION_RULE_IDS, SEED_RULES, UNCONFIRMED_ADDITION_RULE_IDS } from "../src/lib/rules/seed";
import { PNL_KINDS, validateRule, type Decision, type Kind, type TxnInput } from "../src/lib/rules/types";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const cell = (s: string | null | undefined, n = 60) => (s ?? "").replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, n);
const table = (head: string[], rows: (string | number)[][]) =>
  [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const MONTHS = Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
const OUT_KINDS: (Kind | "REVIEW")[] = ["EXPENSE", "CARD_PAYMENT", "INTERNAL_TRANSFER", "OWNER_DRAW", "SALES_TAX_REMITTANCE", "LOAN_PAYMENT", "REVIEW"];
const IN_KINDS: (Kind | "REVIEW")[] = ["CLOVER_SETTLEMENT", "CASH_DEPOSIT", "OWNER_CONTRIBUTION", "CARD_PAYMENT", "INTERNAL_TRANSFER", "VENDOR_REFUND", "SALES_TAX_REMITTANCE", "REVIEW"];

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").host;
  console.log(`DB host: ${host}  (read-only)`);

  const data = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY"); // enforced by Postgres for everything below
      const accounts = await tx.bankAccount.findMany({ where: { included: true }, include: { plaidItem: { select: { institutionName: true } } } });
      const ids = accounts.map((a) => a.id);
      const rows = await tx.bankTransaction.findMany({
        where: { accountId: { in: ids }, pending: false, removedAt: null, supersededAt: null },
        select: { id: true, date: true, amountCents: true, rawDescription: true, pfcPrimary: true, pfcDetailed: true, accountId: true },
      });
      const categories = await tx.category.findMany({ select: { name: true, section: true } });
      return { accounts, rows, categories };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const acct = new Map(data.accounts.map((a) => [a.id, { id: a.id, institution: a.plaidItem.institutionName ?? "Bank", mask: a.mask ?? "????", type: a.type ?? "" }]));
  const label = (id: string) => { const a = acct.get(id)!; return `${a.institution} ••${a.mask}`; };
  const txns: TxnInput[] = data.rows.map((r) => ({ id: r.id, date: r.date.toISOString().slice(0, 10), amountCents: r.amountCents, raw: r.rawDescription, pfcPrimary: r.pfcPrimary, pfcDetailed: r.pfcDetailed, account: acct.get(r.accountId)! }));
  const byId = new Map(txns.map((t) => [t.id, t]));

  // ---- rule sanity ---------------------------------------------------------------------------
  const problems = SEED_RULES.flatMap((r) => validateRule(r).map((e) => `${r.id}: ${e}`));
  // Rules refer to the planned category names. The DB is not changed: the planned rename/addition is applied in memory.
  const planned = applyPlannedCategoryChanges(data.categories);
  const categoryNames = new Set(planned.categories.map((c) => c.name));
  for (const r of SEED_RULES) if (r.categoryName && !categoryNames.has(r.categoryName)) problems.push(`${r.id}: category "${r.categoryName}" does not exist`);

  // ---- classify EVERYTHING (the pair matcher needs all accounts and dates), report on Jan-Oct 2026 --
  const decisions = classify(txns, SEED_RULES);
  // Comparison sets over identical data: before the owner's answers, with the owner's decisions, and with my unconfirmed addition too.
  const decisionsBefore = classify(txns, SEED_RULES.filter((r) => ![...OWNER_DECISION_RULE_IDS, ...UNCONFIRMED_ADDITION_RULE_IDS].includes(r.id)));
  const decisionsOwnerOnly = classify(txns, SEED_RULES.filter((r) => !UNCONFIRMED_ADDITION_RULE_IDS.includes(r.id)));
  const inScope = decisions.filter((d) => MONTHS.includes(byId.get(d.txnId)!.date.slice(0, 7)));
  const monthOf = (d: Decision) => byId.get(d.txnId)!.date.slice(0, 7);
  const cents = (d: Decision) => Math.abs(byId.get(d.txnId)!.amountCents);
  const kindOf = (d: Decision): Kind | "REVIEW" => (d.status === "NEEDS_REVIEW" ? "REVIEW" : d.kind!);

  // hard rules
  const hard: string[] = [];
  const inflowExpense = decisions.filter((d) => d.direction === "in" && (d.kind === "EXPENSE")).length;
  const outflowRefund = decisions.filter((d) => d.direction === "out" && d.kind === "VENDOR_REFUND").length;
  const pnlNoCategory = decisions.filter((d) => d.kind && PNL_KINDS.has(d.kind) && !d.categoryName).length;
  const nonPnlWithCategory = decisions.filter((d) => d.kind && !PNL_KINDS.has(d.kind) && d.categoryName).length;
  hard.push(`inflows classified EXPENSE: ${inflowExpense}`, `outflows classified VENDOR_REFUND: ${outflowRefund}`, `P&L kinds without a category: ${pnlNoCategory}`, `non-P&L kinds carrying a category: ${nonPnlWithCategory}`);
  const hardOk = inflowExpense + outflowRefund + pnlNoCategory + nonPnlWithCategory === 0;

  const md: string[] = [];
  const log = (s = "") => md.push(s);
  log(`# Rules dry run (read-only)`);
  log(`Generated ${new Date().toISOString()} · database ${host} · ${txns.length} posted, live transactions on ${data.accounts.length} included accounts (all dates feed the pair matcher) · reporting window Jan to Oct 2026`);
  log(`No database writes. Seed rules: ${SEED_RULES.length} (${SEED_RULES.filter((r) => r.confirmed).length} confirmed by the owner, ${SEED_RULES.filter((r) => !r.confirmed).length} unconfirmed).`);
  log();
  log(`## 0. Checks`);
  log(`- Rule definitions: ${problems.length ? "PROBLEMS: " + problems.join("; ") : "all valid (P&L kinds carry a category, others do not, directions are legal, categories exist)"}`);
  log(`- Category changes this needs when applied (NOT applied here; done by the seed script): ${planned.notes.length ? planned.notes.join("; ") : "none"}`);
  log(`- Hard rules: ${hardOk ? "PASS" : "FAIL"} (${hard.join("; ")}). No bank inflow is ever revenue: there is no revenue kind, and only EXPENSE and VENDOR_REFUND carry P&L categories.`);
  log();

  // ---- 1. per month outflows -----------------------------------------------------------------
  const out = inScope.filter((d) => d.direction === "out");
  const inn = inScope.filter((d) => d.direction === "in");
  const sum = (ds: Decision[]) => ds.reduce((a, d) => a + cents(d), 0);

  log(`## 1. Outflow dollars by kind, per month`);
  log(`Review = not classified by any rule or pair (the review queue).`);
  const outRows = MONTHS.map((m) => {
    const ds = out.filter((d) => monthOf(d) === m);
    const t = sum(ds), review = sum(ds.filter((d) => kindOf(d) === "REVIEW")), exp = sum(ds.filter((d) => kindOf(d) === "EXPENSE"));
    return [m, ...OUT_KINDS.map((k) => usd(sum(ds.filter((d) => kindOf(d) === k)))), usd(t), pct(t - review, t), pct(exp, exp + review)];
  });
  const outAll = (ds: Decision[]) => [...OUT_KINDS.map((k) => usd(sum(ds.filter((d) => kindOf(d) === k)))), usd(sum(ds)), pct(sum(ds) - sum(ds.filter((d) => kindOf(d) === "REVIEW")), sum(ds)), pct(sum(ds.filter((d) => kindOf(d) === "EXPENSE")), sum(ds.filter((d) => kindOf(d) === "EXPENSE" || kindOf(d) === "REVIEW")))];
  log(table(["Month", ...OUT_KINDS.map((k) => (k === "REVIEW" ? "REVIEW" : k)), "Total out", "% of out $ classified", "% of P&L-relevant out $ classified"], [...outRows, ["**Jan-Oct**", ...outAll(out)]]));
  log();
  log(`"P&L-relevant" = EXPENSE plus REVIEW: the dollars that could land on the P&L. Transfers, card payments, owner draws, sales tax and loan payments are outside it.`);
  log();

  // ---- 1b. before / after the owner's answers (same data, same window) ---------------------------------
  const window = (ds: Decision[]) => ds.filter((d) => MONTHS.includes(byId.get(d.txnId)!.date.slice(0, 7)) && d.direction === "out");
  const stat = (ds: Decision[]) => {
    const o = window(ds), t = sum(o), review = sum(o.filter((d) => kindOf(d) === "REVIEW")), exp = sum(o.filter((d) => kindOf(d) === "EXPENSE"));
    const confirmedAuto = sum(o.filter((d) => d.status === "AUTO"));
    return { t, review, classified: t - review, exp, confirmedAuto, unconfirmedAuto: sum(o.filter((d) => d.status === "AUTO_UNCONFIRMED")), reviewCount: o.filter((d) => kindOf(d) === "REVIEW").length };
  };
  const sb = stat(decisionsBefore), so = stat(decisionsOwnerOnly), sa = stat(decisions);
  log(`## 1b. Before and after the owner's answers (Jan-Oct 2026 outflow dollars)`);
  log(`"Before" = the rules from the previous dry run. "Owner decisions" adds the rent-check rule and S.J. Mexican. "+ my addition" also adds the unconfirmed MEXICAN SPECIA variant rule.`);
  log(table(["Scenario", "% of out $ auto-classified", "% of P&L-relevant out $ classified", "Review $", "Review items", "Auto, confirmed $", "Auto, unconfirmed $"],
    [["Before", pct(sb.classified, sb.t), pct(sb.exp, sb.exp + sb.review), usd(sb.review), sb.reviewCount, usd(sb.confirmedAuto), usd(sb.unconfirmedAuto)],
     ["After: owner decisions", pct(so.classified, so.t), pct(so.exp, so.exp + so.review), usd(so.review), so.reviewCount, usd(so.confirmedAuto), usd(so.unconfirmedAuto)],
     ["After: + my unconfirmed addition", pct(sa.classified, sa.t), pct(sa.exp, sa.exp + sa.review), usd(sa.review), sa.reviewCount, usd(sa.confirmedAuto), usd(sa.unconfirmedAuto)]]));
  log(`"Auto, confirmed" counts rule matches the owner confirmed plus pairs and system rules (all AUTO); "unconfirmed" are seed rules still awaiting confirmation.`);
  log();

  // ---- 1c. cash notes ---------------------------------------------------------------------------------------
  log(`## 1c. Cash notes triggered (Jan-Oct)`);
  const notes = cashNotesFor(out.filter((d) => d.status !== "NEEDS_REVIEW").map((d) => ({ kind: d.kind, cents: cents(d) })));
  log(notes.length ? notes.map((n) => `- **${n.text}** (${n.count} payments, ${usd(n.totalCents)})`).join("\n") : "None.");
  log();

  // ---- 1d. review quick picks (design) ---------------------------------------------------------------------
  const checkItems = out.filter((d) => kindOf(d) === "REVIEW" && d.normalized === "CHECK");
  log(`## 1d. Review: checks left for quick picks`);
  log(`${checkItems.length} checks (${usd(sum(checkItems))}) outside $4,300 to $4,500 remain. Quick picks offered on each: ${quickPicksFor("CHECK").map((p) => p.label).join(" / ")} (applied per check; no rule is offered for a payee-less "CHECK").`);
  log();

  log(`## 2. Inflow dollars by kind, per month`);
  log(`Nothing here is revenue. OTHER_INFLOW / REVIEW = nobody classified it yet.`);
  log(table(["Month", ...IN_KINDS, "Total in"], [...MONTHS.map((m) => { const ds = inn.filter((d) => monthOf(d) === m); return [m, ...IN_KINDS.map((k) => usd(sum(ds.filter((d) => kindOf(d) === k)))), usd(sum(ds))]; }), ["**Jan-Oct**", ...IN_KINDS.map((k) => usd(sum(inn.filter((d) => kindOf(d) === k)))), usd(sum(inn))]]));
  log();

  // ---- 3. review queue -----------------------------------------------------------------------
  log(`## 3. Review queue, per month`);
  log(table(["Month", "Outflows to review (count)", "Outflows to review ($)", "Unmatched inflows (count)", "Unmatched inflows ($)", "Total review items"], [
    ...MONTHS.map((m) => { const o = out.filter((d) => monthOf(d) === m && kindOf(d) === "REVIEW"), i = inn.filter((d) => monthOf(d) === m && kindOf(d) === "REVIEW"); return [m, o.length, usd(sum(o)), i.length, usd(sum(i)), o.length + i.length]; }),
    (() => { const o = out.filter((d) => kindOf(d) === "REVIEW"), i = inn.filter((d) => kindOf(d) === "REVIEW"); return ["**Jan-Oct**", o.length, usd(sum(o)), i.length, usd(sum(i)), o.length + i.length]; })(),
  ]));
  log();

  // Review grouping merges the bank's truncated variants of one vendor ("SEGOVIAS DISTR" into "SEGOVIAS DISTRIBUTING INC").
  const merged = mergeTruncatedKeys(decisions.map((d) => d.normalized));
  const group = (ds: Decision[]) => {
    const m = new Map<string, Decision[]>();
    for (const d of ds) { const k = merged.get(d.normalized) ?? d.normalized; (m.get(k) ?? m.set(k, []).get(k)!).push(d); }
    return [...m.entries()].map(([key, list]) => ({ key, list, total: sum(list), variants: new Set(list.map((d) => d.normalized)).size })).sort((a, b) => b.total - a.total);
  };
  const unmatchedOut = group(out.filter((d) => kindOf(d) === "REVIEW"));
  const reviewOutTotal = sum(out.filter((d) => kindOf(d) === "REVIEW"));
  log(`## 4. Top 15 unmatched outflow merchants (normalized), Jan-Oct`);
  log(table(["#", "Normalized key", "Truncated variants merged", "Count", "Total", "Avg", "% of review $", "Accounts", "Sample raw descriptor"],
    unmatchedOut.slice(0, 15).map((g, i) => [i + 1, cell(g.key, 44), g.variants, g.list.length, usd(g.total), usd(Math.round(g.total / g.list.length)), pct(g.total, reviewOutTotal), cell([...new Set(g.list.map((d) => label(byId.get(d.txnId)!.account.id)))].join("; "), 50), cell(byId.get(g.list[0].txnId)!.raw, 60)])));
  log(`Distinct unmatched outflow keys: ${unmatchedOut.length}. The top 15 cover ${pct(unmatchedOut.slice(0, 15).reduce((a, g) => a + g.total, 0), reviewOutTotal)} of review dollars.`);
  log();
  const unmatchedIn = group(inn.filter((d) => kindOf(d) === "REVIEW"));
  log(`### Unmatched inflows (OTHER_INFLOW, flagged for review), Jan-Oct`);
  log(table(["#", "Normalized key", "Count", "Total", "Accounts", "Sample raw descriptor"], unmatchedIn.slice(0, 12).map((g, i) => [i + 1, cell(g.key, 44), g.list.length, usd(g.total), cell([...new Set(g.list.map((d) => label(byId.get(d.txnId)!.account.id)))].join("; "), 50), cell(byId.get(g.list[0].txnId)!.raw, 60)])));
  log();

  // ---- 5. EXPENSE by category ------------------------------------------------------------------
  log(`## 5. What the P&L would see: auto-classified EXPENSE by category, Jan-Oct`);
  const cat = new Map<string, number>();
  for (const d of out.filter((d) => d.kind === "EXPENSE" && d.status !== "NEEDS_REVIEW")) cat.set(d.categoryName!, (cat.get(d.categoryName!) ?? 0) + cents(d));
  const refundCat = new Map<string, number>();
  for (const d of inn.filter((d) => d.kind === "VENDOR_REFUND")) refundCat.set(d.categoryName!, (refundCat.get(d.categoryName!) ?? 0) + cents(d));
  log(table(["Category", "Expense $", "Vendor refunds $", "Net $"], [...cat.entries()].sort((a, b) => b[1] - a[1]).map(([c, v]) => [c, usd(v), usd(refundCat.get(c) ?? 0), usd(v - (refundCat.get(c) ?? 0))])));
  log();

  // ---- 6. seed rules -------------------------------------------------------------------------
  log(`## 6. Seed rules: match counts (Jan-Oct and all time) and surprises`);
  const sorted = sortRules(SEED_RULES);
  const stats = new Map<string, { jo: Decision[]; all: Decision[] }>();
  for (const r of SEED_RULES) stats.set(r.id, { jo: [], all: [] });
  for (const d of decisions) if (d.via === "rule") { const s = stats.get(d.ruleId!)!; s.all.push(d); if (MONTHS.includes(byId.get(d.txnId)!.date.slice(0, 7))) s.jo.push(d); }

  const flags: string[] = [];
  const ruleRows = sorted.map((r) => {
    const s = stats.get(r.id)!;
    const accts = [...new Set(s.all.map((d) => label(byId.get(d.txnId)!.account.id)))];
    const dirs = [...new Set(s.all.map((d) => d.direction))];
    const f: string[] = [];
    if (!s.all.length) f.push("NO MATCHES");
    if (r.direction === "any" && dirs.length > 1) f.push(r.expectBothDirections ? "both directions (expected)" : "BOTH DIRECTIONS (unexpected)");
    if (accts.length > 1 && !(r.accounts && r.accounts.length)) f.push(r.expectMultiAccount ? "several accounts (expected)" : "SEVERAL ACCOUNTS (unexpected)");
    if (f.some((x) => x === "NO MATCHES" || /unexpected/.test(x))) flags.push(`${r.id.replace("seed:", "")}: ${f.join(", ")}`);
    return [cell(r.id.replace("seed:", ""), 32), r.kind + (r.categoryName ? ` / ${r.categoryName}` : ""), r.direction, `${r.matchType === "REGEX" ? "~" : "^"}${cell(r.pattern, 40)}`, s.jo.length, usd(sum(s.jo)), s.all.length, usd(sum(s.all)), cell(accts.join("; "), 52), dirs.join("+"), f.join("; ")];
  });
  log(table(["Rule", "Kind / category", "Dir", "Pattern", "Matches Jan-Oct", "$", "Matches all time", "$", "Accounts", "Directions", "Flags"], ruleRows));
  log();
  log(`Rules needing a look: ${flags.length ? flags.join(" | ") : "none"}`);
  log();

  // overlaps: where more than one rule would match the same transaction (the first one wins)
  const overlap = new Map<string, number>();
  for (const d of decisions) {
    if (d.via !== "rule") continue;
    const t = byId.get(d.txnId)!;
    for (const r of sorted) if (r.id !== d.ruleId && ruleMatches(r, t, d.normalized)) overlap.set(`${d.ruleId} beat ${r.id}`, (overlap.get(`${d.ruleId} beat ${r.id}`) ?? 0) + 1);
  }
  log(`### Overlaps (a transaction several rules would claim)`);
  log(overlap.size ? table(["Winner beat loser", "Transactions"], [...overlap.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, n])) : "None.");
  log();

  // ---- 7. pairs, system rules, fallbacks -------------------------------------------------------
  log(`## 7. Pair matcher, system rule and fallbacks (all time)`);
  const paired = decisions.filter((d) => d.via === "pair");
  const pairKinds = (["INTERNAL_TRANSFER", "CARD_PAYMENT"] as const).map((k) => {
    const ds = paired.filter((d) => d.kind === k && d.direction === "out");
    return [k, ds.length, usd(sum(ds)), ds.filter((d) => d.ambiguousPair).length];
  });
  log(table(["Pair kind", "Pairs", "Total", "Ambiguous (equal candidates)"], pairKinds));
  const crossItem = paired.filter((d) => d.direction === "out").filter((d) => {
    const a = byId.get(d.txnId)!.account.institution, b = byId.get(d.pairedWith!)!.account.institution;
    return a !== b;
  });
  log(`- Pairs across two bank connections (BoA to Chase): ${crossItem.length}, ${usd(sum(crossItem))}`);
  const sys = decisions.filter((d) => d.via === "system");
  log(`- Chase payment credits with NO matching outflow in a connected account (still CARD_PAYMENT, never income): ${sys.length}, ${usd(sum(sys))}`);
  const fb = (id: string) => decisions.filter((d) => d.ruleId === `seed:${id}`);
  log(`- "CHASE CREDIT CRD EPAY" debits with no matching Chase credit (fallback rule, still CARD_PAYMENT): ${fb("chase-card-payment").length}, ${usd(sum(fb("chase-card-payment")))}`);
  log(`- BoA to BoA transfers the pair matcher could not pair (fallback rule): ${fb("transfer-between-boa").length}, ${usd(sum(fb("transfer-between-boa")))}`);
  const toThirdAcct = decisions.filter((d) => d.ruleId === "seed:owner-draw-3831" || d.ruleId === "seed:owner-contribution-3831");
  log(`- Transfers to/from CHK 3831 (not connected): draws ${usd(sum(toThirdAcct.filter((d) => d.kind === "OWNER_DRAW")))} (${toThirdAcct.filter((d) => d.kind === "OWNER_DRAW").length}), contributions ${usd(sum(toThirdAcct.filter((d) => d.kind === "OWNER_CONTRIBUTION")))} (${toThirdAcct.filter((d) => d.kind === "OWNER_CONTRIBUTION").length})`);
  log();

  // ---- 8. normalizer ---------------------------------------------------------------------------
  const rawKeys = new Set(txns.map((t) => t.raw));
  const normKeys = new Map<string, number>();
  for (const d of decisions) normKeys.set(d.normalized, (normKeys.get(d.normalized) ?? 0) + 1);
  log(`## 8. Normalizer`);
  log(`${txns.length} transactions, ${rawKeys.size} distinct raw descriptors collapse to ${normKeys.size} normalized keys (${(rawKeys.size / normKeys.size).toFixed(1)} to 1).`);
  log(table(["Normalized key", "Transactions", "Distinct raw descriptors"], [...normKeys.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, n]) => [cell(k, 50), n, new Set(txns.filter((t) => normalizeDescriptor(t.raw) === k).map((t) => t.raw)).size])));
  log();

  const dir = join(process.cwd(), "probe-output");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "rules-dry-run.md");
  writeFileSync(file, md.join("\n") + "\n", { mode: 0o600 });

  // ---- console summary -------------------------------------------------------------------------
  const outT = sum(out), outReview = sum(out.filter((d) => kindOf(d) === "REVIEW"));
  const expT = sum(out.filter((d) => kindOf(d) === "EXPENSE"));
  console.log(`\nRules valid: ${problems.length ? "NO: " + problems.join("; ") : "yes"}   Hard rules: ${hardOk ? "PASS" : "FAIL"}`);
  console.log(`Jan-Oct outflows: ${out.length} txns, ${usd(outT)}. Auto-classified: ${pct(outT - outReview, outT)} of dollars. P&L-relevant classified: ${pct(expT, expT + outReview)}.`);
  console.log(`  before the owner's answers: ${pct(sb.classified, sb.t)} / ${pct(sb.exp, sb.exp + sb.review)}   owner decisions only: ${pct(so.classified, so.t)} / ${pct(so.exp, so.exp + so.review)}   confirmed-rule share of out $: ${pct(sa.confirmedAuto, sa.t)}`);
  console.log(`  cash notes: ${notes.map((n) => `${n.id} (${n.count}, ${usd(n.totalCents)})`).join("; ") || "none"}   planned category changes: ${planned.notes.join("; ") || "none"}`);
  console.log(`Review queue: ${out.filter((d) => kindOf(d) === "REVIEW").length} outflows (${usd(outReview)}) + ${inn.filter((d) => kindOf(d) === "REVIEW").length} unmatched inflows (${usd(sum(inn.filter((d) => kindOf(d) === "REVIEW")))}).`);
  console.log(`Pairs: ${paired.filter((d) => d.direction === "out").length} (${crossItem.length} across banks). Rules needing a look: ${flags.length ? flags.length : "none"}.`);
  console.log(`Normalizer: ${rawKeys.size} raw descriptors -> ${normKeys.size} keys.`);
  console.log(`Full report: ${file}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
