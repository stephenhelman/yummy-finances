import { NextResponse } from "next/server";
import { rejectUnlessCron } from "@/lib/cron";
import { db } from "@/lib/db";
import { classificationIsReady } from "@/lib/review/gate";
import { autoSendEnabled, reviewNudge } from "@/lib/report/cron-jobs";
import { nudgeDeps } from "@/lib/report/cron-store";

// 3rd of the month: a plain email saying how many of last month's bank transactions still need review.
// OFF unless REPORTS_AUTO_SEND=true. Auth: `Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends). Counts only in the response.
export const maxDuration = 60;

async function handle(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;
  if (!autoSendEnabled()) return NextResponse.json({ ok: true, status: "disabled" });
  const business = await db.business.findFirst();
  if (!business) return NextResponse.json({ ok: false, error: "No business row" }, { status: 409 });
  if (!(await classificationIsReady(business.id))) return NextResponse.json({ ok: true, status: "skipped_not_categorized" });
  try {
    return NextResponse.json({ ok: true, ...(await reviewNudge(nudgeDeps(business))) });
  } catch (e) {
    console.error("review-nudge failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ ok: false, error: "review nudge failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
