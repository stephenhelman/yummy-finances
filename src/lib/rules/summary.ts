import { PNL_KINDS, type Kind } from "@/lib/rules/types";

// One summary used by both the dry run and the stored-results check, so the two can be compared line for line.

export type SummaryRow = {
  date: string;
  amountCents: number; // Plaid sign: positive = money out
  kind: Kind | null;
  /** AUTO = confirmed rule / pair / system / person; AUTO_UNCONFIRMED = unconfirmed rule; NEEDS_REVIEW = in the review queue. */
  status: "AUTO" | "AUTO_UNCONFIRMED" | "NEEDS_REVIEW";
  categoryName: string | null;
};

export type Summary = {
  outflowCount: number;
  outflowCents: number;
  reviewOutCount: number;
  reviewOutCents: number;
  reviewInCount: number;
  reviewInCents: number;
  expenseCents: number;
  confirmedAutoCents: number;
  outByKind: Record<string, number>;
  expenseByCategory: Record<string, number>;
};

const MONTHS_2026 = Array.from({ length: 10 }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);

export function summarize(rows: readonly SummaryRow[], months: readonly string[] = MONTHS_2026): Summary {
  const s: Summary = { outflowCount: 0, outflowCents: 0, reviewOutCount: 0, reviewOutCents: 0, reviewInCount: 0, reviewInCents: 0, expenseCents: 0, confirmedAutoCents: 0, outByKind: {}, expenseByCategory: {} };
  for (const r of rows) {
    if (!months.includes(r.date.slice(0, 7))) continue;
    const abs = Math.abs(r.amountCents);
    if (r.amountCents > 0) {
      s.outflowCount++;
      s.outflowCents += abs;
      if (r.status === "NEEDS_REVIEW") {
        s.reviewOutCount++;
        s.reviewOutCents += abs;
        s.outByKind.REVIEW = (s.outByKind.REVIEW ?? 0) + abs;
      } else {
        const k = r.kind ?? "UNKNOWN";
        s.outByKind[k] = (s.outByKind[k] ?? 0) + abs;
        if (r.status === "AUTO") s.confirmedAutoCents += abs;
        if (r.kind && PNL_KINDS.has(r.kind) && r.categoryName) {
          s.expenseCents += abs;
          s.expenseByCategory[r.categoryName] = (s.expenseByCategory[r.categoryName] ?? 0) + abs;
        }
      }
    } else if (r.status === "NEEDS_REVIEW") {
      s.reviewInCount++;
      s.reviewInCents += abs;
    }
  }
  return s;
}

const usd = (c: number) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");

/** The console lines the dry run and `rules:apply` both print. */
export function summaryLines(s: Summary): string[] {
  return [
    `Jan-Oct outflows: ${s.outflowCount} txns, ${usd(s.outflowCents)}. Auto-classified: ${pct(s.outflowCents - s.reviewOutCents, s.outflowCents)} of dollars. P&L-relevant classified: ${pct(s.expenseCents, s.expenseCents + s.reviewOutCents)}.`,
    `Confirmed-rule share of out $: ${pct(s.confirmedAutoCents, s.outflowCents)}`,
    `Review queue: ${s.reviewOutCount} outflows (${usd(s.reviewOutCents)}) + ${s.reviewInCount} unmatched inflows (${usd(s.reviewInCents)}).`,
    `EXPENSE by category: ${Object.entries(s.expenseByCategory).sort((a, b) => b[1] - a[1]).map(([c, v]) => `${c} ${usd(v)}`).join("; ")}`,
  ];
}
