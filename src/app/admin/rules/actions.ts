"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { classificationIsReady, safeReturnTo, withMessage } from "@/lib/review/gate";
import { prismaClassifyStore } from "@/lib/review/prisma-store";
import { changeRule, confirmRule, labelRecipient, setRuleActive, type RuleOutcome } from "@/lib/review/service";
import type { RecipientLabel } from "@/lib/rules/zelle";

async function run(formData: FormData, fn: (store: ReturnType<typeof prismaClassifyStore>) => Promise<RuleOutcome>, done: string): Promise<never> {
  const back = safeReturnTo(formData.get("returnTo"), "/admin/rules");
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) redirect(withMessage(back, "error", "Transactions haven't been categorized yet."));
  const res = await fn(prismaClassifyStore(db, business.id, actor));
  revalidatePath("/admin", "layout");
  if (!res.ok) redirect(withMessage(back, "error", res.error));
  const n = res.reapplied.changed;
  redirect(withMessage(back, "notice", `${done} ${n} transaction${n === 1 ? "" : "s"} changed.`));
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "");

export async function confirmRuleAction(formData: FormData): Promise<void> {
  await run(formData, (s) => confirmRule(s, text(formData, "ruleId")), "Confirmed.");
}

export async function changeRuleAction(formData: FormData): Promise<void> {
  let value = text(formData, "choice");
  if (value === "more:category") value = `cat:${text(formData, "category")}`;
  await run(formData, (s) => changeRule(s, text(formData, "ruleId"), value), "Saved.");
}

export async function setRuleActiveAction(formData: FormData): Promise<void> {
  const active = text(formData, "active") === "1";
  await run(formData, (s) => setRuleActive(s, text(formData, "ruleId"), active), active ? "Turned on." : "Turned off.");
}

const LABELS = new Set<RecipientLabel>(["STAFF", "FAMILY", "VENDOR", "OTHER"]);

export async function labelRecipientAction(formData: FormData): Promise<void> {
  const label = text(formData, "label") as RecipientLabel;
  if (!LABELS.has(label)) redirect(withMessage(safeReturnTo(formData.get("returnTo"), "/admin/rules?tab=people"), "error", "Unknown label."));
  await run(formData, (s) => labelRecipient(s, { name: text(formData, "name"), label, vendorCategoryId: text(formData, "category") || undefined }), "Labeled.");
}
