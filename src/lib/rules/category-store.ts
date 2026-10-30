import type { PrismaClient } from "@/generated/prisma/client";
import { PLANNED_CATEGORY_CHANGES } from "@/lib/rules/categories";

// Applies the planned category changes (see categories.ts) to a database. Idempotent. Only touches the
// categories named there: a rename (never when the new name already exists) and an addition (never a duplicate).

export type CategoryChangeResult = { renamed: number; added: number };

export async function applyCategoryChanges(client: Pick<PrismaClient, "category">, businessId: string): Promise<CategoryChangeResult> {
  const result: CategoryChangeResult = { renamed: 0, added: 0 };

  for (const { from, to } of PLANNED_CATEGORY_CHANGES.renames) {
    const [old, renamed] = await Promise.all([
      client.category.findUnique({ where: { businessId_name: { businessId, name: from } } }),
      client.category.findUnique({ where: { businessId_name: { businessId, name: to } } }),
    ]);
    if (old && !renamed) {
      await client.category.update({ where: { id: old.id }, data: { name: to } });
      result.renamed++;
    }
  }

  for (const add of PLANNED_CATEGORY_CHANGES.additions) {
    const exists = await client.category.findUnique({ where: { businessId_name: { businessId, name: add.name } } });
    if (exists) continue;
    // appended to the end of its section; existing categories keep their order
    const last = await client.category.findFirst({ where: { businessId, section: add.section }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
    await client.category.create({ data: { businessId, name: add.name, section: add.section, sortOrder: (last?.sortOrder ?? 0) + 1, isSystem: true } });
    result.added++;
  }
  return result;
}
