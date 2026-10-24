"use server";

import { revalidatePath } from "next/cache";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";

/** Include/exclude an account from syncing. Marks the choice as the user's so refreshes never undo it. */
export async function setAccountIncluded(formData: FormData): Promise<void> {
  await requireAdmin();
  const accountId = String(formData.get("accountId") ?? "");
  const included = formData.get("included") === "true";
  const business = await getBusiness();
  const { count } = await db.bankAccount.updateMany({
    where: { id: accountId, businessId: business.id },
    data: { included, includedSetByUser: true },
  });
  if (count !== 1) throw new Error("Account not found");
  revalidatePath("/admin/connections");
}
