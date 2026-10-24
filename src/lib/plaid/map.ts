import { dollarsToCents } from "@/lib/money";

// Pure mapping/decision logic for Plaid transaction sync (no I/O).

/** The slice of Plaid's Transaction we use (the SDK type satisfies this structurally). */
export type PlaidTxnInput = {
  transaction_id: string;
  account_id: string;
  pending: boolean;
  pending_transaction_id?: string | null;
  date: string; // YYYY-MM-DD
  authorized_date?: string | null;
  amount: number; // Plaid sign: positive = money OUT
  name?: string | null;
  original_description?: string | null;
  merchant_name?: string | null;
  payment_channel?: string | null;
  personal_finance_category?: {
    primary: string;
    detailed: string;
    confidence_level?: string | null;
    version?: string | null;
  } | null;
};

export type TxnRow = {
  plaidTransactionId: string;
  accountPlaidId: string;
  pendingTransactionId: string | null;
  pending: boolean;
  date: string;
  authorizedDate: string | null;
  amountCents: number; // Plaid's sign is kept: + = money out
  rawDescription: string;
  merchantName: string | null;
  paymentChannel: string | null;
  pfcPrimary: string | null;
  pfcDetailed: string | null;
  pfcConfidence: string | null;
  pfcVersion: string | null;
};

export function mapPlaidTransaction(t: PlaidTxnInput): TxnRow {
  const pfc = t.personal_finance_category ?? null;
  return {
    plaidTransactionId: t.transaction_id,
    accountPlaidId: t.account_id,
    pendingTransactionId: t.pending_transaction_id ?? null,
    pending: t.pending,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    amountCents: dollarsToCents(t.amount),
    // The bank's own description (original_description) is what rules will match on; name is the fallback.
    rawDescription: t.original_description ?? t.name ?? "",
    merchantName: t.merchant_name ?? null,
    paymentChannel: t.payment_channel ?? null,
    pfcPrimary: pfc?.primary ?? null,
    pfcDetailed: pfc?.detailed ?? null,
    pfcConfidence: pfc?.confidence_level ?? null,
    pfcVersion: pfc?.version ?? null,
  };
}

/** A stored row, as the planner sees it. */
export type ExistingTxn = TxnRow & {
  removedAt: Date | null;
  supersededAt: Date | null;
  isLate: boolean;
  adjustmentMonth: string | null;
  adjustmentBaseCents: number | null;
};

/** Pending, removed and superseded rows are never used by reports. */
export function isReportable(r: { pending: boolean; removedAt: Date | null; supersededAt: Date | null }): boolean {
  return !r.pending && !r.removedAt && !r.supersededAt;
}

const COMPARED: (keyof TxnRow)[] = [
  "pendingTransactionId", "pending", "date", "authorizedDate", "amountCents", "rawDescription",
  "merchantName", "paymentChannel", "pfcPrimary", "pfcDetailed", "pfcConfidence", "pfcVersion",
];

export function txnChanged(existing: TxnRow, next: TxnRow): boolean {
  return COMPARED.some((k) => existing[k] !== next[k]);
}

export type LateFields = { isLate: true; adjustmentMonth: string; adjustmentBaseCents: number };
export type LateDecision = { late: LateFields } | { audit: string } | null;

const monthOf = (d: string) => d.slice(0, 7);

/**
 * Q5 rule for a posted row whose month is already LOCKED. The locked snapshot can't change, so the
 * difference rolls into the open month's "Prior-month adjustments" line:
 *   contribution = (removed ? 0 : amountCents) - adjustmentBaseCents
 * where the base is what the locked snapshot already counted (the original amount for a row that
 * existed at lock time, 0 for a row that arrived afterwards). Returns null when nothing changes
 * the reportable total (e.g. a description-only edit). Pending rows are never involved.
 */
export function lateAdjustment(args: {
  existing: ExistingTxn | null;
  next: { pending: boolean; date: string; amountCents: number } | "removed";
  lockedMonths: ReadonlySet<string>;
  openMonth: string;
}): LateDecision {
  const { existing, next, lockedMonths, openMonth } = args;

  const wasCounted = !!existing && !existing.pending && !existing.removedAt;
  const nowCounts = next !== "removed" && !next.pending;
  const oldMonth = wasCounted ? monthOf(existing.date) : null;
  const newMonth = nowCounts ? monthOf(next.date) : null;
  if (!(oldMonth && lockedMonths.has(oldMonth)) && !(newMonth && lockedMonths.has(newMonth))) return null;

  const id = existing?.plaidTransactionId ?? (next === "removed" ? "?" : "new");
  if (oldMonth && newMonth && oldMonth !== newMonth) {
    return { audit: `Transaction ${id} moved from ${oldMonth} to ${newMonth}; at least one is locked. Review manually.` };
  }
  if (existing?.isLate && existing.adjustmentMonth !== openMonth) {
    return { audit: `Transaction ${id} was already adjusted into ${existing.adjustmentMonth ?? "?"} and changed again. Review manually.` };
  }

  const base = existing?.isLate ? (existing.adjustmentBaseCents ?? 0) : wasCounted && oldMonth && lockedMonths.has(oldMonth) ? existing.amountCents : 0;
  const newCount = next === "removed" || next.pending ? 0 : next.amountCents;
  if (!existing?.isLate && newCount - base === 0) return null;
  return { late: { isLate: true, adjustmentMonth: openMonth, adjustmentBaseCents: base } };
}
