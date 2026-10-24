import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { completeReconnect, plaidErrorSummary } from "@/lib/plaid";
import { PlaidItemUnusableError } from "@/lib/plaid-item";
import { isSameOrigin } from "@/lib/request";

// Called after a successful Link update-mode session. Update mode does not return a new
// access token, so there is nothing to exchange: we re-check the Item and refresh accounts.
export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  try {
    const business = await getBusiness();
    const health = await completeReconnect(business.id);
    return NextResponse.json({ status: health.status, errorCode: health.errorCode });
  } catch (e) {
    if (e instanceof PlaidItemUnusableError) return NextResponse.json({ error: "item_unusable", code: e.code, message: e.message }, { status: 409 });
    console.error("reconnect failed:", plaidErrorSummary(e));
    return NextResponse.json({ error: "reconnect_failed" }, { status: 500 });
  }
}
