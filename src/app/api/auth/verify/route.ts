import { NextResponse } from "next/server";
import { consumeMagicLink, startSession } from "@/lib/auth";

export async function POST(request: Request) {
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const email = token ? await consumeMagicLink(token) : null;
  if (!email) return NextResponse.redirect(new URL("/login?error=1", request.url), 303);
  await startSession(email);
  return NextResponse.redirect(new URL("/admin", request.url), 303);
}
