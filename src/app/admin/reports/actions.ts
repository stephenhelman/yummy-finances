"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { safeReturnTo, withMessage } from "@/lib/review/gate";

/** How sales tax is shown. Only affects reports that aren't locked: locked snapshots are never rewritten. */
export async function setSalesTaxInRevenueAction(formData: FormData): Promise<void> {
  const back = safeReturnTo(formData.get("returnTo"), "/admin/reports");
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  const value = formData.get("value") === "1";
  if (business.salesTaxInRevenue !== value) {
    await db.business.update({ where: { id: business.id }, data: { salesTaxInRevenue: value } });
    await db.auditLog.create({ data: { businessId: business.id, actor, action: "business.salesTaxInRevenue", entity: "Business", entityId: business.id, payload: { from: business.salesTaxInRevenue, to: value } } });
  }
  revalidatePath("/admin", "layout");
  redirect(withMessage(back, "notice", value ? "Sales tax is now included in revenue." : "Sales tax is now left out of revenue."));
}
