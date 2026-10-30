// Category names the rules refer to, and the category changes they require. The DB is NOT changed here:
// a dry run applies these in memory, and prisma/seed.ts applies them (rename first, then upsert) when run.

export const CAT = {
  DAIRY: "Dairy & ingredients", // was "Ingredients and dairy"
  CANDY: "Candy & toppings", // new, under COGS
  SUPPLIES: "Supplies",
  UTILITIES: "Utilities",
  WAGES: "Wages",
  RENT: "Rent",
  CARD_FEES: "Card processing fees",
  SOFTWARE: "Software and subscriptions",
  INTEREST: "Interest",
  OTHER_COGS: "Other COGS",
} as const;

export type Section = "REVENUE" | "COGS" | "OPEX" | "OTHER" | "NON_PL";

export const PLANNED_CATEGORY_CHANGES = {
  renames: [{ from: "Ingredients and dairy", to: CAT.DAIRY }],
  additions: [{ name: CAT.CANDY, section: "COGS" as Section }],
};

export type CategoryRow = { name: string; section: string };

/** The category list as it will look once the planned changes are applied (pure; the input is not mutated). */
export function applyPlannedCategoryChanges(existing: readonly CategoryRow[]): { categories: CategoryRow[]; notes: string[] } {
  const categories = existing.map((c) => ({ ...c }));
  const notes: string[] = [];
  for (const { from, to } of PLANNED_CATEGORY_CHANGES.renames) {
    const hasTo = categories.some((c) => c.name === to);
    const old = categories.find((c) => c.name === from);
    if (old && !hasTo) {
      old.name = to;
      notes.push(`rename "${from}" to "${to}"`);
    }
  }
  for (const add of PLANNED_CATEGORY_CHANGES.additions) {
    if (!categories.some((c) => c.name === add.name)) {
      categories.push({ name: add.name, section: add.section });
      notes.push(`add "${add.name}" under ${add.section}`);
    }
  }
  return { categories, notes };
}
