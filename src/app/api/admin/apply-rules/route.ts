import { NextResponse } from "next/server";
import { rejectUnlessCron } from "@/lib/cron";
import { db } from "@/lib/db";
import { claimLock, releaseLock } from "@/lib/job-lock";
import { prismaReleaseDeps, runRulesRelease } from "@/lib/rules/release";

// The rules release, run inside the deployed environment so production credentials never leave Vercel:
// planned category changes -> persist the rules -> categorize every transaction -> write the backfill marker.
// Auth: `Authorization: Bearer $CRON_SECRET`. Idempotent: calling it twice is safe (the second call changes nothing).
// Never un-confirms or re-enables an existing rule, never overwrites manual categorizations, never touches
// locked months. Response: counts only (no descriptors, ids or tokens).
export const maxDuration = 300;

const JOB = "apply-rules";

export async function POST(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  const business = await db.business.findFirst({ select: { id: true } });
  if (!business) return NextResponse.json({ ok: false, error: "No business row: run the seed first" }, { status: 409 });
  if (!(await claimLock(business.id, JOB, "15 minutes"))) {
    return NextResponse.json({ ok: false, error: "already_running", message: "The rules release is already running." }, { status: 409 });
  }
  try {
    const result = await runRulesRelease(prismaReleaseDeps(db, business.id));
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    // Messages from our own code ("Category … does not exist", "Rule …") are safe and useful; anything else is not echoed.
    const message = e instanceof Error && /^(Category|Rule) /.test(e.message) ? e.message : "rules release failed";
    console.error("apply-rules failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await releaseLock(business.id, JOB);
  }
}
