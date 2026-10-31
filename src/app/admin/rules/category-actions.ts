"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { CategoryTreatment } from "@/lib/report/template";
import {
  addCategory, addGroup, archiveCategory, mergeCategories, renameCategory, renameGroup, reorderCategory, reorderGroup, restoreCategory, setQuickPick, setShowWhenZero, moveToGroup,
  type Result,
} from "@/lib/review/category-admin";
import { classificationIsReady, safeReturnTo, withMessage } from "@/lib/review/gate";
import { prismaClassifyStore } from "@/lib/review/prisma-store";
import { applyRules } from "@/lib/rules/apply";
import { KINDS, type Kind } from "@/lib/rules/types";

const BACK = "/admin/rules?tab=categories";
const text = (f: FormData, k: string) => String(f.get(k) ?? "");
const TREATMENTS = new Set<string>(["PNL_EXPENSE", "PNL_INCOME", "NON_PL", "PERSONAL"]);

/** Runs one change, optionally re-applies the rules to non-manual rows in open months, and returns to the page with a message. */
async function run(formData: FormData, change: (ctx: { businessId: string; actor: string }) => Promise<Result<object>>, done: string, reapply: boolean): Promise<never> {
  const back = safeReturnTo(formData.get("returnTo"), BACK);
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  const res = await change({ businessId: business.id, actor });
  if (!res.ok) redirect(withMessage(back, "error", res.error));
  let note = "";
  if (reapply && (await classificationIsReady(business.id))) {
    const a = await applyRules(prismaClassifyStore(db, business.id, actor), { all: true });
    note = a.changed ? ` ${a.changed} transaction${a.changed === 1 ? "" : "s"} re-sorted.` : "";
  }
  revalidatePath("/admin", "layout");
  redirect(withMessage(back, "notice", `${done}${note}`));
}

export async function addCategoryAction(formData: FormData): Promise<void> {
  const treatment = text(formData, "treatment");
  const kind = text(formData, "nonPlKind");
  await run(formData, (c) => addCategory(db, c.businessId, c.actor, {
    name: text(formData, "name"),
    treatment: (TREATMENTS.has(treatment) ? treatment : "PNL_EXPENSE") as CategoryTreatment,
    nonPlKind: treatment === "NON_PL" && (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : null,
    groupId: text(formData, "groupId") || null,
  }), "Category added.", true);
}

export async function renameCategoryAction(formData: FormData): Promise<void> {
  await run(formData, (c) => renameCategory(db, c.businessId, c.actor, text(formData, "id"), text(formData, "name")), "Renamed.", false);
}
export async function moveCategoryAction(formData: FormData): Promise<void> {
  await run(formData, (c) => moveToGroup(db, c.businessId, c.actor, text(formData, "id"), text(formData, "groupId") || null), "Moved.", false);
}
export async function reorderCategoryAction(formData: FormData): Promise<void> {
  await run(formData, (c) => reorderCategory(db, c.businessId, c.actor, text(formData, "id"), text(formData, "dir") === "up" ? "up" : "down"), "Reordered.", false);
}
export async function showWhenZeroAction(formData: FormData): Promise<void> {
  await run(formData, (c) => setShowWhenZero(db, c.businessId, c.actor, text(formData, "id"), text(formData, "value") === "1"), "Saved.", false);
}
export async function quickPickAction(formData: FormData): Promise<void> {
  const op = text(formData, "op");
  await run(formData, (c) => setQuickPick(db, c.businessId, c.actor, text(formData, "id"), (["add", "remove", "up", "down"].includes(op) ? op : "add") as "add"), "Quick picks updated.", false);
}
export async function archiveCategoryAction(formData: FormData): Promise<void> {
  await run(formData, (c) => archiveCategory(db, c.businessId, c.actor, text(formData, "id")), "Archived.", true);
}
export async function restoreCategoryAction(formData: FormData): Promise<void> {
  await run(formData, (c) => restoreCategory(db, c.businessId, c.actor, text(formData, "id")), "Restored.", true);
}
export async function mergeCategoryAction(formData: FormData): Promise<void> {
  await run(formData, async (c) => {
    const r = await mergeCategories(db, c.businessId, c.actor, text(formData, "fromId"), text(formData, "toId"));
    return r;
  }, "Merged.", true);
}
export async function addGroupAction(formData: FormData): Promise<void> {
  await run(formData, (c) => addGroup(db, c.businessId, c.actor, text(formData, "name")), "Group added.", false);
}
export async function renameGroupAction(formData: FormData): Promise<void> {
  await run(formData, (c) => renameGroup(db, c.businessId, c.actor, text(formData, "id"), text(formData, "name")), "Renamed.", false);
}
export async function reorderGroupAction(formData: FormData): Promise<void> {
  await run(formData, (c) => reorderGroup(db, c.businessId, c.actor, text(formData, "id"), text(formData, "dir") === "up" ? "up" : "down"), "Reordered.", false);
}
