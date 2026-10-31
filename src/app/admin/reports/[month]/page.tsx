import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PendingNotice } from "@/components/review/txn-card";
import { ReportView, ReportWarnings } from "@/components/report-view";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { monthLabel } from "@/lib/format";
import { classificationIsReady } from "@/lib/review/gate";
import { loadReport } from "@/lib/report/load";

export const metadata: Metadata = { title: "Report" };

export default async function ReportMonthPage({ params }: { params: Promise<{ month: string }> }) {
  await requireAdmin();
  const { month } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) notFound();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>{monthLabel(month, true)}</h1>
        <PendingNotice />
      </>
    );
  }
  const { report, source, status } = await loadReport(business, month);

  return (
    <>
      <p className="small"><Link href="/admin/reports">All reports</Link></p>
      <div className="row-between">
        <h1>{monthLabel(month, true)}</h1>
        <span className={`badge ${status === "LOCKED" ? "badge-ok" : "badge-warn"}`}>{status === "LOCKED" ? "Locked" : "Draft"}</span>
      </div>
      {status === "DRAFT" ? <p className="alert alert-warn" role="status"><strong>Draft, not final</strong>Numbers can still change until the month is locked.</p> : null}
      {status === "LOCKED" && source === "live" ? <p className="alert alert-warn" role="status"><strong>Locked in an older layout</strong>Showing today&rsquo;s numbers in the new layout. The locked snapshot is unchanged.</p> : null}
      {report.salesTaxInRevenue ? <p className="small muted">Sales tax is included in revenue (and shown as an expense).</p> : null}
      <ReportWarnings warnings={report.warnings} />
      <ReportView report={report} />
    </>
  );
}
