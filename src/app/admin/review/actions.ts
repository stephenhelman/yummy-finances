"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { classificationIsReady, safeReturnTo, withMessage } from "@/lib/review/gate";
import { prismaClassifyStore } from "@/lib/review/prisma-store";
import { classifyManually, undoLast } from "@/lib/review/service";

// Both actions re-check admin and classification readiness themselves (a form post can be replayed without the page).
// They finish with a redirect so the page re-renders with the next card and a one-line message.

async function context() {
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  return { store: prismaClassifyStore(db, business.id, actor), ready: await classificationIsReady(business.id) };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function classifyAction(formData: FormData): Promise<void> {
  const back = safeReturnTo(formData.get("returnTo"), "/admin/review");
  const { store, ready } = await context();
  if (!ready) redirect(withMessage(back, "error", "Transactions haven't been categorized yet."));

  let choice = String(formData.get("choice") ?? "");
  if (choice === "more:category") {
    const id = String(formData.get("category") ?? "");
    if (!id) redirect(withMessage(back, "error", "Pick a category first."));
    choice = `cat:${id}`;
  }
  const res = await classifyManually(store, { txnId: String(formData.get("txnId") ?? ""), value: choice, always: formData.get("always") === "1" });
  revalidatePath("/admin", "layout");
  if (!res.ok) redirect(withMessage(back, "error", res.error));
  const extra = res.rulesSaved ? ` Rule saved; ${plural(res.reapplied?.changed ?? 0, "other transaction")} updated.` : "";
  redirect(withMessage(back, "notice", `Saved.${extra}`));
}

export async function undoAction(formData: FormData): Promise<void> {
  const back = safeReturnTo(formData.get("returnTo"), "/admin/review");
  const { store, ready } = await context();
  if (!ready) redirect(withMessage(back, "error", "Transactions haven't been categorized yet."));
  const res = await undoLast(store);
  revalidatePath("/admin", "layout");
  if (!res.ok) redirect(withMessage(back, "error", res.error));
  redirect(withMessage(back, "notice", res.reapplied ? `Undone. ${plural(res.reapplied.changed, "other transaction")} restored.` : "Undone."));
}
