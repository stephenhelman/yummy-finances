import { CAT } from "@/lib/rules/categories";
import type { Direction, Kind, RuleDef } from "@/lib/rules/types";

// Seed rules, derived from the owner's real transactions. They classify automatically. The owner has
// CONFIRMED some (marked below); the rest stay unconfirmed and show as "auto, unconfirmed" until a
// person confirms them. Anything not covered (most checks, Zelle, branch/ATM withdrawals, restaurants
// and fast food) stays in the review queue.

const base = { target: "normalized" as const, matchType: "STARTS_WITH" as const, confirmed: false, source: "SEED" as const };

type Opt = Partial<Pick<RuleDef, "accounts" | "expectMultiAccount" | "expectBothDirections" | "note" | "matchType" | "priority" | "confirmed" | "amountMinCents" | "amountMaxCents" | "target">>;

const rule = (id: string, name: string, pattern: string, direction: Direction, kind: Kind, categoryName: string | undefined, opt: Opt = {}): RuleDef => ({
  ...base,
  id: `seed:${id}`,
  name,
  pattern,
  direction,
  kind,
  categoryName,
  priority: 100,
  ...opt,
});

/** A vendor you buy from: purchases are EXPENSE in the category; refunds from the same vendor are VENDOR_REFUND in it. */
function vendor(id: string, name: string, pattern: string, category: string, opt: Opt = {}): RuleDef[] {
  return [
    rule(`${id}:purchase`, `${name} (purchases)`, pattern, "out", "EXPENSE", category, { expectMultiAccount: true, ...opt }),
    rule(`${id}:refund`, `${name} (refunds)`, pattern, "in", "VENDOR_REFUND", category, { expectMultiAccount: true, ...opt }),
  ];
}

const CHASE: Opt = { accounts: [{ institution: "Chase" }] };
const OWNER_CONFIRMED: Opt = { confirmed: true };

/** Rules added after the first dry run. The report compares classification with and without them. */
export const OWNER_DECISION_RULE_IDS = ["seed:checks-rent", "seed:sj-mexican:purchase", "seed:sj-mexican:refund"];
export const UNCONFIRMED_ADDITION_RULE_IDS = ["seed:mexican-specialty:purchase", "seed:mexican-specialty:refund"];

