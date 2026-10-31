// Usage: npm run propose:mapping -- --target dev|prod
// READ-ONLY (Postgres READ ONLY transaction). Shows what the category mapping release would do, from the data as it is:
// per source category MANUAL picks and rule-based rows SEPARATELY (count + 2026 $), the rules that move, what lands on each
// template line, and everything that doesn't map cleanly. Writes ./probe-output/category-mapping-proposal.md (gitignored: it
// contains merchant patterns) and prints the tables.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { checkGuard } from "../src/lib/predeploy-guard";
import { CATEGORY_MAP, KIND_DEFAULT, manualTarget, ruleTarget, type Target } from "../src/lib/report/mapping";
import { KINDS, type Kind } from "../src/lib/rules/types";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const KIND_SET = new Set<string>(KINDS);
const cell = (s: string, n = 60) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, n);
/** `num` = indexes of right-aligned (numeric) columns. */
const table = (head: string[], rows: (string | number)[][], num: number[] = []) => [`| ${head.join(" | ")} |`, `|${head.map((_, i) => (num.includes(i) ? "---:" : "---")).join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

type Agg = { n: number; c: number; n26: number; c26: number };
const zero = (): Agg => ({ n: 0, c: 0, n26: 0, c26: 0 });
const add = (a: Agg, cents: number, in26: boolean) => { a.n++; a.c += cents; if (in26) { a.n26++; a.c26 += cents; } };
const agg = (a: Agg) => (a.n ? `${a.n26} · ${usd(a.c26)}` : "-");

async function main() {
  const i = process.argv.indexOf("--target");
  const g = checkGuard({ target: i >= 0 ? process.argv[i + 1] : undefined, directUrl: process.env.DIRECT_URL, databaseUrl: process.env.DATABASE_URL, allow: { prod: process.env.YUMMY_PROD_ENDPOINT, dev: process.env.YUMMY_DEV_ENDPOINT } });
  if (!g.ok) throw new Error(`REFUSED: ${g.reason}`);
  console.log(`Target ${g.target}, endpoint ${g.endpoint} (read-only)`);

  const data = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const [cats, rules, rows, snaps] = await Promise.all([
        tx.category.findMany({ include: { group: true } }),
        tx.rule.findMany(),
        tx.bankTransaction.findMany({
          where: { pending: false, removedAt: null, supersededAt: null, account: { included: true } },
          select: { id: true, date: true, amountCents: true, kind: true, categoryId: true, categorySource: true, ruleId: true, reviewStatus: true, rawDescription: true, normalizedMerchant: true },
        }),
        tx.monthSnapshot.count({ where: { status: "LOCKED" } }),
      ]);
      return { cats, rules, rows, locked: snaps };
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  const catById = new Map(data.cats.map((c) => [c.id, c]));
  const legacyNames = new Set(data.cats.filter((c) => !c.key && c.archived).map((c) => c.name));
  const isLegacy = (n: string) => legacyNames.has(n);
  const ruleById = new Map(data.rules.map((r) => [r.id, r]));
  const nameOf = (id: string | null) => (id ? catById.get(id)?.name ?? null : null);
  const in26 = (d: Date) => d.getUTCFullYear() === 2026;
  const kindOf = (k: string | null): Kind | null => (k && KIND_SET.has(k) ? (k as Kind) : null);

  const ruleDest = (r: (typeof data.rules)[number]): Target | null => ruleTarget({ key: r.key, kind: kindOf(r.kind) ?? "EXPENSE", categoryName: nameOf(r.categoryId) }, isLegacy);

  // ---- A. per source category: MANUAL vs rule-based, separately
  type Src = { manual: Agg; rule: Agg; other: Agg };
  const bySrc = new Map<string, Src>();
  const srcKey = (cid: string | null, kind: Kind | null) => (cid ? nameOf(cid)! : `(no category) · ${kind ?? "unclassified"}`);
  // ---- C. what lands on each template line after the mapping, by source
  const landing = new Map<string, { manual: Agg; rule: Agg; stay: Agg }>();
  const land = (name: string, which: "manual" | "rule" | "stay", cents: number, d: Date) => {
    const l = landing.get(name) ?? landing.set(name, { manual: zero(), rule: zero(), stay: zero() }).get(name)!;
    add(l[which], cents, in26(d));
  };
  // ---- B. per rule
  const perRule = new Map<string, Agg>();
  // ---- D. flags computed from rows
  const manualElsewhere = new Map<string, { n: number; c: number; from: string; mapped: string; rule: string }>();
  const atm = zero();
  const reviewLeft = zero();

  for (const t of data.rows) {
    const kind = kindOf(t.kind);
    const key = srcKey(t.categoryId, kind);
    const s = bySrc.get(key) ?? bySrc.set(key, { manual: zero(), rule: zero(), other: zero() }).get(key)!;
    const bucket = t.categorySource === "MANUAL" ? s.manual : t.categorySource === "RULE" ? s.rule : s.other;
    add(bucket, t.amountCents, in26(t.date));
    if (t.reviewStatus === "NEEDS_REVIEW") add(reviewLeft, t.amountCents, in26(t.date));

    if (t.categorySource === "MANUAL") {
      const dest = manualTarget({ kind, categoryName: nameOf(t.categoryId) }, isLegacy);
      if (dest) {
        land(dest.to, "manual", t.amountCents, t.date);
        // would a merchant rule have put this row somewhere else? (informational: manual picks are NOT moved by merchant rules)
        const rule = data.rules.find((r) => r.active && kind && r.kind === kind && ruleDest(r) && ruleDest(r)!.to !== dest.to && matchesLoosely(r.pattern, t.normalizedMerchant ?? t.rawDescription));
        if (rule) {
          const k = `${nameOf(t.categoryId) ?? kind}>${rule.key}`;
          const m = manualElsewhere.get(k) ?? manualElsewhere.set(k, { n: 0, c: 0, from: nameOf(t.categoryId) ?? String(kind), mapped: dest.to, rule: `${rule.key} (${ruleDest(rule)!.to})` }).get(k)!;
          m.n++; m.c += t.amountCents;
        }
        if (!t.categoryId && kind === "OWNER_DRAW" && /\bATM\b|WITHDRAWAL|CASH APP/i.test(t.rawDescription)) add(atm, t.amountCents, in26(t.date));
      } else land(nameOf(t.categoryId) ?? `(no line) ${kind ?? ""}`, "stay", t.amountCents, t.date);
    } else if (t.ruleId && ruleById.get(t.ruleId)) {
      const r = ruleById.get(t.ruleId)!;
      add(perRule.get(r.id) ?? perRule.set(r.id, zero()).get(r.id)!, t.amountCents, in26(t.date));
      const dest = ruleDest(r);
      land(dest ? dest.to : nameOf(r.categoryId) ?? `(no line) ${kindOf(r.kind) ?? ""}`, dest ? "rule" : "stay", t.amountCents, t.date);
    } else land(nameOf(t.categoryId) ?? `(no line) ${kind ?? "unclassified"}`, "stay", t.amountCents, t.date);
  }

  const out: string[] = [];
  const p = (s = "") => out.push(s);
  p(`# Category mapping proposal`);
  p(`Generated ${new Date().toISOString()} from endpoint ${g.endpoint} · read-only · ${data.rows.length} bank transactions · ${data.rules.length} rules · ${data.locked} locked months`);
  p(`Counts and dollars are 2026 (money out is positive; money in is negative). "All time" rows are the ones the release would touch.`);
  p();
  p(`## A. By source category: your MANUAL picks vs rule-based rows`);
  p(`MANUAL picks move to the equivalent template category and stay MANUAL. Rule-based rows move because their RULE moves (they are then re-sorted by the rules).`);
  p();
  const rowsA = [...bySrc.entries()]
    .filter(([, s]) => s.manual.n || s.rule.n)
    .map(([name, s]) => {
      const cat = data.cats.find((c) => c.name === name);
      const legacy = cat ? isLegacy(name) : false;
      const to = cat ? (legacy ? CATEGORY_MAP[name] : { to: "(already a template line)" }) : null;
      const kindDefault = !cat ? KIND_DEFAULT[(name.split("· ")[1] ?? "") as Kind] : undefined;
      let dest = to?.to ?? (kindDefault === undefined ? "no change" : kindDefault === null ? "no category (reconciliation)" : kindDefault.to);
      if (!cat && (name.includes("OWNER_DRAW") || name.includes("OWNER_CONTRIBUTION"))) dest = `MANUAL → ${dest}; rule-based → by rule (see B)`;
      return [cell(name, 40), agg(s.manual), agg(s.rule), s.manual.n + s.rule.n + s.other.n, dest, to && "flag" in to && to.flag ? cell(to.flag, 90) : ""] as (string | number)[];
    })
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  p(table(["Source category", "MANUAL (n · 2026 $)", "Rule-based (n · 2026 $)", "All time rows", "→ Template line", "Note"], rowsA, [1, 2, 3]));
  p();
  p(`## B. Rules that move`);
  const rowsB = data.rules
    .map((r) => ({ r, dest: ruleDest(r), a: perRule.get(r.id) ?? zero() }))
    .filter((x) => x.dest)
    .sort((a, b) => b.a.c26 - a.a.c26)
    .map(({ r, dest, a }) => [cell(r.key, 52), r.source, nameOf(r.categoryId) ?? `(none) ${r.kind}`, agg(a), dest!.to, dest!.flag ? cell(dest!.flag, 90) : ""]);
  p(table(["Rule", "Source", "Now", "Matches (n · 2026 $)", "→ Template line", "Note"], rowsB, [3]));
  const stays = data.rules.filter((r) => !ruleDest(r));
  p();
  p(`${stays.length} other rules need no move (reconciliation rules with no category, or already on a template line).`);
  p();
  p(`## C. What lands on each template line (2026)`);
  p(`"From MANUAL picks" and "From rules" are rows this release moves there; "Already there" sit on that line today. "(no line) X" means no category is stored: the report files those under the kind's default line (card payments and loans under Payments, transfers under Other Transfers), and reconciliation rows (Clover deposits, cash deposits) are not report lines at all. Net dollars: money out minus money in.`);
  p();
  const rowsC = [...landing.entries()]
    .map(([name, l]) => ({ name, l, total: l.manual.c26 + l.rule.c26 + l.stay.c26 }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .map(({ name, l, total }) => [cell(name, 46), agg(l.manual), agg(l.rule), agg(l.stay), usd(total)]);
  p(table(["Template line / destination", "From MANUAL picks", "From rules", "Already there / unchanged", "2026 $ total"], rowsC, [1, 2, 3, 4]));
  p();
  p(`## D. Things that don't map cleanly`);
  p();
  const flags: string[][] = [];
  for (const [name, t] of Object.entries(CATEGORY_MAP)) {
    const s = bySrc.get(name);
    if (t.flag && s && (s.manual.n || s.rule.n)) flags.push([`Category: ${name}`, `${s.manual.n26} manual / ${s.rule.n26} rule rows in 2026 (${usd(s.manual.c26 + s.rule.c26)})`, `→ ${t.to}`, t.flag]);
  }
  for (const r of data.rules) {
    const d = ruleDest(r);
    if (d?.flag) flags.push([`Rule: ${r.key}`, `${(perRule.get(r.id) ?? zero()).n26} rows in 2026 (${usd((perRule.get(r.id) ?? zero()).c26)})`, `→ ${d.to}`, d.flag]);
  }
  for (const m of manualElsewhere.values()) flags.push([`Your manual picks in ${m.from}`, `${m.n} rows (${usd(m.c)}, all time)`, `→ ${m.mapped} (stay with your pick)`, `A merchant rule would say ${m.rule}. Manual picks are not moved by rules; tell me if you want these re-pointed`]);
  if (atm.n) flags.push([`Your manual "Personal" draws that look like ATM or cash withdrawals`, `${atm.n26} rows in 2026 (${usd(atm.c26)})`, `→ Personal: Misc`, `You said ATM withdrawals belong in Other Transfers. These were your own Personal picks, so they follow the pick; say the word and I'll move this subset`]);
  if (reviewLeft.n) flags.push([`Still in the review queue`, `${reviewLeft.n26} rows in 2026 (${usd(reviewLeft.c26)})`, `unchanged`, `The mapping does not touch unreviewed rows`]);
  p(table(["Item", "Size", "Proposed", "Why"], flags));
  p();
  p(`## E. Safety`);
  p(`- Idempotent: running it again finds nothing left to move.`);
  p(`- Never moves a row in a locked month (${data.locked} locked months now), never changes a locked snapshot, never un-MANUALs a pick, never re-points a rule or pick that is already on a template line.`);
  p(`- Legacy categories are archived (not deleted) and keep any rows in locked months.`);

  mkdirSync("probe-output", { recursive: true });
  writeFileSync(join("probe-output", "category-mapping-proposal.md"), `${out.join("\n")}\n`);
  console.log(`\n${out.join("\n")}\n\nWrote probe-output/category-mapping-proposal.md`);
}

/** Does a rule pattern plausibly match this text? (informational only: used to spot manual picks a merchant rule disagrees with) */
function matchesLoosely(pattern: string, text: string): boolean {
  const p = pattern.toUpperCase();
  if (p.startsWith("^") || p.includes("(")) return false;
  return text.toUpperCase().startsWith(p.trim());
}

main().catch((e) => { console.error((e as Error).message); process.exitCode = 1; }).finally(() => db.$disconnect());
