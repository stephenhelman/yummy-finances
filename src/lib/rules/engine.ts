import { normalizeDescriptor } from "@/lib/rules/normalize";
import { matchPairs } from "@/lib/rules/pairs";
import {
  KIND_DIRECTIONS,
  directionOf,
  type AccountScope,
  type Decision,
  type MatchType,
  type RuleDef,
  type TxnInput,
} from "@/lib/rules/types";

// Rule engine. Order of authority for each transaction:
//   1. pair matcher    two sides of a transfer / card payment between the owner's own accounts
//   2. system rules    structural facts that are never income (a credit-card payment credit)
//   3. rules           by priority, then specificity, then confirmed-before-unconfirmed, then id; first match wins
//   4. defaults        an unmatched outflow -> NEEDS_REVIEW; an unmatched inflow -> OTHER_INFLOW, flagged for review
// Nothing here can produce revenue: there is no such kind, and EXPENSE/VENDOR_REFUND are direction-checked.

const SPECIFICITY: Record<MatchType, number> = { EXACT: 0, STARTS_WITH: 1, CONTAINS: 2, REGEX: 3 };

export function sortRules(rules: readonly RuleDef[]): RuleDef[] {
  return [...rules].sort(
    (a, b) =>
      a.priority - b.priority ||
      SPECIFICITY[a.matchType] - SPECIFICITY[b.matchType] ||
      Number(b.confirmed) - Number(a.confirmed) ||
      a.id.localeCompare(b.id),
  );
}

const regexCache = new Map<string, RegExp>();
function regex(src: string): RegExp {
  let r = regexCache.get(src);
  if (!r) regexCache.set(src, (r = new RegExp(src, "i")));
  return r;
}

function textMatches(type: MatchType, pattern: string, text: string): boolean {
  switch (type) {
    case "EXACT":
      return text === pattern;
    case "STARTS_WITH":
      return text.startsWith(pattern);
    case "CONTAINS":
      return text.includes(pattern);
    case "REGEX":
      return regex(pattern).test(text);
  }
}

function scopeMatches(scope: AccountScope[] | undefined, acct: TxnInput["account"]): boolean {
  if (!scope || !scope.length) return true;
  return scope.some(
    (s) =>
      (!s.institution || acct.institution.toLowerCase().includes(s.institution.toLowerCase())) &&
      (!s.mask || acct.mask === s.mask) &&
      (!s.type || acct.type === s.type),
  );
}

/** Does this rule apply to this transaction? (Pure; the same function drives the dry run and, later, the UI.) */
export function ruleMatches(rule: RuleDef, t: TxnInput, normalized: string): boolean {
  const dir = directionOf(t.amountCents);
  if (rule.direction !== "any" && rule.direction !== dir) return false;
  // a kind can never be applied to a direction it does not allow, whatever the rule says
  const allowed = KIND_DIRECTIONS[rule.kind];
  if (allowed !== "both" && allowed !== dir) return false;
  if (!scopeMatches(rule.accounts, t.account)) return false;
  const abs = Math.abs(t.amountCents);
  if (rule.amountMinCents !== undefined && abs < rule.amountMinCents) return false;
  if (rule.amountMaxCents !== undefined && abs > rule.amountMaxCents) return false;
  const text = rule.target === "raw" ? t.raw.toUpperCase() : normalized;
  return textMatches(rule.matchType, rule.pattern, text);
}

const PAYMENT_CREDIT = /^(PAYMENT THANK YOU|AUTOMATIC PAYMENT|AUTOPAY|ONLINE PAYMENT|PAYMENT RECEIVED)\b/;

export type ClassifyOptions = { pairs?: boolean; pairWindowDays?: number };

export function classify(txns: readonly TxnInput[], rules: readonly RuleDef[], opts: ClassifyOptions = {}): Decision[] {
  const sorted = sortRules(rules);
  const normalized = new Map(txns.map((t) => [t.id, normalizeDescriptor(t.raw)]));
  const pairs = opts.pairs === false ? new Map() : matchPairs([...txns], { windowDays: opts.pairWindowDays });

  return txns.map((t): Decision => {
    const direction = directionOf(t.amountCents);
    const norm = normalized.get(t.id)!;
    const base = { txnId: t.id, direction, normalized: norm, pairedWith: null, ambiguousPair: false } as const;

    // 1. pairs
    const pair = pairs.get(t.id);
    if (pair) {
      return { ...base, kind: pair.kind, categoryName: null, status: pair.ambiguous ? "AUTO_UNCONFIRMED" : "AUTO", via: "pair", ruleId: null, pairedWith: pair.pairedWith, ambiguousPair: pair.ambiguous };
    }

    // 2. system rules: money INTO a credit card that is a payment is a card payment, never income,
    //    even when the paying account is not connected
    if (direction === "in" && t.account.type === "credit" && PAYMENT_CREDIT.test(norm)) {
      return { ...base, kind: "CARD_PAYMENT", categoryName: null, status: "AUTO", via: "system", ruleId: "system:card-payment-credit" };
    }

    // 3. rules
    for (const rule of sorted) {
      if (ruleMatches(rule, t, norm)) {
        return { ...base, kind: rule.kind, categoryName: rule.categoryName ?? null, status: rule.confirmed ? "AUTO" : "AUTO_UNCONFIRMED", via: "rule", ruleId: rule.id };
      }
    }

    // 4. defaults
    return direction === "out"
      ? { ...base, kind: null, categoryName: null, status: "NEEDS_REVIEW", via: "default", ruleId: null }
      : { ...base, kind: "OTHER_INFLOW", categoryName: null, status: "NEEDS_REVIEW", via: "default", ruleId: null };
  });
}
