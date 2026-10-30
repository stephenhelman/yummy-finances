// Transaction kinds, rules and decisions for the categorization engine (pure types, no I/O).
//
// HARD RULES, enforced in code (see engine.ts and validateRule):
//  - No bank inflow is ever revenue. Revenue comes from Clover only; there is no "revenue" kind here.
//  - Only EXPENSE and VENDOR_REFUND carry a P&L category. Every other kind is outside the P&L.
//  - EXPENSE applies to outflows only, VENDOR_REFUND to inflows only.

export const KINDS = [
  "EXPENSE",
  "CLOVER_SETTLEMENT",
  "CASH_DEPOSIT",
  "INTERNAL_TRANSFER",
  "CARD_PAYMENT",
  "OWNER_DRAW",
  "OWNER_CONTRIBUTION",
  "SALES_TAX_REMITTANCE",
  "LOAN_PAYMENT",
  "VENDOR_REFUND",
  "OTHER_INFLOW",
] as const;
export type Kind = (typeof KINDS)[number];

export type Direction = "in" | "out" | "any";

/** Kinds that touch P&L categories. Everything else is reconciliation or balance-sheet movement. */
export const PNL_KINDS: ReadonlySet<Kind> = new Set<Kind>(["EXPENSE", "VENDOR_REFUND"]);

/** Which transaction directions a kind may ever be applied to (a rule's direction cannot widen this). */
export const KIND_DIRECTIONS: Record<Kind, "in" | "out" | "both"> = {
  EXPENSE: "out",
  VENDOR_REFUND: "in",
  CLOVER_SETTLEMENT: "in",
  CASH_DEPOSIT: "in",
  OWNER_CONTRIBUTION: "in",
  OTHER_INFLOW: "in",
  OWNER_DRAW: "out",
  LOAN_PAYMENT: "out",
  INTERNAL_TRANSFER: "both",
  CARD_PAYMENT: "both",
  SALES_TAX_REMITTANCE: "both",
};

export type MatchType = "EXACT" | "STARTS_WITH" | "CONTAINS" | "REGEX";
export type PatternTarget = "normalized" | "raw";
export type RuleSource = "SEED" | "USER";

/** Account scope entry: all given fields must match (case-insensitive substring for institution). */
export type AccountScope = { institution?: string; mask?: string; type?: string };

export type RuleDef = {
  id: string;
  name: string;
  pattern: string; // uppercase for EXACT/STARTS_WITH/CONTAINS; a regex source (case-insensitive) for REGEX
  matchType: MatchType;
  target: PatternTarget;
  direction: Direction;
  accounts?: AccountScope[]; // optional account scope (any of)
  amountMinCents?: number; // on the absolute amount, inclusive
  amountMaxCents?: number;
  kind: Kind;
  categoryName?: string; // required for EXPENSE / VENDOR_REFUND, forbidden otherwise
  priority: number; // lower runs first
  confirmed: boolean; // seeded rules start unconfirmed
  source: RuleSource;
  // Dry-run hints: what a match pattern is expected to look like, so surprises can be flagged.
  expectMultiAccount?: boolean;
  expectBothDirections?: boolean;
  note?: string;
};

/** What the engine needs to know about one bank transaction. */
export type TxnInput = {
  id: string;
  date: string; // YYYY-MM-DD
  amountCents: number; // Plaid sign: positive = money out
  raw: string;
  pfcPrimary?: string | null;
  pfcDetailed?: string | null;
  account: { id: string; institution: string; mask: string; type: string };
};

export type DecisionStatus = "AUTO" | "AUTO_UNCONFIRMED" | "NEEDS_REVIEW";

export type Decision = {
  txnId: string;
  direction: "in" | "out";
  kind: Kind | null; // null = an outflow nobody has classified yet (NEEDS_REVIEW)
  categoryName: string | null;
  status: DecisionStatus;
  via: "pair" | "system" | "rule" | "default";
  ruleId: string | null;
  pairedWith: string | null;
  ambiguousPair: boolean;
  normalized: string;
};

export function directionOf(amountCents: number): "in" | "out" {
  return amountCents > 0 ? "out" : "in";
}

/** Problems with a rule definition (empty = valid). Enforces the P&L hard rules. */
export function validateRule(r: RuleDef): string[] {
  const errs: string[] = [];
  if (!r.pattern) errs.push("pattern is empty");
  if (r.matchType === "REGEX") {
    try {
      new RegExp(r.pattern, "i");
    } catch {
      errs.push("pattern is not a valid regular expression");
    }
  } else if (r.target === "normalized" && r.pattern !== r.pattern.toUpperCase()) {
    errs.push("pattern must be uppercase");
  }
  const pnl = PNL_KINDS.has(r.kind);
  if (pnl && !r.categoryName) errs.push(`${r.kind} needs a category`);
  if (!pnl && r.categoryName) errs.push(`${r.kind} must not have a category (only EXPENSE and VENDOR_REFUND touch the P&L)`);
  const allowed = KIND_DIRECTIONS[r.kind];
  if (allowed === "out" && r.direction === "in") errs.push(`${r.kind} only applies to outflows`);
  if (allowed === "in" && r.direction === "out") errs.push(`${r.kind} only applies to inflows`);
  if (r.amountMinCents !== undefined && r.amountMaxCents !== undefined && r.amountMinCents > r.amountMaxCents) errs.push("amount range is inverted");
  return errs;
}
