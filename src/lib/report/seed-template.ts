import type { CategorySection } from "@/generated/prisma/client";
import type { PrismaClient } from "@/generated/prisma/client";
import { GROUP_ORDER, TEMPLATE, type CategoryTreatment } from "@/lib/report/template";

// Writes the accountant's template into the Category / CategoryGroup tables. Idempotent, and it never overwrites the
// owner's later edits: a category that already has its template key is left alone (so renames, moves, reordering and
// show-when-zero choices stick). Adopts an existing category of the same NAME (Rent, Utilities) once, by giving it the key.
// Old categories that are not part of the template are NOT moved or deleted: they are archived (can't be picked) and put
// in "Unmapped (legacy)", and still show on a report whenever they hold money, until the mapping is reviewed and applied.

export const LEGACY_GROUP = "Unmapped (legacy)";
const GROUP_STEP = 10;

type Client = Pick<PrismaClient, "category" | "categoryGroup">;

/** The deprecated section column, kept consistent for old code that still reads it. */
export const sectionFor = (t: CategoryTreatment): CategorySection => (t === "PNL_EXPENSE" ? "OPEX" : t === "PNL_INCOME" ? "REVENUE" : "NON_PL");

export type SeedTemplateResult = { groups: number; created: number; adopted: number; unchanged: number; legacyArchived: number };

export async function seedTemplate(client: Client, businessId: string): Promise<SeedTemplateResult> {
  const result: SeedTemplateResult = { groups: 0, created: 0, adopted: 0, unchanged: 0, legacyArchived: 0 };

  const groupId = new Map<string, string>();
  for (const [i, name] of GROUP_ORDER.entries()) {
    const existing = await client.categoryGroup.findUnique({ where: { businessId_name: { businessId, name } } });
    if (existing) groupId.set(name, existing.id);
    else {
      groupId.set(name, (await client.categoryGroup.create({ data: { businessId, name, sortOrder: i * GROUP_STEP } })).id);
      result.groups++;
    }
  }

  const adopted = new Set<string>();
  for (const [i, t] of TEMPLATE.entries()) {
    const byKey = await client.category.findUnique({ where: { businessId_key: { businessId, key: t.key } } });
    if (byKey) {
      result.unchanged++;
      adopted.add(byKey.id);
      continue;
    }
    const fields = {
      key: t.key,
      groupId: t.group ? groupId.get(t.group)! : null,
      treatment: t.treatment,
      nonPlKind: t.nonPlKind ?? null,
      section: sectionFor(t.treatment),
      sortOrder: i,
      showWhenZero: true,
      archived: false,
      quickPickOrder: t.quickPick ?? null,
      isSystem: true,
    };
    const byName = await client.category.findUnique({ where: { businessId_name: { businessId, name: t.name } } });
    if (byName) {
      await client.category.update({ where: { id: byName.id }, data: fields });
      adopted.add(byName.id);
      result.adopted++;
    } else {
      const c = await client.category.create({ data: { businessId, name: t.name, ...fields } });
      adopted.add(c.id);
      result.created++;
    }
  }

  // Old seed categories outside the template: archive (not pickable, hidden at $0), group them, leave their data alone.
  const legacy = (await client.category.findMany({ where: { businessId, key: null, isSystem: true, archived: false } })).filter((c) => !adopted.has(c.id));
  if (legacy.length) {
    const lg = await client.categoryGroup.upsert({
      where: { businessId_name: { businessId, name: LEGACY_GROUP } },
      update: {},
      create: { businessId, name: LEGACY_GROUP, sortOrder: 900 },
    });
    for (const c of legacy) {
      await client.category.update({ where: { id: c.id }, data: { archived: true, showWhenZero: false, quickPickOrder: null, groupId: lg.id, sortOrder: 1000 + c.sortOrder } });
      result.legacyArchived++;
    }
  }
  return result;
}
