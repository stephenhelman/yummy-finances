import { NextResponse } from "next/server";
import { rejectUnlessCron } from "@/lib/cron";
import { hasPreviousKey } from "@/lib/crypto";
import { prismaTokenStore, rotateTokens } from "@/lib/rotate-tokens";

// Re-encrypts every stored Plaid token with the current ENCRYPTION_KEY. Runs inside the deployed
// environment so production keys never reach a laptop. Auth: `Authorization: Bearer $CRON_SECRET`.
// Idempotent. Response: counts only (no ids, no tokens).
export const maxDuration = 60;

export async function POST(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;
  try {
    const previousKeySet = hasPreviousKey();
    const counts = await rotateTokens(prismaTokenStore);
    const ok = counts.failed === 0;
    return NextResponse.json({ ok, previousKeySet, ...counts }, { status: ok ? 200 : 422 });
  } catch (e) {
    // Key misconfiguration (unset / wrong length). The message names the variable, never a value.
    const message = e instanceof Error && e.message.startsWith("ENCRYPTION_KEY") ? e.message : "rotation failed";
    console.error("rotate-tokens failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
