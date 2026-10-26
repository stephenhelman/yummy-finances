import { NextResponse } from "next/server";
import { startPasscodeSession } from "@/lib/auth";
import { attemptPasscodeLogin, clientIp, passcodeStatus } from "@/lib/passcode";
import { passcodeStore } from "@/lib/passcode-db";
import { isSameOrigin } from "@/lib/request";

export async function POST(request: Request) {
  // Fully disabled (indistinguishable from a missing route) unless a long-enough LOGIN_PASSCODE is set.
  if (passcodeStatus() !== "enabled") return new Response("Not Found", { status: 404 });
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const form = await request.formData();
  const result = await attemptPasscodeLogin(String(form.get("passcode") ?? ""), clientIp(request.headers), passcodeStore);
  if (result.ok) {
    await startPasscodeSession();
    return NextResponse.redirect(new URL("/admin", request.url), 303);
  }
  const to = result.reason === "locked" ? `/login?locked=${result.retryAfterMinutes}` : "/login?error=passcode";
  return NextResponse.redirect(new URL(to, request.url), 303);
}
