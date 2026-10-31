import type { PrismaClient } from "@/generated/prisma/client";
import { sectionFor } from "@/lib/report/seed-template";
import type { CategoryTreatment } from "@/lib/report/template";
import { archiveBlocker, cleanName, mergeBlocker, moved, validateNewCategory, MAX_QUICK_PICKS, type NewCategoryInput } from "@/lib/review/category-rules";
import { isFrozen } from "@/lib/rules/apply";
import { requireClassification } from "@/lib/rules/readiness";

// Editing the category list. Every change is audited. Locked snapshots are never touched, and rows in locked months are never
// moved. Callers re-apply the rules afterwards (src/app/admin/rules/category-actions.ts) when a change could alter a classification.

type Client = Pick<PrismaClient, "category" | "categoryGroup" | "rule" | "bankTransaction" | "monthSnapshot" | "auditLog">;
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const fail = (error: string) => ({ ok: false as const, error });

const audit = (c: Client, businessId: string, actor: string, action: string, entityId: string, payload: Record<string, unknown>) =>
  c.auditLog.create({ data: { businessId, actor, action, entity: "Category", entityId, payload: payload as never } });

export async function usageOf(c: Client, businessId: string, categoryId: string) {
  await requireClassification(c, businessId); // reads which transactions carry a category
  const [transactions, rules] = await Promise.all([c.bankTransaction.count({ where: { businessId, categoryId } }), c.rule.count({ where: { businessId, categoryId } })]);
  return { transactions, rules };
}

