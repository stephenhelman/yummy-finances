import type { Kind } from "@/lib/rules/types";

// Notes for the "Cash notes" box of the report: facts about money that is NOT on the P&L but that the
// owner's accountant needs. A note appears only when something of that kind happened in the period.

export const CASH_NOTES: Partial<Record<Kind, { id: string; text: string }>> = {
  LOAN_PAYMENT: {
    id: "loan-payments",
    text: "Loan payments — interest portion deductible; accountant needs the loan statement.",
  },
};

export type CashNote = { id: string; kind: Kind; text: string; count: number; totalCents: number };

export function cashNotesFor(items: readonly { kind: Kind | null; cents: number }[]): CashNote[] {
  const out: CashNote[] = [];
  for (const [kind, note] of Object.entries(CASH_NOTES) as [Kind, { id: string; text: string }][]) {
    const matching = items.filter((i) => i.kind === kind);
    if (matching.length) out.push({ id: note.id, kind, text: note.text, count: matching.length, totalCents: matching.reduce((a, i) => a + Math.abs(i.cents), 0) });
  }
  return out;
}
