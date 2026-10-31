import type { RuleDef, Kind } from "@/lib/rules/types";
import { TEMPLATE } from "@/lib/report/template";

// The one-time move of the app's original categories and rules into the accountant's template. Pure data and lookups:
// nothing here touches a database. Reviewed as a proposal (scripts/propose-category-mapping.ts) before it is applied, and
// applied by the idempotent release step (src/lib/report/mapping-store.ts).
//
// Three layers, most specific first:
//   1. RULE_MAP      a rule (by its stable key) goes to a specific template category, e.g. Wix -> Web Domain Expense
//   2. CATEGORY_MAP  a legacy category goes to its template equivalent (Supplies -> Materials & Supplies)
//   3. kind default  a rule or a person's pick with no category at all (a transfer, a card payment, "Personal")
// MANUAL picks only ever use layers 2 and 3: a person's own choice moves to the EQUIVALENT category, never to a merchant
// rule's opinion, and stays MANUAL.

export type Target = { to: string; flag?: string };

/** Template category names (the single source of truth is TEMPLATE; the test checks every name here exists there). */
const T = {
  wages: "Wages and Benefits", purchase: "Purchase", supplies: "Materials & Supplies", interest: "Other Interest", lease: "Other Lease", repairs: "Repairs",
  web: "Other Expenses: Web Domain Expense", bank: "Bank Charges", dues: "Dues & Subscriptions", tv: "Telephone: Entertainment TV", costs: "Other Costs",
  legal: "Legal & Professional", dropbox: "Office Expense: DROPBOXSERVICES", storage: "Other Expenses: STORAGE", promo: "Other Expenses: BUSINESS PROMOTION - Team Events",
  printing: "Printing", att: "Telephone: AT&T Internet", payments: "Payments", transfers: "Other Transfers", salesTax: "Sales Tax", misc: "Personal: Misc",
  income: "Other Income", utilities: "Utilities", rent: "Rent",
} as const;

/** Legacy category name -> template category. Every category the original seed ever created is listed, used or not. */
export const CATEGORY_MAP: Readonly<Record<string, Target>> = {
  // COGS
  "Dairy & ingredients": { to: T.purchase },
  "Candy & toppings": { to: T.purchase },
  "Ingredients and dairy": { to: T.purchase }, // the name before the rename
  "Cones, cups and packaging": { to: T.supplies },
  "Other COGS": { to: T.costs, flag: "No exact template line for \"Other COGS\"; Other Costs is the closest" },
  // OPEX
  Wages: { to: T.wages },
  "Payroll taxes": { to: T.wages, flag: "Payroll taxes folded into Wages and Benefits (the template has no payroll-tax line)" },
  "Payroll service fees": { to: T.dues }, // Homebase is a subscription
  Rent: { to: T.rent },
  Utilities: { to: T.utilities },
  "Internet and phone": { to: T.att },
  Supplies: { to: T.supplies },
  "Repairs and maintenance": { to: T.repairs },
  "Equipment leases": { to: T.lease },
  "Card processing fees": { to: T.bank },
  "Bank fees": { to: T.bank },
  "Software and subscriptions": { to: T.dues },
  Insurance: { to: T.dues },
  "Licenses and permits": { to: T.legal, flag: "Licenses and permits -> Legal & Professional is a guess" },
  "Accounting and professional": { to: T.legal },
  "Advertising and marketing": { to: T.promo, flag: "Advertising -> Business Promotion (Team Events) is a guess" },
  "Other operating expenses": { to: T.costs, flag: "No clear home: Other Costs is a holding place" },
  Uncategorized: { to: T.costs, flag: "Uncategorized expense: no clear home" },
  // OTHER
  Interest: { to: T.interest },
  "Income taxes paid": { to: T.transfers, flag: "Income taxes paid: the template has no line (not an expense; parked in Other Transfers)" },
  "Other income and expense": { to: T.costs, flag: "Mixed income/expense: no clear home" },
  // REVENUE / NON_PL
  "Uncategorized income": { to: T.income, flag: "Bank inflows are never revenue; only a person's pick may become Other Income" },
  "Sales tax remitted": { to: T.salesTax },
  "Tips paid out": { to: T.wages, flag: "Tips paid out: pass-through to staff; template has no line" },
  "Owner draws and contributions": { to: T.misc },
  "Loan principal": { to: T.payments },
  "Equipment purchases": { to: T.lease, flag: "Equipment purchases: capex has no template line" },
  Transfers: { to: T.transfers },
};