export async function addCategory(c: Client, businessId: string, actor: string, input: NewCategoryInput): Promise<Result<{ id: string }>> {
  const existing = await c.category.findMany({ where: { businessId }, select: { name: true } });
  const err = validateNewCategory(input, existing.map((e) => e.name));
  if (err) return fail(err);
  if (input.groupId && !(await c.categoryGroup.findFirst({ where: { id: input.groupId, businessId } }))) return fail("That group doesn't exist.");
  const last = await c.category.findFirst({ where: { businessId, groupId: input.groupId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const created = await c.category.create({
    data: { businessId, name: cleanName(input.name), groupId: input.groupId, treatment: input.treatment, nonPlKind: input.nonPlKind, section: sectionFor(input.treatment), sortOrder: (last?.sortOrder ?? 0) + 1, isSystem: false },
  });
  await audit(c, businessId, actor, "category.add", created.id, { name: created.name, treatment: input.treatment, groupId: input.groupId });
  return { ok: true, id: created.id };
}

export async function renameCategory(c: Client, businessId: string, actor: string, id: string, rawName: string): Promise<Result> {
  const name = cleanName(rawName);
  const cat = await c.category.findFirst({ where: { id, businessId } });
  if (!cat) return fail("That category wasn't found.");
  if (!name || name.length > 80) return fail("Give the category a name.");
  if (name === cat.name) return { ok: true };
  const clash = await c.category.findFirst({ where: { businessId, name: { equals: name, mode: "insensitive" }, NOT: { id } } });
  if (clash) return fail(`There is already a category called "${name}".`);
  await c.category.update({ where: { id }, data: { name } });
  await audit(c, businessId, actor, "category.rename", id, { from: cat.name, to: name });
  return { ok: true };
}

export async function moveToGroup(c: Client, businessId: string, actor: string, id: string, groupId: string | null): Promise<Result> {
  const cat = await c.category.findFirst({ where: { id, businessId } });
  if (!cat) return fail("That category wasn't found.");
  if (groupId && !(await c.categoryGroup.findFirst({ where: { id: groupId, businessId } }))) return fail("That group doesn't exist.");
  if (!groupId && (cat.treatment === "NON_PL" || cat.treatment === "PERSONAL")) return fail("Not-in-P&L and Personal lines go in a group.");
  if (cat.groupId === groupId) return { ok: true };
  const last = await c.category.findFirst({ where: { businessId, groupId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  await c.category.update({ where: { id }, data: { groupId, sortOrder: (last?.sortOrder ?? 0) + 1 } });
  await audit(c, businessId, actor, "category.move", id, { name: cat.name, fromGroupId: cat.groupId, toGroupId: groupId });
  return { ok: true };
}

/** Reorder within the category's group. sortOrder values are rewritten 1..n so they never collide. */
export async function reorderCategory(c: Client, businessId: string, actor: string, id: string, dir: "up" | "down"): Promise<Result> {
  const cat = await c.category.findFirst({ where: { id, businessId } });
  if (!cat) return fail("That category wasn't found.");
  const siblings = await c.category.findMany({ where: { businessId, groupId: cat.groupId, archived: false }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, sortOrder: true } });
  const next = moved(siblings.map((s) => s.id), id, dir);
  if (!next) return { ok: true };
  const slots = siblings.map((s) => s.sortOrder).sort((a, b) => a - b);
  const distinct = new Set(slots).size === slots.length ? slots : siblings.map((_, i) => i + 1);
  for (const [i, sid] of next.entries()) await c.category.update({ where: { id: sid }, data: { sortOrder: distinct[i] } });
  await audit(c, businessId, actor, "category.reorder", id, { name: cat.name, dir });
  return { ok: true };
}

export async function setShowWhenZero(c: Client, businessId: string, actor: string, id: string, value: boolean): Promise<Result> {
  const { count } = await c.category.updateMany({ where: { id, businessId }, data: { showWhenZero: value } });
  if (count !== 1) return fail("That category wasn't found.");
  await audit(c, businessId, actor, "category.showWhenZero", id, { value });
  return { ok: true };
}

/** Configurable Review quick picks: add to the end, remove, or move within the list (max 6). */
export async function setQuickPick(c: Client, businessId: string, actor: string, id: string, op: "add" | "remove" | "up" | "down"): Promise<Result> {
  const cat = await c.category.findFirst({ where: { id, businessId } });
  if (!cat) return fail("That category wasn't found.");
  const picks = await c.category.findMany({ where: { businessId, quickPickOrder: { not: null }, archived: false }, orderBy: { quickPickOrder: "asc" }, select: { id: true } });
  let ids = picks.map((p) => p.id);
  if (op === "add") {
    if (cat.archived) return fail("Archived categories can't be quick picks.");
    if (ids.includes(id)) return { ok: true };
    if (ids.length >= MAX_QUICK_PICKS) return fail(`Up to ${MAX_QUICK_PICKS} quick picks. Remove one first.`);
    ids = [...ids, id];
  } else if (op === "remove") ids = ids.filter((x) => x !== id);
  else {
    const next = moved(ids, id, op);
    if (!next) return { ok: true };
    ids = next;
  }
  await c.category.updateMany({ where: { businessId, id: { notIn: ids }, quickPickOrder: { not: null } }, data: { quickPickOrder: null } });
  for (const [i, pid] of ids.entries()) await c.category.update({ where: { id: pid }, data: { quickPickOrder: i + 1 } });
  await audit(c, businessId, actor, "category.quickPick", id, { op, picks: ids });
  return { ok: true };
}

export async function archiveCategory(c: Client, businessId: string, actor: string, id: string): Promise<Result> {
  const cat = await c.category.findFirst({ where: { id, businessId } });
  if (!cat) return fail("That category wasn't found.");
  if (cat.key) return fail(`"${cat.name}" is used by the report itself, so it can't be archived.`);
  const blocker = archiveBlocker(await usageOf(c, businessId, id));
  if (blocker) return fail(blocker);
  await c.category.update({ where: { id }, data: { archived: true, quickPickOrder: null } });
  await audit(c, businessId, actor, "category.archive", id, { name: cat.name });
  return { ok: true };
}

export async function restoreCategory(c: Client, businessId: string, actor: string, id: string): Promise<Result> {
  const { count } = await c.category.updateMany({ where: { id, businessId }, data: { archived: false } });
  if (count !== 1) return fail("That category wasn't found.");
  await audit(c, businessId, actor, "category.restore", id, {});
  return { ok: true };
}

// ---- merge ---------------------------------------------------------------------------------------------------------

export type MergePlan = { fromName: string; toName: string; transactionsOpen: number; transactionsLocked: number; rules: number };

async function planMerge(c: Client, businessId: string, fromId: string, toId: string): Promise<Result<{ plan: MergePlan; movable: string[] }>> {
  await requireClassification(c, businessId);
  const [from, to] = await Promise.all([c.category.findFirst({ where: { id: fromId, businessId } }), c.category.findFirst({ where: { id: toId, businessId } })]);
  if (!from || !to) return fail("That category wasn't found.");
  const blocker = mergeBlocker(from, to);
  if (blocker) return fail(blocker);
  const [rows, snaps, rules] = await Promise.all([
    c.bankTransaction.findMany({ where: { businessId, categoryId: fromId }, select: { id: true, date: true, isLate: true, adjustmentMonth: true } }),
    c.monthSnapshot.findMany({ where: { businessId, status: "LOCKED" }, select: { month: true } }),
    c.rule.count({ where: { businessId, categoryId: fromId } }),
  ]);
  const locked = new Set(snaps.map((s) => s.month));
  const open = rows.filter((r) => !isFrozen({ date: r.date.toISOString().slice(0, 10), isLate: r.isLate, adjustmentMonth: r.adjustmentMonth }, locked));
  return { ok: true, plan: { fromName: from.name, toName: to.name, transactionsOpen: open.length, transactionsLocked: rows.length - open.length, rules }, movable: open.map((r) => r.id) };
}

/** What a merge would do, for the confirmation screen. Changes nothing. */
export async function previewMerge(c: Client, businessId: string, fromId: string, toId: string): Promise<Result<{ plan: MergePlan }>> {
  const p = await planMerge(c, businessId, fromId, toId);
  return p.ok ? { ok: true, plan: p.plan } : p;
}

/**
 * Moves A's rules and its transactions in OPEN months to B, then archives A. Rows in locked months stay on A (a locked month is
 * read-only; its snapshot is what was reported), which is why A is archived rather than deleted.
 */
export async function mergeCategories(c: Client, businessId: string, actor: string, fromId: string, toId: string): Promise<Result<{ plan: MergePlan }>> {
  const p = await planMerge(c, businessId, fromId, toId);
  if (!p.ok) return p;
  for (let i = 0; i < p.movable.length; i += 500) await c.bankTransaction.updateMany({ where: { businessId, id: { in: p.movable.slice(i, i + 500) } }, data: { categoryId: toId } });
  await c.rule.updateMany({ where: { businessId, categoryId: fromId }, data: { categoryId: toId } });
  await c.category.update({ where: { id: fromId }, data: { archived: true, quickPickOrder: null } });
  await audit(c, businessId, actor, "category.merge", fromId, { ...p.plan, intoId: toId });
  return { ok: true, plan: p.plan };
}

// ---- groups ---------------------------------------------------------------------------------------------------------

export async function addGroup(c: Client, businessId: string, actor: string, rawName: string): Promise<Result> {
  const name = cleanName(rawName);
  if (!name || name.length > 60) return fail("Give the group a name.");
  if (await c.categoryGroup.findFirst({ where: { businessId, name: { equals: name, mode: "insensitive" } } })) return fail(`There is already a group called "${name}".`);
  const last = await c.categoryGroup.findFirst({ where: { businessId, sortOrder: { lt: 900 } }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
  const g = await c.categoryGroup.create({ data: { businessId, name, sortOrder: (last?.sortOrder ?? 0) + 10 } });
  await audit(c, businessId, actor, "group.add", g.id, { name });
  return { ok: true };
}

export async function renameGroup(c: Client, businessId: string, actor: string, id: string, rawName: string): Promise<Result> {
  const name = cleanName(rawName);
  const g = await c.categoryGroup.findFirst({ where: { id, businessId } });
  if (!g) return fail("That group wasn't found.");
  if (!name || name.length > 60) return fail("Give the group a name.");
  if (name === g.name) return { ok: true };
  if (await c.categoryGroup.findFirst({ where: { businessId, name: { equals: name, mode: "insensitive" }, NOT: { id } } })) return fail(`There is already a group called "${name}".`);
  await c.categoryGroup.update({ where: { id }, data: { name } });
  await audit(c, businessId, actor, "group.rename", id, { from: g.name, to: name });
  return { ok: true };
}

export async function reorderGroup(c: Client, businessId: string, actor: string, id: string, dir: "up" | "down"): Promise<Result> {
  const groups = await c.categoryGroup.findMany({ where: { businessId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true } });
  const next = moved(groups.map((g) => g.id), id, dir);
  if (!next) return { ok: true };
  for (const [i, gid] of next.entries()) await c.categoryGroup.update({ where: { id: gid }, data: { sortOrder: (i + 1) * 10 } });
  await audit(c, businessId, actor, "group.reorder", id, { dir });
  return { ok: true };
}

export type { CategoryTreatment };
