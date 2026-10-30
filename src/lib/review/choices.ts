import { CAT } from "@/lib/rules/categories";
import { KIND_DIRECTIONS, PNL_KINDS, directionOf, type Kind } from "@/lib/rules/types";

// What a person can choose for a transaction, and how a choice is resolved against the transaction's direction.
// Pure. The form posts one string per choice ("pick:wages", "cat:<categoryId>", "kind:INTERNAL_TRANSFER").

export type QuickPick = { id: string; label: string; categoryName: string | null };

/** The one-tap buttons, in the order the owner asked for. "Personal" has no category: it is the owner's own money. */
export const QUICK_PICKS: readonly QuickPick[] = [
  { id: "personal", label: "Personal", categoryName: null },
  { id: "wages", label: "Wages", categoryName: CAT.WAGES },
  { id: "dairy", label: "Dairy & ingredients", categoryName: CAT.DAIRY },
  { id: "supplies", label: "Supplies", categoryName: CAT.SUPPLIES },
  { id: "candy", label: "Candy & toppings", categoryName: CAT.CANDY },
];

/** Kinds offered under "More…" (all outside the P&L). Personal covers owner draw / contribution. */
export const MORE_KINDS: readonly { kind: Kind; label: string }[] = [
  { kind: "INTERNAL_TRANSFER", label: "Internal transfer" },
  { kind: "CARD_PAYMENT", label: "Card payment" },
  { kind: "LOAN_PAYMENT", label: "Loan payment" },
  { kind: "SALES_TAX_REMITTANCE", label: "Sales tax" },
  { kind: "OTHER_INFLOW", label: "Other inflow" },
];

export type Choice = { kind: Kind; categoryName: string | null; label: string };
export type CategoryOption = { id: string; name: string; section: string };

/** Sections a person may assign a bank transaction to. Revenue comes from Clover only; NON_PL is covered by kinds. */
export const PICKABLE_SECTIONS: ReadonlySet<string> = new Set(["COGS", "OPEX", "OTHER"]);

export type ChoiceResult = { ok: true; choice: Choice } | { ok: false; error: string };

/** Problems with applying a kind to a direction (empty = valid). The same hard rules the rule engine enforces. */
export function validateChoice(kind: Kind, categoryName: string | null, amountCents: number): string | null {
  const dir = directionOf(amountCents);
  const pnl = PNL_KINDS.has(kind);
  if (pnl && !categoryName) return "Pick a category.";
  if (!pnl && categoryName) return "That choice has no category.";
  const allowed = KIND_DIRECTIONS[kind];
  if (allowed !== "both" && allowed !== dir) return dir === "out" ? "That choice is only for money coming in." : "That choice is only for money going out.";
  return null;
}

/**
 * Resolve a posted choice for a transaction. Direction decides what a pick means:
 *   Personal: outflow -> OWNER_DRAW, inflow -> OWNER_CONTRIBUTION
 *   a category: outflow -> EXPENSE, inflow -> VENDOR_REFUND (a refund from that kind of vendor)
 */
export function resolveChoice(value: string, amountCents: number, categories: readonly CategoryOption[]): ChoiceResult {
  const dir = directionOf(amountCents);
  const [type, rest = ""] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
  let choice: Choice | null = null;

  if (type === "pick") {
    const pick = QUICK_PICKS.find((p) => p.id === rest);
    if (!pick) return { ok: false, error: "Unknown choice." };
    if (!pick.categoryName) choice = { kind: dir === "out" ? "OWNER_DRAW" : "OWNER_CONTRIBUTION", categoryName: null, label: pick.label };
    else choice = { kind: dir === "out" ? "EXPENSE" : "VENDOR_REFUND", categoryName: pick.categoryName, label: pick.label };
  } else if (type === "cat") {
    const cat = categories.find((c) => c.id === rest);
    if (!cat || !PICKABLE_SECTIONS.has(cat.section)) return { ok: false, error: "Unknown category." };
    choice = { kind: dir === "out" ? "EXPENSE" : "VENDOR_REFUND", categoryName: cat.name, label: cat.name };
  } else if (type === "kind") {
    const k = MORE_KINDS.find((m) => m.kind === rest);
    if (!k) return { ok: false, error: "Unknown choice." };
    choice = { kind: k.kind, categoryName: null, label: k.label };
  } else {
    return { ok: false, error: "Unknown choice." };
  }

  if (dir === "in" && choice.categoryName === CAT.WAGES) return { ok: false, error: "Wages are money going out." };
  const err = validateChoice(choice.kind, choice.categoryName, amountCents);
  return err ? { ok: false, error: err } : { ok: true, choice };
}

/** Quick picks that make sense for the direction (inflows: Personal, plus categories as vendor refunds). */
export function picksFor(amountCents: number): { id: string; label: string }[] {
  const dir = directionOf(amountCents);
  return QUICK_PICKS.filter((p) => dir === "out" || p.id !== "wages").map((p) => ({
    id: p.id,
    label: dir === "in" && p.categoryName ? `Refund: ${p.label}` : p.label,
  }));
}

/** More… kinds that apply to this direction. */
export function moreKindsFor(amountCents: number): readonly { kind: Kind; label: string }[] {
  const dir = directionOf(amountCents);
  return MORE_KINDS.filter((m) => KIND_DIRECTIONS[m.kind] === "both" || KIND_DIRECTIONS[m.kind] === dir);
}
