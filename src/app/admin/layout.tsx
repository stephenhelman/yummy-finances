import { AdminNav } from "@/components/admin-nav";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { isDevAuthBypass } from "@/lib/dev-auth";
import { classificationIsReady } from "@/lib/review/gate";
import { reviewBadgeCount } from "@/lib/review/queries";
import { queueSince } from "@/lib/review/view";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const business = await getBusiness();
  // The badge is a convenience: a failure here must never take the page down.
  const reviewCount = await (async () => {
    try {
      return (await classificationIsReady(business.id)) ? await reviewBadgeCount(db, business.id, queueSince(currentMonth(new Date(), business.timezone))) : null;
    } catch {
      return null;
    }
  })();
  return (
    <>
      {isDevAuthBypass() ? <div className="dev-banner" role="status">Login is turned off (local development only)</div> : null}
      <header className="app-header">
        <div className="container">
          <div className="app-header-top">
            <div className="app-title">
              <small>Yummy Finances</small>
              {business.name}
            </div>
            <form method="post" action="/api/auth/logout">
              <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
            </form>
          </div>
          <AdminNav reviewCount={reviewCount} />
        </div>
      </header>
      <main className="container page">{children}</main>
    </>
  );
}
