import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { PlaidAlreadyConnectedError, connectItem, plaidErrorSummary } from "@/lib/plaid";
import { isSameOrigin } from "@/lib/request";

export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { public_token?: unknown } | null;
  if (typeof body?.public_token !== "string" || !body.public_token) {
    return NextResponse.json({ error: "missing_public_token" }, { status: 400 });
  }
  try {
    const business = await getBusiness();
    const item = await connectItem({ businessId: business.id, publicToken: body.public_token });
    return NextResponse.json({ ok: true, institution: item.institutionName });
  } catch (e) {
    if (e instanceof PlaidAlreadyConnectedError) return NextResponse.json({ error: "already_connected" }, { status: 409 });
    console.error("exchange failed:", plaidErrorSummary(e));
    return NextResponse.json({ error: "exchange_failed" }, { status: 500 });
  }
}
