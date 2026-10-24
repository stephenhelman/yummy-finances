import { NextResponse } from "next/server";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { isSameOrigin } from "@/lib/request";
import { claimSyncLock, releaseSyncLock, runAndRecordManualSync } from "@/lib/sync-now";

// A first sync pulls up to 730 days of transactions and three months of Clover data.
export const maxDuration = 300;

export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (!isSameOrigin(request)) return NextResponse.json({ error: "bad_origin" }, { status: 403 });

  const business = await getBusiness();
  if (!(await claimSyncLock(business.id))) {
    return NextResponse.json({ error: "already_running", message: "A sync is already running. Try again in a minute." }, { status: 409 });
  }
  try {
    const { result, summary } = await runAndRecordManualSync(business, admin.email);
    await releaseSyncLock(business.id, summary.ok ? undefined : "one or more sources failed");
    return NextResponse.json({ summary, result });
  } catch (e) {
    await releaseSyncLock(business.id, e instanceof Error ? e.message : "failed");
    console.error("sync-now failed:", e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "sync_failed", message: "Sync failed unexpectedly." }, { status: 500 });
  }
}
