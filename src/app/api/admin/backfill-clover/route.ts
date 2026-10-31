import { NextResponse } from "next/server";
import { claimLock, releaseLock } from "@/lib/job-lock";
import { parseBackfill } from "@/lib/clover/backfill";
import { syncCloverMonth } from "@/lib/clover/sync";
import { rejectUnlessCron } from "@/lib/cron";
import { currentMonth } from "@/lib/dates";
import { db } from "@/lib/db";

// Backfills Clover payments, refunds and orders (with discounts) for up to three months per call, inside Vercel, so production
// credentials never leave it. Body: { "year": 2025, "quarter": 1 } or { "from": "2026-01", "to": "2026-03" }.
// Auth: `Authorization: Bearer $CRON_SECRET`. Idempotent: a repeat finds nothing new. Clover's order LIST only returns about the last
// 90 days, so older orders are fetched by id from the payments we already have (50 per request). Counts only in the response;
// if `complete` is false some orders are still missing: call it again, it picks up where it left off.
export const maxDuration = 300;

const JOB = "backfill-clover";
const ORDERS_BY_ID_PER_MONTH = 4000; // a busy month is ~2,300; the cap just bounds one call

export async function POST(request: Request) {
  const denied = rejectUnlessCron(request);
  if (denied) return denied;

  const body: unknown = await request.json().catch(() => null);
  const business = await db.business.findFirst({ select: { id: true, timezone: true } });
  if (!business) return NextResponse.json({ ok: false, error: "No business row: run the seed first" }, { status: 409 });

  const parsed = parseBackfill(body, currentMonth(new Date(), business.timezone));
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });
  const { plan } = parsed;

  if (!(await claimLock(business.id, JOB, "15 minutes"))) {
    return NextResponse.json({ ok: false, error: "already_running", message: "A Clover backfill is already running." }, { status: 409 });
  }
  try {
    const report = await syncCloverMonth({ businessId: business.id, timezone: business.timezone, month: plan.target, lookbackMonths: plan.lookbackMonths, maxOrdersById: ORDERS_BY_ID_PER_MONTH });
    const months = report.months.map((m) => ({
      month: m.month,
      payments: { fetched: m.payments.fetched, created: m.payments.created, updated: m.payments.updated },
      refunds: { fetched: m.refunds.fetched, created: m.refunds.created, updated: m.refunds.updated },
      orders: { fromList: m.orders?.fetched ?? 0, byId: m.orders?.byId ?? 0, withDiscount: m.orders?.withDiscount ?? 0, stillMissing: m.orders?.stillMissing ?? 0 },
    }));
    const stillMissing = months.reduce((a, m) => a + m.orders.stillMissing, 0);
    return NextResponse.json({ ok: true, complete: stillMissing === 0, clipped: plan.clipped, stillMissing, months });
  } catch (e) {
    // Messages from our own code are safe; never echo anything else (it could carry a URL or token)
    const message = e instanceof Error && /^Clover timezone /.test(e.message) ? e.message : "backfill failed";
    console.error("backfill-clover failed:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  } finally {
    await releaseLock(business.id, JOB);
  }
}
