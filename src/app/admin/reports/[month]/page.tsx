import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Notice, PendingNotice } from "@/components/review/txn-card";
import { ReportView, ReportWarnings } from "@/components/report-view";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { monthLabel } from "@/lib/format";
import { classificationIsReady } from "@/lib/review/gate";
import { lockEligibility } from "@/lib/report/close";
import { loadReport } from "@/lib/report/load";
import { formatDateTime } from "@/lib/format";
import { resendAction, sendTestAction } from "../close-actions";

export const metadata: Metadata = { title: "Report" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function ReportMonthPage({ params, searchParams }: { params: Promise<{ month: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireAdmin();
  const { month } = await params;
  const sp = await searchParams;
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
  const { report, source, status, lockedAt, emailSentAt } = await loadReport(business, month);
  const elig = lockEligibility(month, new Date(), business.timezone);

  return (
    <>
      <p className="small"><Link href="/admin/reports">All reports</Link></p>
      <div className="row-between">
        <h1>{monthLabel(month, true)}</h1>
        <span className={`badge ${status === "LOCKED" ? "badge-ok" : "badge-warn"}`}>{status === "LOCKED" ? "Locked" : "Draft"}</span>
      </div>
      <Notice notice={one(sp.notice)} error={one(sp.error)} />
      {status === "DRAFT" ? <p className="alert alert-warn" role="status"><strong>Draft, not final</strong>Numbers can still change until the month is locked.</p> : null}
      {status === "LOCKED" ? (
        <p className={`alert ${emailSentAt ? "alert-ok" : "alert-warn"}`} role="status">
          <strong>{emailSentAt ? "Locked and sent" : "Locked, but not sent"}</strong>
          {lockedAt ? `Locked ${formatDateTime(lockedAt, business.timezone)}. ` : ""}
          {emailSentAt ? `Last sent ${formatDateTime(emailSentAt, business.timezone)}.` : "Sending hasn't succeeded yet: use Re-send."}
        </p>
      ) : null}

      <section className="card" aria-labelledby="send-h">
        <h2 id="send-h">Send</h2>
        <div className="row">
          {status === "LOCKED" ? (
            <form action={resendAction}>
              <input type="hidden" name="month" value={month} />
              <button type="submit" className="btn btn-primary">Re-send</button>
            </form>
          ) : elig.ok ? (
            <Link href={`/admin/reports/${month}/lock`} className="btn btn-primary">Lock &amp; send…</Link>
          ) : (
            <button type="button" className="btn btn-primary" disabled>Lock &amp; send…</button>
          )}
          <form action={sendTestAction}>
            <input type="hidden" name="month" value={month} />
            <button type="submit" className="btn btn-secondary">Send test report</button>
          </form>
        </div>
        {status === "DRAFT" && !elig.ok ? <p className="small muted">{elig.reason}</p> : null}
        <p className="small muted">A test report goes to the owner&rsquo;s email only, into a separate &ldquo;Yummy Finances TEST&rdquo; workbook, and is marked TEST everywhere. It locks nothing.</p>
      </section>
      {status === "LOCKED" && source === "live" ? <p className="alert alert-warn" role="status"><strong>Locked in an older layout</strong>Showing today&rsquo;s numbers in the new layout. The locked snapshot is unchanged.</p> : null}
      {report.salesTaxInRevenue ? <p className="small muted">Sales tax is included in revenue (and shown as an expense).</p> : null}
      <ReportWarnings warnings={report.warnings} />
      <ReportView report={report} />
    </>
  );
}