export const SEED_RULES: RuleDef[] = [
  // --- card settlements and cash
  rule("clover-settlement", "Clover/Fiserv card settlement deposits", "BANKCARD MTOT DEP", "in", "CLOVER_SETTLEMENT", undefined, { note: "daily Mon-Fri deposits from the card processor" }),
  rule("cash-atm-deposit", "ATM cash deposits", "BKOFAMERICA ATM DEPOSIT", "in", "CASH_DEPOSIT", undefined),
  rule("cash-counter-credit", "Branch counter credits", "COUNTER CREDIT", "in", "CASH_DEPOSIT", undefined),

  // --- owner money moving to/from the unconnected account CHK 3831 (CONFIRMED by the owner)
  rule("owner-draw-3831", "Transfer to CHK 3831 (owner draw)", "ONLINE BANKING TRANSFER TO CHK 3831", "out", "OWNER_DRAW", undefined, { ...OWNER_CONFIRMED, expectMultiAccount: true, note: "CHK 3831 is not a connected account; both BoA accounts send to it" }),
  rule("owner-contribution-3831", "Transfer from CHK 3831 (owner contribution)", "ONLINE BANKING TRANSFER FROM CHK 3831", "in", "OWNER_CONTRIBUTION", undefined, { ...OWNER_CONFIRMED, expectMultiAccount: true }),

  // --- rent: the owner says checks of $4,300-$4,500 are rent; every other check is payroll or a vendor and is picked in review
  rule("checks-rent", "Checks of $4,300 to $4,500 (rent)", "CHECK", "out", "EXPENSE", CAT.RENT, { ...OWNER_CONFIRMED, matchType: "EXACT", amountMinCents: 430000, amountMaxCents: 450000, priority: 90, note: "checks carry no payee, so the amount is the only signal" }),

  // --- payroll, sales tax, processor and software fees, interest
  rule("payroll-homebase", "Payroll via Homebase", "PAYROLL HOMEBASE", "out", "EXPENSE", CAT.WAGES),
  rule("davo-sales-tax", "DAVO TECHNOLOGIE (sales tax)", "DAVO TECHNOLOGIE", "any", "SALES_TAX_REMITTANCE", undefined, { ...OWNER_CONFIRMED, expectBothDirections: true, note: "debits and the occasional credit; sales tax remittance (confirmed)" }),
  rule("clover-fees", "Clover monthly fees", "CLOVER FEES", "out", "EXPENSE", CAT.CARD_FEES),
  rule("chase-interest", "Chase card interest", "INTEREST CHARGE", "out", "EXPENSE", CAT.INTEREST, CHASE),

  // --- utilities
  ...vendor("el-paso-electric", "El Paso Electric", "EL PASO ELECTRIC", CAT.UTILITIES),
  ...vendor("el-paso-water", "El Paso Water", "EL PASO WATER", CAT.UTILITIES),

  // --- COGS
  ...vendor("creamland", "Creamland", "CREAMLAND", CAT.DAIRY, OWNER_CONFIRMED),
  ...vendor("economy-cash-carry", "Economy Cash and Carry", "ECONOMY CASH AND CARRY", CAT.DAIRY),
  ...vendor("restaurant-depot", "Restaurant Depot", "RESTAURANT DEPOT", CAT.DAIRY),
  ...vendor("cortez-wholesale", "Cortez Wholesale", "CORTEZ WHOLESALE", CAT.DAIRY),
  // S.J. Mexican: both "SQ *S. J. MEXICAN" and "... SPECIAL" (the key starts with "S J MEXICAN"). CONFIRMED.
  ...vendor("sj-mexican", "S.J. Mexican", "S J MEXICAN", CAT.CANDY, { ...OWNER_CONFIRMED, note: "candy and toppings supplier" }),

  // --- supplies
  ...vendor("webstaurant", "Webstaurant Store", "WEBSTAURANT STORE", CAT.SUPPLIES),
  ...vendor("sams-club", "Sam's Club", "SAMS CLUB", CAT.SUPPLIES, OWNER_CONFIRMED),
  ...vendor("walmart", "Walmart", "WALMART", CAT.SUPPLIES, OWNER_CONFIRMED),
  ...vendor("home-depot", "Home Depot", "HOME DEPOT", CAT.SUPPLIES, OWNER_CONFIRMED),
  ...vendor("target", "Target", "TARGET", CAT.SUPPLIES), // stays unconfirmed

  // --- loans (non-P&L). The matching cash note is in cash-notes.ts. CONFIRMED.
  rule("firstlight-fcu", "FirstLight FCU loan payment", "FIRSTLIGHT FCU", "out", "LOAN_PAYMENT", undefined, OWNER_CONFIRMED),

  // ===== Additions beyond what the owner listed. Each is clearly supported by the data; all unconfirmed. =====
  rule("bankcard-discount", "Card processor discount fee (MTOT DISC)", "BANKCARD MTOT DISC", "out", "EXPENSE", CAT.CARD_FEES, { note: "monthly processing-fee debit from the same processor as the settlement deposits" }),
  rule("clover-app", "Clover app subscription", "CLOVER APP", "out", "EXPENSE", CAT.SOFTWARE),
  rule("chase-card-payment", "Payment to the Chase card (fallback when no matching credit is found)", "CHASE CREDIT CRD EPAY", "out", "CARD_PAYMENT", undefined, { note: "normally handled by the pair matcher" }),
  rule("transfer-between-boa", "Transfer between the two BoA accounts (fallback when unpaired)", "ONLINE BANKING TRANSFER (TO|FROM) CHK (2879|9334)$", "any", "INTERNAL_TRANSFER", undefined, { matchType: "REGEX", expectBothDirections: true, note: "normally handled by the pair matcher" }),
  // The bank truncates the same vendor to "MEXICAN SPECIA…" (no "S.J." in front). Probably S.J. Mexican, so the same category, unconfirmed.
  ...vendor("mexican-specialty", "Mexican Specialty Products (probably S.J. Mexican)", "MEXICAN SPECIA", CAT.CANDY, { note: "bank-truncated variant without the 'S.J.'; the owner confirmed only the SQ *S. J. MEXICAN names" }),
];
