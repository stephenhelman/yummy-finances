import { normalizeDescriptor } from "@/lib/rules/normalize";
import type { Kind, TxnInput } from "@/lib/rules/types";

// Pair matcher: finds the two sides of a movement of money between the owner's OWN connected
// accounts (checking -> checking, checking -> credit card) so neither side is counted as income or
// as an expense. It looks across all accounts, including accounts on different bank connections.
//
// A pair is: an outflow on account A and an inflow on a different account B, the same amount to the
// cent, at most `windowDays` apart, where both sides look like transfers. Matching is one-to-one.

export type PairResult = { kind: Extract<Kind, "INTERNAL_TRANSFER" | "CARD_PAYMENT">; pairedWith: string; ambiguous: boolean; gapDays: number };

const TRANSFER_LIKE = /^(ONLINE BANKING TRANSFER|ZELLE|CHASE CREDIT CRD|PAYMENT THANK YOU|WIRE|TRANSFER|BKOFAMERICA BC FR CHKG)\b/;
const NAMES_ACCOUNT = /\b(?:TO|FROM) (?:CHK|SAV) (\d{3,4})\b/;

const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);

function transferLike(t: TxnInput, normalized: string): boolean {
  return TRANSFER_LIKE.test(normalized) || /^(TRANSFER_|LOAN_PAYMENTS|LOAN_DISBURSEMENTS)/.test(t.pfcPrimary ?? "");
}

/** "ONLINE BANKING TRANSFER TO CHK 3831" names the other account; it must be the account we pair it with. */
function accountNamedOk(normalized: string, counterpartyMask: string): boolean {
  const named = NAMES_ACCOUNT.exec(normalized)?.[1];
  return !named || named === counterpartyMask;
}

export function matchPairs(txns: TxnInput[], opts: { windowDays?: number } = {}): Map<string, PairResult> {
  const windowDays = opts.windowDays ?? 5;
  const norm = new Map(txns.map((t) => [t.id, normalizeDescriptor(t.raw)]));
  const outs = txns.filter((t) => t.amountCents >= 100 && transferLike(t, norm.get(t.id)!));
  const insByAmount = new Map<number, TxnInput[]>();
  for (const t of txns) {
    if (t.amountCents <= -100 && transferLike(t, norm.get(t.id)!)) {
      const k = -t.amountCents;
      (insByAmount.get(k) ?? insByAmount.set(k, []).get(k)!).push(t);
    }
  }

  const result = new Map<string, PairResult>();
  const usedIn = new Set<string>();
  // Biggest amounts first (they are the least likely to be coincidences), then oldest.
  for (const out of [...outs].sort((a, b) => b.amountCents - a.amountCents || a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const candidates = (insByAmount.get(out.amountCents) ?? []).filter((inn) => {
      if (usedIn.has(inn.id) || inn.account.id === out.account.id) return false;
      if (Math.abs(dayNum(inn.date) - dayNum(out.date)) > windowDays) return false;
      // a card payment must land on the credit account; a credit-account OUTflow (purchase, cash advance) is not a payment
      if (out.account.type === "credit") return false;
      if (!accountNamedOk(norm.get(out.id)!, inn.account.mask)) return false;
      if (!accountNamedOk(norm.get(inn.id)!, out.account.mask)) return false;
      return true;
    });
    if (!candidates.length) continue;

    const score = (inn: TxnInput) => ({
      explicit: NAMES_ACCOUNT.test(norm.get(out.id)!) || NAMES_ACCOUNT.test(norm.get(inn.id)!) ? 1 : 0, // the descriptor names the account
      gap: Math.abs(dayNum(inn.date) - dayNum(out.date)),
    });
    candidates.sort((a, b) => score(b).explicit - score(a).explicit || score(a).gap - score(b).gap || a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
    const best = candidates[0];
    const s = score(best);
    const ambiguous = candidates.filter((c) => score(c).explicit === s.explicit && score(c).gap === s.gap).length > 1;
    usedIn.add(best.id);
    const kind = best.account.type === "credit" ? "CARD_PAYMENT" : "INTERNAL_TRANSFER";
    result.set(out.id, { kind, pairedWith: best.id, ambiguous, gapDays: s.gap });
    result.set(best.id, { kind, pairedWith: out.id, ambiguous, gapDays: s.gap });
  }
  return result;
}
