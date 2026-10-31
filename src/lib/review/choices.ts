import { deriveKind, type CategoryTreatment } from "@/lib/report/template";
import type { Kind } from "@/lib/rules/types";

// What a person can choose for a transaction. The owner only ever picks a CATEGORY; the internal kind is derived from the
// category's treatment and the direction of the money (see deriveKind). The form posts "cat:<categoryId>".

export type CategoryOption = {
  id: string;
  name: string;
  key: string | null;
  groupName: string | null;
  groupSort: number;
  treatment: CategoryTreatment;
  nonPlKind: Kind | null;
  showWhenZero: boolean;
  archived: boolean;
  quickPickOrder: number | null;
  sortOrder: number;
};

export type Choice = { kind: Kind; categoryId: string; categoryName: string; treatment: CategoryTreatment; key: string | null; label: string };
export type ChoiceResult = { ok: true; choice: Choice } | { ok: false; error: string };

/** Resolve a posted choice for a transaction. Direction decides the kind: an expense category on an inflow is a vendor refund. */
export function resolveChoice(value: string, amountCents: number, categories: readonly CategoryOption[]): ChoiceResult {
  const id = value.startsWith("cat:") ? value.slice(4) : "";
  const cat = categories.find((c) => c.id === id);
  if (!cat) return { ok: false, error: "Unknown category." };
  const k = deriveKind(cat, amountCents);
  if (!k.ok) return { ok: false, error: k.error };
  return { ok: true, choice: { kind: k.kind, categoryId: cat.id, categoryName: cat.name, treatment: cat.treatment, key: cat.key, label: cat.name } };
}

const byOrder = (a: CategoryOption, b: CategoryOption) => a.groupSort - b.groupSort || a.sortOrder - b.sortOrder;

/** The Review quick-pick buttons: categories the owner marked as quick picks, in their order. */
export function quickPicks(categories: readonly CategoryOption[], amountCents: number): { id: string; label: string }[] {
  const inflow = amountCents < 0;
  return categories
    .filter((c) => c.quickPickOrder !== null && !c.archived && deriveKind(c, amountCents).ok)
    .sort((a, b) => a.quickPickOrder! - b.quickPickOrder!)
    .map((c) => ({ id: c.id, label: inflow && c.treatment === "PNL_EXPENSE" ? `Refund: ${c.name}` : c.name }));
}

export type CategoryGroupOption = { group: string; items: CategoryOption[] };

/** "More…": every pickable category for this direction, grouped as on the report (top-level lines first). */
export function pickableGroups(categories: readonly CategoryOption[], amountCents: number, topLabel = "Expenses"): CategoryGroupOption[] {
  const groups = new Map<string, CategoryOption[]>();
  for (const c of [...categories].sort(byOrder)) {
    if (c.archived || !deriveKind(c, amountCents).ok) continue;
    const g = c.groupName ?? (c.treatment === "PNL_INCOME" ? "Income" : topLabel);
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(c);
  }
  return [...groups].map(([group, items]) => ({ group, items }));
}