/** Rules whose own merchant decides, keyed by the rule's stable key. Beats CATEGORY_MAP. */
export const RULE_MAP: Readonly<Record<string, Target>> = {
  // no-category rules
  "seed:owner-draw-3831": { to: T.transfers },
  "seed:owner-contribution-3831": { to: T.transfers },
  "seed:chase-card-payment": { to: T.payments },
  "seed:firstlight-fcu": { to: T.payments },
  "seed:transfer-between-boa": { to: T.transfers },
  "seed:davo-sales-tax": { to: T.salesTax },
  // merchants the owner named
  "user:wix:purchase": { to: T.web }, "user:wix:refund": { to: T.web },
  "user:att:purchase": { to: T.att }, "user:att:refund": { to: T.att },
  "user:always:google-youtube-tv:out": { to: T.tv },
  "user:always:u-haul-moving-s-tx-recurring:out": { to: T.storage, flag: "U-Haul -> STORAGE as you asked; confirm (a moving truck may not be storage)" },
  "user:always:u-haul-moving-s:out": { to: T.storage, flag: "U-Haul -> STORAGE as you asked; confirm (a moving truck may not be storage)" },
  // sensible merchant fits the owner didn't name
  "user:always:dropbox-sign-mont-ca-recurring:out": { to: T.dropbox, flag: "Dropbox Sign -> Office Expense: DROPBOXSERVICES (the template has a Dropbox line)" },
  "user:always:hp-instant-ink:out": { to: T.printing, flag: "HP Instant Ink -> Printing (could be Materials & Supplies)" },
  "user:always:superior-fire-inc:out": { to: T.repairs, flag: "Superior Fire Inc -> Repairs (could be an inspection fee: Other Costs)" },
  "user:always:homedepot:out": { to: T.repairs },
  "user:always:azuraequippmt-pmts:out": { to: T.lease },
  // owner draws with no category
  "user:always:fid-bkg-svc-llc-moneyline:out": { to: T.misc, flag: "Fidelity brokerage transfer -> Personal: Misc (could be Other Transfers)" },
  "user:always:online-banking-transfer-to-sav-2870:out": { to: T.transfers, flag: "Transfer to savings 2870 -> Other Transfers (could be Personal: Misc)" },
  "user:always:audible-nj-recurring:out": { to: T.misc },
  "user:always:temporary-credit-adjustment-on-card:in": { to: T.misc, flag: "A card credit adjustment recorded as an owner contribution; confirm" },
  // odd ones: kept where the owner put them, but listed
  "user:always:lowes-big:out": { to: T.purchase, flag: "Lowe's was filed under Dairy & ingredients: probably a mis-pick (Materials & Supplies or Repairs?)" },
  "user:always:taco-cabana:out": { to: T.costs, flag: "Taco Cabana (restaurant) filed under Other operating expenses: no clear home (a meal)" },
  "zelle:mamita:out": { to: T.costs, flag: "Zelle to MAMITA: unknown purpose, no clear home" },
  "zelle:mamita:in": { to: T.costs, flag: "Zelle from MAMITA: unknown purpose, no clear home" },
};

/** A rule or a manual pick with NO category: where its kind reports by default. null = reconciliation, stays without a category. */
export const KIND_DEFAULT: Partial<Record<Kind, Target | null>> = {
  OWNER_DRAW: { to: T.misc },
  OWNER_CONTRIBUTION: { to: T.misc },
  CARD_PAYMENT: { to: T.payments },
  LOAN_PAYMENT: { to: T.payments },
  INTERNAL_TRANSFER: { to: T.transfers },
  SALES_TAX_REMITTANCE: { to: T.salesTax },
  CLOVER_SETTLEMENT: null,
  CASH_DEPOSIT: null,
};

/** Key of a template category, from its name (a few keys are fixed, e.g. "wages", so it is looked up, not derived). */
export function keyOf(name: string): string {
  const t = TEMPLATE.find((c) => c.name === name);
  if (!t) throw new Error(`"${name}" is not a template category`);
  return t.key;
}

/**
 * Where a stored rule should go, or null when it needs no move. `categoryName` is the rule's CURRENT category. A rule that
 * already points at a non-legacy category is never moved: that is a decision someone made after the template existed.
 */
export function ruleTarget(rule: { key: string; kind: Kind; categoryName: string | null }, isLegacy: (categoryName: string) => boolean): Target | null {
  if (rule.categoryName && !isLegacy(rule.categoryName)) return null;
  const override = RULE_MAP[rule.key];
  if (override) return override;
  if (rule.categoryName) return CATEGORY_MAP[rule.categoryName] ?? null;
  return KIND_DEFAULT[rule.kind] ?? null;
}

/** Where a person's MANUAL pick goes: the equivalent category, by category (never by merchant). null = leave as it is. */
export function manualTarget(row: { kind: Kind | null; categoryName: string | null }, isLegacy: (categoryName: string) => boolean): Target | null {
  if (row.categoryName) return isLegacy(row.categoryName) ? CATEGORY_MAP[row.categoryName] ?? null : null;
  if (row.kind === "OWNER_DRAW" || row.kind === "OWNER_CONTRIBUTION") return KIND_DEFAULT[row.kind] ?? null; // "Personal"
  return null;
}

/** Code-defined rules, remapped so persisting them writes template categories (otherwise every release would re-point them back). */
export function mapDef(def: RuleDef): RuleDef {
  const isLegacy = (n: string) => n in CATEGORY_MAP && !TEMPLATE_NAMES.has(n);
  const t = ruleTarget({ key: def.id, kind: def.kind, categoryName: def.categoryName ?? null }, isLegacy);
  return t ? { ...def, categoryName: t.to } : def;
}

/** Names that exist in both lists (Rent, Utilities): the template line is the same row, so they are never "legacy". */
export const TEMPLATE_NAMES: ReadonlySet<string> = new Set([T.rent, T.utilities]);
