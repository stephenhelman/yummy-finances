import { AdminNav } from "@/components/admin-nav";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { isDevAuthBypass } from "@/lib/dev-auth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  const business = await getBusiness();
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
          <AdminNav />
        </div>
      </header>
      <main className="container page">{children}</main>
    </>
  );
}
