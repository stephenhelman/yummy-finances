import type { Metadata } from "next";
import Link from "next/link";
import { Notice, PendingNotice } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { monthLabel } from "@/lib/format";
import { classificationIsReady } from "@/lib/review/gate";
import { setSalesTaxInRevenueAction } from "./actions";

export const metadata: Metadata = { title: "Reports" };

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function ReportsPage({ searchParams }: { searchParams: Params }) {
  await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;
  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>Reports</h1>
        <PendingNotice />
      </>
    );
  }
  const cur = currentMonth(new Date(), business.timezone);
  const year = cur.slice(0, 4);
  const months = Array.from({ length: Number(cur.slice(5)) }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`).reverse();
  const snaps = new Map((await db.monthSnapshot.findMany({ where: { businessId: business.id, month: { in: months } }, select: { month: true, status: true } })).map((s) => [s.month, s.status]));

  return (
    <>
      <h1>Reports</h1>
      <Notice notice={one(sp.notice)} error={one(sp.error)} />
      <p className="muted">The profit and loss as your accountant lays it out. Months that aren&rsquo;t locked are drafts and can still change.</p>

      <Link href="/admin/reports/year" className="card year-link">
        <span className="txn-main">
          <span className="txn-merchant">{year} year to date</span>
          <span className="small muted">Every month side by side, a trend chart and ratios</span>
        </span>
        <span className="btn btn-secondary btn-sm">Open</span>
      </Link>

      <Link href="/admin/reports/file-past" className="card year-link">
        <span className="txn-main">
          <span className="txn-merchant">Lock &amp; file past months</span>
          <span className="small muted">One time: lock a range of past months and write them to the workbook, with no email</span>
        </span>
        <span className="btn btn-secondary btn-sm">Open</span>
      </Link>

      <ul className="txn-list">
        {months.map((m) => {
          const locked = snaps.get(m) === "LOCKED";
          return (
            <li key={m}>
              <Link href={`/admin/reports/${m}`} className="txn-row">
                <span className="txn-main">
                  <span className="txn-merchant">{monthLabel(m, true)}</span>
                  <span className="small muted">{m === cur ? "This month so far" : locked ? "Final" : "Draft"}</span>
                </span>
                <span className={`badge ${locked ? "badge-ok" : "badge-neutral"}`}>{locked ? "Locked" : "Draft"}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <section className="card" aria-labelledby="tax-h">
        <div className="card-title">
          <h2 id="tax-h">Sales tax in revenue</h2>
          <span className={`badge ${business.salesTaxInRevenue ? "badge-warn" : "badge-neutral"}`}>{business.salesTaxInRevenue ? "On" : "Off"}</span>
        </div>
        <p className="small muted">
          {business.salesTaxInRevenue
            ? "Total Sales includes the sales tax collected, and Sales Tax is an expense line equal to the tax collected."
            : "Total Sales leaves sales tax out, and Sales Tax stays below the line. The cash notes show tax collected versus paid."}{" "}
          Net Income is the same either way. Locked months don&rsquo;t change.
        </p>
        <form action={setSalesTaxInRevenueAction}>
          <input type="hidden" name="returnTo" value="/admin/reports" />
          <input type="hidden" name="value" value={business.salesTaxInRevenue ? "0" : "1"} />
          <button type="submit" className="btn btn-secondary">{business.salesTaxInRevenue ? "Leave tax out of revenue" : "Include tax in revenue"}</button>
        </form>
      </section>
    </>
  );
}
