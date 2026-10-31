import { KIND_DIRECTIONS, directionOf, type Kind } from "@/lib/rules/types";

// The accountant's P&L template as data. The report itself is driven by the Category / CategoryGroup rows in the database
// (so the owner can add, rename, move and reorder); this file is what the seed writes on first setup and what the report
// falls back on for the few lines the app treats specially (matched by `key`, which survives renames).

export type CategoryTreatment = "PNL_EXPENSE" | "PNL_INCOME" | "NON_PL" | "PERSONAL";

export const GROUPS = { SALES_FOOD: "Sales/Food", DIRECT: "Other Direct Selling", OTHER: "Other", PERSONAL: "Personal" } as const;
export const GROUP_ORDER: readonly string[] = [GROUPS.SALES_FOOD, GROUPS.DIRECT, GROUPS.OTHER, GROUPS.PERSONAL];

export type TemplateCategory = {
  key: string;
  name: string;
  group: string | null; // null = a top-level line (Wages and Benefits, Rent) or the income category
  treatment: CategoryTreatment;
  nonPlKind?: Kind; // NON_PL only
  quickPick?: number; // default Review quick pick position
};

/** Keys the app relies on. A category with one of these keys is looked up by key, never by name. */
export const KEY = {
  OTHER_INCOME: "other-income",
  WAGES: "wages",
  RENT: "rent",
  PAYMENTS: "payments",
  DONATIONS: "donations",
  SALES_TAX: "sales-tax",
  OTHER_TRANSFERS: "other-transfers",
  PERSONAL_FOOD: "personal-food",
  PERSONAL_MISC: "personal-misc",
} as const;

export const slugKey = (name: string): string => name.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const exp = (name: string, group: string | null, extra: Partial<TemplateCategory> = {}): TemplateCategory => ({ key: slugKey(name), name, group, treatment: "PNL_EXPENSE", ...extra });

/** In the exact order of the template. Wages and Rent come first, un-grouped; then each group in order. */
export const TEMPLATE: readonly TemplateCategory[] = [
  { key: KEY.OTHER_INCOME, name: "Other Income", group: null, treatment: "PNL_INCOME" },

  exp("Wages and Benefits", null, { key: KEY.WAGES, quickPick: 2 }),
  exp("Rent", null, { key: KEY.RENT }),

  // Sales/Food
  exp("Purchase", GROUPS.SALES_FOOD, { quickPick: 3 }),
  exp("Materials & Supplies", GROUPS.SALES_FOOD, { quickPick: 4 }),
  exp("Other Interest", GROUPS.SALES_FOOD),
  exp("Other Lease", GROUPS.SALES_FOOD),
  exp("Repairs", GROUPS.SALES_FOOD, { quickPick: 5 }),
  exp("Utilities", GROUPS.SALES_FOOD),
  exp("Other Expenses: Web Domain Expense", GROUPS.SALES_FOOD),
  exp("Other Expenses: Auto Expense", GROUPS.SALES_FOOD),
  exp("Bank Charges", GROUPS.SALES_FOOD),
  exp("Dues & Subscriptions", GROUPS.SALES_FOOD),
  exp("Telephone: Entertainment TV", GROUPS.SALES_FOOD),
  exp("Telephone: Business Land Line", GROUPS.SALES_FOOD),
  exp("Uniforms", GROUPS.SALES_FOOD),

  // Other Direct Selling
  exp("Other Costs", GROUPS.DIRECT),
  exp("Gross Receipts or Sales: URASSOCIATION", GROUPS.DIRECT),
  exp("Legal & Professional", GROUPS.DIRECT),
  exp("Office Expense: DROPBOXSERVICES", GROUPS.DIRECT),
  exp("Office Expense: ZOOM", GROUPS.DIRECT),
  exp("Office Expense: Software and apps", GROUPS.DIRECT),
  exp("Travel", GROUPS.DIRECT),
  exp("Travel: Lodging", GROUPS.DIRECT),
  exp("Travel: Car Rental", GROUPS.DIRECT),
  exp("Other Expenses: STORAGE", GROUPS.DIRECT),
  exp("Other Expenses: MEMBERSHIP & TICKETS", GROUPS.DIRECT),
  exp("Other Expenses: BUSINESS PROMOTION - Team Events", GROUPS.DIRECT),
  exp("Printing", GROUPS.DIRECT),
  exp("Telephone: BUSINESS CELLPHONE", GROUPS.DIRECT),
  exp("Telephone: AT&T Internet", GROUPS.DIRECT),

  // Below the P&L: Other
  { key: KEY.PAYMENTS, name: "Payments", group: GROUPS.OTHER, treatment: "NON_PL", nonPlKind: "CARD_PAYMENT" },
  { key: KEY.DONATIONS, name: "Donations", group: GROUPS.OTHER, treatment: "NON_PL", nonPlKind: "DONATION" },
  { key: KEY.SALES_TAX, name: "Sales Tax", group: GROUPS.OTHER, treatment: "NON_PL", nonPlKind: "SALES_TAX_REMITTANCE" },
  { key: KEY.OTHER_TRANSFERS, name: "Other Transfers", group: GROUPS.OTHER, treatment: "NON_PL", nonPlKind: "INTERNAL_TRANSFER" },

  // Below the P&L: Personal
  { key: KEY.PERSONAL_FOOD, name: "Personal: Food", group: GROUPS.PERSONAL, treatment: "PERSONAL" },
  { key: KEY.PERSONAL_MISC, name: "Personal: Misc", group: GROUPS.PERSONAL, treatment: "PERSONAL", quickPick: 1 },
];

