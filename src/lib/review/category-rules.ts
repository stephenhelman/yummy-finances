import type { CategoryTreatment } from "@/lib/report/template";
import type { Kind } from "@/lib/rules/types";

// Pure rules for editing the category list. Everything the admin screen is allowed to do is decided here, so it is testable.

/** Kinds a "Not in P&L" category can stand for (the owner never sees these: they just choose a name). */
export const NON_PL_KIND_CHOICES: readonly { kind: Kind; label: string }[] = [
  { kind: "CARD_PAYMENT", label: "Payment (card or bill)" },
  { kind: "LOAN_PAYMENT", label: "Loan payment" },
  { kind: "INTERNAL_TRANSFER", label: "Transfer between accounts" },
  { kind: "SALES_TAX_REMITTANCE", label: "Sales tax" },
  { kind: "DONATION", label: "Donation" },
];

export const TREATMENT_LABEL: Record<CategoryTreatment, string> = { PNL_EXPENSE: "Expense", PNL_INCOME: "Income", NON_PL: "Not in P&L", PERSONAL: "Personal" };

export const MAX_QUICK_PICKS = 6;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export type NewCategoryInput = { name: string; treatment: CategoryTreatment; nonPlKind: Kind | null; groupId: string | null };

/** Problems with a new category (null = fine). */
export function validateNewCategory(input: NewCategoryInput, existingNames: readonly string[]): string | null {
  const name = clean(input.name);
  if (!name) return "Give the category a name.";
  if (name.length > 80) return "That name is too long.";
  if (existingNames.some((n) => n.toLowerCase() === name.toLowerCase())) return `There is already a category called "${name}".`;
  if (/^(zelle|checks?)\b.*\(unclassified\)$/i.test(name) || /^uncategorized$/i.test(name)) return `"${name}" is a line the report works out by itself, so it can't be a category.`;
  if (input.treatment === "NON_PL" && !NON_PL_KIND_CHOICES.some((k) => k.kind === input.nonPlKind)) return "Choose what kind of money this is.";
  if (input.treatment !== "NON_PL" && input.nonPlKind) return "Only a Not-in-P&L category has a kind.";
  if (input.groupId === null && (input.treatment === "NON_PL" || input.treatment === "PERSONAL")) return "Pick a group: Not-in-P&L and Personal lines go in a group.";
  return null;
}

export const cleanName = clean;

/** A category can be archived only when nothing uses it (any month, any rule). */
export function archiveBlocker(usage: { transactions: number; rules: number }): string | null {
  if (usage.transactions) return `${usage.transactions} transaction${usage.transactions === 1 ? " uses" : "s use"} it. Merge it into another category instead.`;
  if (usage.rules) return `${usage.rules} rule${usage.rules === 1 ? " uses" : "s use"} it. Merge it into another category instead.`;
  return null;
}

type Mergeable = { id: string; name: string; treatment: CategoryTreatment; nonPlKind: string | null; archived: boolean };

/** Merging A into B moves transactions and rules, so they must mean the same thing. */
export function mergeBlocker(from: Mergeable, to: Mergeable): string | null {
  if (from.id === to.id) return "Pick a different category to merge into.";
  if (to.archived) return `"${to.name}" is archived.`;
  if (from.treatment !== to.treatment) return `"${from.name}" is ${TREATMENT_LABEL[from.treatment].toLowerCase()} and "${to.name}" is ${TREATMENT_LABEL[to.treatment].toLowerCase()}, so they can't be merged.`;
  if (from.treatment === "NON_PL" && from.nonPlKind !== to.nonPlKind) return `"${from.name}" and "${to.name}" are different kinds of money.`;
  return null;
}

/** Swap `id` with its neighbour in `orderedIds` (up = earlier). Returns the new order, or null at the edge. */
export function moved(orderedIds: readonly string[], id: string, dir: "up" | "down"): string[] | null {
  const i = orderedIds.indexOf(id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= orderedIds.length) return null;
  const next = [...orderedIds];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}
