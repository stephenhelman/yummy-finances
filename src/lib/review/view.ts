import { isFrozen } from "@/lib/rules/apply";
import type { Kind } from "@/lib/rules/types";
import { ruleKeyFor } from "@/lib/review/service";

// What the review / transactions screens show for one transaction, and the pure list logic around it
// (queue order, "next card", filters, counts). No I/O.

export type TxnView = {
  id: string;
  date: string; // YYYY-MM-DD
  month: string;
  amountCents: number; // Plaid sign: positive = money out
  direction: "in" | "out";
  merchant: string; // display name
  raw: string;
  account: string; // "Bank of America ••2879"
  accountId: string;
  hint: string | null; // Plaid's category, faint
  kind: Kind | null;
  categoryId: string | null;
  categoryName: string | null;
  categorySource: "NONE" | "RULE" | "PAIR" | "MANUAL";
  reviewStatus: "NEEDS_REVIEW" | "AUTO" | "REVIEWED";
  confirmed: boolean;
  ruleName: string | null;
  locked: boolean; // its month is locked: read-only
  isCheck: boolean; // payee-less check: per-transaction only
};

const SMALL = new Set(["AT&T", "LLC", "INC", "HEB", "USA", "ATM", "ACH", "POS", "CHK", "LP", "TX", "NM", "EP"]);

