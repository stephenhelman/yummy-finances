import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { checkItemHealth, plaidErrorSummary, getPlaid } from "@/lib/plaid";
import { db } from "@/lib/db";
import { PlaidItemUnusableError } from "@/lib/plaid-item";
import { isSameOrigin, itemIdFrom } from "@/lib/request";

export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const itemId = await itemIdFrom(request);
  if (!itemId) return NextResponse.json({ error: "missing_item_id" }, { status: 400 });
  try {
    const business = await getBusiness();
    const { env } = getPlaid();
    const item = await db.plaidItem.findFirst({ where: { id: itemId, businessId: business.id, environment: env } });
    if (!item) return NextResponse.json({ error: "not_connected" }, { status: 404 });
    const health = await checkItemHealth(item.id);
    return NextResponse.json({ status: health.status, errorCode: health.errorCode });
  } catch (e) {
    if (e instanceof PlaidItemUnusableError) return NextResponse.json({ error: "item_unusable", code: e.code, message: e.message }, { status: 409 });
    console.error("health check failed:", plaidErrorSummary(e));
    return NextResponse.json({ error: "health_check_failed" }, { status: 500 });
  }
}
