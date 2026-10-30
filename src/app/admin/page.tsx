import type { Metadata } from "next";
import { Suspense } from "react";
import { BankCard, CloverCard, CloverCardSkeleton, RevenueCard, ReviewCard, TaxNote } from "@/components/dashboard-cards";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { loadDashboard, loadReviewCard } from "@/lib/dashboard";
import { dayOfMonth, monthLabel } from "@/lib/format";
import { getLastCloverSyncAt } from "@/lib/sync-now";
import { SyncNowButton } from "./connections/sync-now-button";

export const metadata: Metadata = { title: "Dashboard" };

export default async function Dashboard() {
  await requireAdmin();
  const business = await getBusiness();
  const now = new Date();
  const [d, cloverSyncedAt] = await Promise.all([loadDashboard(business, now), getLastCloverSyncAt(business.id)]);
  const review = await loadReviewCard(business, d.currentMonth);

  const today = dayOfMonth(now, business.timezone);
  const curName = monthLabel(d.currentMonth);

  return (
    <>
      <h1>Dashboard</h1>

      <div className="grid-2">
        <Suspense fallback={<CloverCardSkeleton />}>
          <CloverCard lastSyncedAt={cloverSyncedAt} timezone={business.timezone} />
        </Suspense>
        <BankCard bank={d.bank} timezone={business.timezone} />
      </div>

      <ReviewCard data={review} />

      <TaxNote months={[d.current, d.previous]} />

      <div className="grid-2">
        <RevenueCard title={`${curName} so far`} subtitle={`${curName} 1 to ${today}`} revenue={d.current} />
        <RevenueCard title={monthLabel(d.previousMonth, true)} subtitle="Full month" revenue={d.previous} />
      </div>

      <section className="card" aria-labelledby="sync-h">
        <h2 id="sync-h">Sync now</h2>
        <p className="small muted">Pulls the latest bank transactions and Clover sales.</p>
        <SyncNowButton last={d.lastSync} />
      </section>
    </>
  );
}
