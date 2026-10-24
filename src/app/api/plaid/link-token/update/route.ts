import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { createUpdateLinkToken, plaidErrorSummary } from "@/lib/plaid";
import { PlaidItemUnusableError } from "@/lib/plaid-item";
import { isRedirectUriProblem } from "@/lib/plaid-link";
import { isSameOrigin } from "@/lib/request";

export async function POST(request: Request) {
  await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  try {
    const business = await getBusiness();
    return NextResponse.json({ link_token: await createUpdateLinkToken(business.id) });
  } catch (e) {
    if (e instanceof PlaidItemUnusableError) return NextResponse.json({ error: "item_unusable", code: e.code, message: e.message }, { status: 409 });
    const summary = plaidErrorSummary(e);
    console.error("update link-token failed:", summary);
    if (isRedirectUriProblem(summary) || /PLAID_REDIRECT_URI/.test(summary)) return NextResponse.json({ error: "redirect_uri_problem" }, { status: 500 });
    return NextResponse.json({ error: "link_token_failed" }, { status: 500 });
  }
}
