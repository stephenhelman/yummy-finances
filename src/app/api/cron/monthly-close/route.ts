import { NextResponse } from "next/server";
import { rejectUnlessCron } from "@/lib/cron";
import { db } from "@/lib/db";
import { classificationIsReady } from "@/lib/review/gate";
import { autoSendEnabled, monthlyClose } from "@/lib/report/cron-jobs";
import { closeCronDeps } from "@/lib/report/cron-store";

// 5th of the month: sync -> lock -> send last month's report. OFF unless REPORTS_AUTO_SEND=true. It never locks a month that has
// unreviewed transactions or a bank needing attention: it emails a notice saying why instead. Idempotent per month (JobRun).
// Auth: `Authorization: Bearer $CRON_SECRET` (what Vercel Cron sends). Counts only in the response.
export const maxDuration = 300;

async function handle(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;
  if (!autoSendEnabled()) return NextResponse.json({ ok: true, status: "disabled" });
  const business = await db.business.findFirst();
  if (!business) return NextResponse.json({ ok: false, error: "No business row" }, { status: 409 });
  if (!(await classificationIsReady(business.id))) return NextResponse.json({ ok: true, status: "skipped_not_categorized" });
  try {
    return NextResponse.json({ ok: true, ...(await monthlyClose(closeCronDeps(business))) });
  } catch (e) {
    console.error("monthly-close failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ ok: false, error: "monthly close failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
