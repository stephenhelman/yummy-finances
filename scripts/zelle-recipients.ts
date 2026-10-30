// Usage: npm run zelle:recipients
// One row per Zelle recipient (and per sender), with each person's payment pattern, so the owner can label
// them STAFF / FAMILY / VENDOR / OTHER. READ-ONLY (Postgres READ ONLY transaction). Output:
// ./probe-output/zelle-recipients.md (gitignored; it contains real names) + a console preview.
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../src/lib/db";
import { summarizeRecipients, type RecipientRow, type ZelleItem } from "../src/lib/rules/zelle";

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const cell = (s: string, n = 70) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim().slice(0, n);

function mdTable(rows: RecipientRow[], labelColumn: string): string {
  const head = ["#", "Recipient (as in the descriptor)", "Payments", "Total", "2026 total", "Median", "First", "Last", "Typical gap (days)", "Accounts used", "Cadence hint", "Signals", labelColumn];
  const body = rows.map((r, i) => [
    i + 1, cell(r.name), r.count, usd(r.totalCents), usd(r.total2026Cents), usd(r.medianCents), r.first, r.last, r.typicalGapDays ?? "", cell(r.accounts.join("; "), 60).replace(/Bank of America ••/g, "BoA "), cell(r.cadence.hint, 90), cell(r.signals.join("; "), 60), "",
  ]);
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...body.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

async function main() {
  const host = new URL(process.env.DATABASE_URL ?? "").host;
  console.log(`DB host: ${host}  (read-only)`);

  const items: ZelleItem[] = await db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const accounts = await tx.bankAccount.findMany({ where: { included: true }, include: { plaidItem: { select: { institutionName: true } } } });
      const label = new Map(accounts.map((a) => [a.id, `${a.plaidItem.institutionName ?? "Bank"} ••${a.mask ?? "????"}`]));
      const rows = await tx.bankTransaction.findMany({
        where: { accountId: { in: accounts.map((a) => a.id) }, pending: false, removedAt: null, supersededAt: null, rawDescription: { contains: "zelle", mode: "insensitive" } },
        select: { date: true, amountCents: true, rawDescription: true, accountId: true },
      });
      return rows.map((r) => ({ raw: r.rawDescription, date: r.date.toISOString().slice(0, 10), cents: r.amountCents, account: label.get(r.accountId)! }));
    },
    { timeout: 60_000, maxWait: 30_000 },
  );

  const to = summarizeRecipients(items, "to");
  const from = summarizeRecipients(items, "from");
  const all = items.map((i) => i.date).sort();
  const total = (rs: RecipientRow[]) => rs.reduce((a, r) => a + r.totalCents, 0);

  const md = [
    `# Zelle payments by person`,
    `Generated ${new Date().toISOString()} from ${host} · ${items.length} Zelle transactions, ${all[0]} to ${all[all.length - 1]} · read-only`,
    ``,
    `For the owner: please write STAFF, FAMILY, VENDOR (and which kind of vendor) or OTHER in the last column. The "cadence hint" is only a guess from the dates and amounts.`,
    ``,
    `## Money sent: ${to.length} people, ${usd(total(to))}`,
    mdTable(to, "Label (STAFF / FAMILY / VENDOR / OTHER)"),
    ``,
    `## Money received: ${from.length} people, ${usd(total(from))}`,
    `Received payments are never revenue. They are owner contributions, vendor refunds, or stay in review.`,
    mdTable(from, "Label (FAMILY / VENDOR refund / OTHER)"),
    ``,
  ];
  const dir = join(process.cwd(), "probe-output");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "zelle-recipients.md");
  writeFileSync(file, md.join("\n"), { mode: 0o600 });

  console.log(`\nSent: ${to.length} people, ${usd(total(to))}. Received: ${from.length} people, ${usd(total(from))}.`);
  console.log("Top 10 recipients by total:");
  for (const [i, r] of to.slice(0, 10).entries()) console.log(`${String(i + 1).padStart(2)}. ${r.name.padEnd(32)} ${String(r.count).padStart(3)}x ${usd(r.totalCents).padStart(11)}  median ${usd(r.medianCents).padStart(9)}  ${r.first}..${r.last}  gap ${String(r.typicalGapDays ?? "-").padStart(3)}d  ${r.cadence.hint}${r.signals.length ? "  [" + r.signals.join("; ") + "]" : ""}`);
  console.log(`\nFull list: ${file}`);
}

main()
  .catch((e) => {
    console.error("FAILED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
