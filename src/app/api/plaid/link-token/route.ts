import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { PlaidAlreadyConnectedError, createLinkToken, plaidErrorSummary } from "@/lib/plaid";
import { isRedirectUriProblem } from "@/lib/plaid-link";
import { isSameOrigin } from "@/lib/request";

export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  try {
    const business = await getBusiness();
    return NextResponse.json({ link_token: await createLinkToken(business.id) });
  } catch (e) {
    if (e instanceof PlaidAlreadyConnectedError) return NextResponse.json({ error: "already_connected" }, { status: 409 });
    const summary = plaidErrorSummary(e);
    console.error("link-token failed:", summary);
    if (isRedirectUriProblem(summary) || /PLAID_REDIRECT_URI/.test(summary)) return NextResponse.json({ error: "redirect_uri_problem" }, { status: 500 });
    return NextResponse.json({ error: "link_token_failed" }, { status: 500 });
  }
}
