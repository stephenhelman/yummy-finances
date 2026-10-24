import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isDevAuthBypass } from "@/lib/dev-auth";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

// Optimistic gate only: unauthenticated visitors are redirected to /login.
// Real authorization happens in requireAdmin() on every admin page/handler.
export async function proxy(request: NextRequest) {
  if (isDevAuthBypass()) return NextResponse.next();
  const session = await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.redirect(new URL("/login", request.url));
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/plaid/:path*"],
};
