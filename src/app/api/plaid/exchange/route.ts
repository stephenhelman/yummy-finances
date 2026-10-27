import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { PlaidConnectInProgressError, PlaidInstitutionAlreadyConnectedError, connectItem, plaidErrorSummary } from "@/lib/plaid";
import { isSameOrigin } from "@/lib/request";

export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const body = (await request.json().catch(() => null)) as { public_token?: unknown; institution_id?: unknown } | null;
  if (typeof body?.public_token !== "string" || !body.public_token) {
    return NextResponse.json({ error: "missing_public_token" }, { status: 400 });
  }
  try {
    const business = await getBusiness();
    const item = await connectItem({ businessId: business.id, publicToken: body.public_token,
      hintInstitutionId: typeof body.institution_id === "string" ? body.institution_id : null,
    });
    return NextResponse.json({ ok: true, institution: item.institutionName });
  } catch (e) {
    if (e instanceof PlaidInstitutionAlreadyConnectedError) return NextResponse.json({ error: "institution_already_connected", institution: e.institutionName }, { status: 409 });
    if (e instanceof PlaidConnectInProgressError) return NextResponse.json({ error: "connect_in_progress" }, { status: 409 });
    console.error("exchange failed:", plaidErrorSummary(e));
    return NextResponse.json({ error: "exchange_failed" }, { status: 500 });
  }
}