/** "ZELLE PAYMENT TO MIGUEL LOPEZ" -> "Zelle Payment To Miguel Lopez". Keeps known acronyms. */
export function prettyMerchant(s: string): string {
  return s
    .trim()
    .split(/\s+/)
    .map((w) => (SMALL.has(w) || /\d/.test(w) || /^[^A-Za-z]+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ");
}

/** Plaid's "FOOD_AND_DRINK_RESTAURANT" -> "Food and drink · restaurant". */
export function prettyPfc(primary: string | null, detailed: string | null): string | null {
  if (!primary && !detailed) return null;
  const p = (primary ?? "").toLowerCase().replace(/_/g, " ");
  let d = (detailed ?? "").toLowerCase().replace(/_/g, " ");
  if (p && d.startsWith(p)) d = d.slice(p.length).trim();
  const head = p ? p.charAt(0).toUpperCase() + p.slice(1) : "";
  return d ? `${head ? `${head} · ` : ""}${d}` : head || null;
}

export function viewOf(
  t: {
    id: string; date: string; amountCents: number; raw: string; normalizedMerchant: string | null; pfcPrimary: string | null; pfcDetailed: string | null;
    account: { id: string; institution: string; mask: string }; kind: Kind | null; categoryId: string | null; categorySource: TxnView["categorySource"];
    reviewStatus: TxnView["reviewStatus"]; confirmed: boolean; isLate: boolean; adjustmentMonth: string | null;
  },
  ctx: { categoryName: (id: string) => string | undefined; ruleName: string | null; locked: ReadonlySet<string> },
): TxnView {
  const key = t.normalizedMerchant ?? t.raw;
  return {
    id: t.id,
    date: t.date,
    month: t.date.slice(0, 7),
    amountCents: t.amountCents,
    direction: t.amountCents > 0 ? "out" : "in",
    merchant: prettyMerchant(key),
    raw: t.raw,
    account: `${t.account.institution}${t.account.mask ? ` ••${t.account.mask}` : ""}`,
    accountId: t.account.id,
    hint: prettyPfc(t.pfcPrimary, t.pfcDetailed),
    kind: t.kind,
    categoryId: t.categoryId,
    categoryName: t.categoryId ? ctx.categoryName(t.categoryId) ?? null : null,
    categorySource: t.categorySource,
    reviewStatus: t.reviewStatus,
    confirmed: t.confirmed,
    ruleName: ctx.ruleName,
    locked: isFrozen(t, ctx.locked),
    isCheck: ruleKeyFor({ normalizedMerchant: t.normalizedMerchant, raw: t.raw }) === null,
  };
}

/** Newest first, ties by id, so the order is stable between requests. */
export const byNewest = (a: Pick<TxnView, "date" | "id">, b: Pick<TxnView, "date" | "id">) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date < b.date ? 1 : -1);

/** The first month the review queue covers: January of the year of `month` (earlier years are out of scope). */
export const queueSince = (month: string): string => `${month.slice(0, 4)}-01`;

/** Rows a person can still act on: waiting for review, not in a locked month, and (when `since` is given) not before it. */
export const reviewQueue = (all: readonly TxnView[], since?: string): TxnView[] =>
  all.filter((t) => t.reviewStatus === "NEEDS_REVIEW" && !t.locked && (!since || t.month >= since)).sort(byNewest);

export type MonthCount = { month: string; count: number; cents: number };

/** Items left per month, newest month first. */
export function monthCounts(queue: readonly TxnView[]): MonthCount[] {
  const m = new Map<string, MonthCount>();
  for (const t of queue) {
    const c = m.get(t.month) ?? m.set(t.month, { month: t.month, count: 0, cents: 0 }).get(t.month)!;
    c.count++;
    c.cents += Math.abs(t.amountCents);
  }
  return [...m.values()].sort((a, b) => (a.month < b.month ? 1 : -1));
}

/**
 * The card to show: the first item of the month, or the first one after `after` (a skipped card), wrapping around.
 * An `after` that is no longer in the queue (it was just classified) starts from the top.
 */
export function pickNext(monthItems: readonly TxnView[], after?: string | null): TxnView | null {
  if (!monthItems.length) return null;
  if (!after) return monthItems[0];
  const i = monthItems.findIndex((t) => t.id === after);
  return i < 0 ? monthItems[0] : monthItems[(i + 1) % monthItems.length];
}

/** The month to open Review on: the requested one if it has work, else the newest month that does, else the requested/current. */
export function reviewMonth(counts: readonly MonthCount[], requested: string | undefined, fallback: string): string {
  if (requested && /^\d{4}-\d{2}$/.test(requested)) return requested;
  return counts[0]?.month ?? fallback;
}

export type TxnFilter = { needsReview?: boolean; kind?: string; categoryId?: string; accountId?: string; unconfirmed?: boolean; q?: string };

export const isUnconfirmed = (t: TxnView) => t.reviewStatus === "AUTO" && !t.confirmed && t.categorySource === "RULE";

export function filterTxns(rows: readonly TxnView[], f: TxnFilter): TxnView[] {
  const q = f.q?.trim().toLowerCase();
  return rows
    .filter((t) => {
      if (f.needsReview && t.reviewStatus !== "NEEDS_REVIEW") return false;
      if (f.kind && t.kind !== f.kind) return false;
      if (f.categoryId && t.categoryId !== f.categoryId) return false;
      if (f.accountId && t.accountId !== f.accountId) return false;
      if (f.unconfirmed && !isUnconfirmed(t)) return false;
      if (q && !`${t.merchant} ${t.raw}`.toLowerCase().includes(q)) return false;
      return true;
    })
    .sort(byNewest);
}

/** Dashboard card numbers: this month's queue and the year's backlog (counts and absolute dollars). */
export function reviewSummary(queue: readonly TxnView[], month: string, year: string) {
  const mine = queue.filter((t) => t.month === month);
  return {
    monthCount: mine.length,
    monthCents: mine.reduce((a, t) => a + Math.abs(t.amountCents), 0),
    yearCount: queue.filter((t) => t.month.startsWith(year)).length,
  };
}

export const kindLabel = (k: Kind | null): string =>
  k === null
    ? "Unclassified"
    : ({
        EXPENSE: "Expense", CLOVER_SETTLEMENT: "Clover deposit", CASH_DEPOSIT: "Cash deposit", INTERNAL_TRANSFER: "Internal transfer", CARD_PAYMENT: "Card payment",
        OWNER_DRAW: "Personal (owner draw)", OWNER_CONTRIBUTION: "Personal (owner contribution)", SALES_TAX_REMITTANCE: "Sales tax", LOAN_PAYMENT: "Loan payment",
        VENDOR_REFUND: "Vendor refund", OTHER_INFLOW: "Other inflow", OTHER_INCOME: "Other income", DONATION: "Donation",
      } as Record<Kind, string>)[k];

/** The chip text for a row: category for P&L kinds, otherwise the kind. */
export const chipLabel = (t: Pick<TxnView, "kind" | "categoryName" | "reviewStatus">): string =>
  t.reviewStatus === "NEEDS_REVIEW" ? "Needs review" : t.categoryName ?? kindLabel(t.kind);

/** "2026-10-24" -> "Sat, Oct 24" (a civil date: no timezone shift). */
export function dayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T00:00:00Z`));
}