/** Shown on the report from what is still in the review queue. NOT categories: they cannot be picked. */
export const COMPUTED_LINES = { ZELLE: "Zelle (unclassified)", CHECKS: "Checks (unclassified)", UNCATEGORIZED: "Uncategorized" } as const;

// ---------------------------------------------------------------------------------------------
// category -> internal kind
// ---------------------------------------------------------------------------------------------

export type CategoryForKind = { name: string; treatment: CategoryTreatment; nonPlKind: Kind | null; archived?: boolean };
export type KindResult = { ok: true; kind: Kind } | { ok: false; error: string };

/** What picking this category means for a transaction of this amount (Plaid sign). The owner never sees the kind. */
export function deriveKind(cat: CategoryForKind, amountCents: number): KindResult {
  if (cat.archived) return { ok: false, error: `"${cat.name}" is archived.` };
  const dir = directionOf(amountCents);
  let kind: Kind;
  switch (cat.treatment) {
    case "PNL_EXPENSE":
      kind = dir === "out" ? "EXPENSE" : "VENDOR_REFUND";
      break;
    case "PERSONAL":
      kind = dir === "out" ? "OWNER_DRAW" : "OWNER_CONTRIBUTION";
      break;
    case "PNL_INCOME":
      if (dir === "out") return { ok: false, error: `"${cat.name}" is income, so it only applies to money coming in.` };
      kind = "OTHER_INCOME";
      break;
    case "NON_PL":
      if (!cat.nonPlKind) return { ok: false, error: `"${cat.name}" has no kind set.` };
      kind = cat.nonPlKind;
      break;
  }
  const allowed = kind === "OTHER_INCOME" ? "in" : KIND_DIRECTIONS[kind];
  if (allowed !== "both" && allowed !== dir) return { ok: false, error: `"${cat.name}" is only for money ${allowed === "out" ? "going out" : "coming in"}.` };
  return { ok: true, kind };
}

/** When a classified transaction carries no category (pair matches, system rules), the template line it reports under. */
export const DEFAULT_LINE_BY_KIND: Partial<Record<Kind, string>> = {
  INTERNAL_TRANSFER: KEY.OTHER_TRANSFERS,
  CARD_PAYMENT: KEY.PAYMENTS,
  LOAN_PAYMENT: KEY.PAYMENTS,
  SALES_TAX_REMITTANCE: KEY.SALES_TAX,
  DONATION: KEY.DONATIONS,
  OWNER_DRAW: KEY.PERSONAL_MISC,
  OWNER_CONTRIBUTION: KEY.PERSONAL_MISC,
  OTHER_INCOME: KEY.OTHER_INCOME,
};

/** The treatment a category must have for the report to honour it as P&L: only these two touch Net Income. */
export const isPnl = (t: CategoryTreatment) => t === "PNL_EXPENSE" || t === "PNL_INCOME";
