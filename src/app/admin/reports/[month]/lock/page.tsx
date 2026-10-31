import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PendingNotice } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { monthLabel } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { classificationIsReady } from "@/lib/review/gate";
import { lockEligibility, unreviewedCount } from "@/lib/report/close";
import { loadReport } from "@/lib/report/load";
import { lockAndSendAction } from "../../close-actions";

export const metadata: Metadata = { title: "Lock and send" };

export default async function LockPage({ params }: { params: Promise<{ month: string }> }) {
  await requireAdmin();
  const { month } = await params;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) notFound();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) return <PendingNotice />;

  const { report, status, emailSentAt } = await loadReport(business, month);
  const elig = lockEligibility(month, new Date(), business.timezone);
  const recipients = [business.ownerEmail, business.ccEmail].filter(Boolean).join(", ");
  const unreviewed = unreviewedCount(report);

  return (
    <>
      <p className="small"><Link href={`/admin/reports/${month}`}>Back to {monthLabel(month, true)}</Link></p>
      <h1>Lock and send {monthLabel(month, true)}</h1>

      {status === "LOCKED" ? (
        <section className="card">
          <p>This month is already locked{emailSentAt ? " and sent" : " but hasn't been sent"}.</p>
          <Link href={`/admin/reports/${month}`} className="btn btn-primary">Go to the report</Link>
        </section>
      ) : !elig.ok ? (
        <p className="alert alert-warn" role="status"><strong>Can&rsquo;t lock yet</strong>{elig.reason}</p>
      ) : (
        <>
          <section className="card" aria-labelledby="what-h">
            <h2 id="what-h">What this does</h2>
            <ul className="notes">
              <li>Locks {monthLabel(month, true)}: its numbers are saved exactly as shown and can&rsquo;t change afterwards.</li>
              <li>Sends the report (a PDF and the Google Sheet link) to {recipients}.</li>
              <li>If sending fails, the month stays locked and you can Re-send.</li>
            </ul>
            <dl className="kv">
              <div><dt>Gross Revenue</dt><dd>{formatCents(report.revenue.grossRevenueCents)}</dd></div>
              <div><dt>Total Expenses</dt><dd>{formatCents(report.expenses.totalCents)}</dd></div>
              <div className="kv-main"><dt>Net Income</dt><dd>{formatCents(report.netIncomeCents)}</dd></div>
            </dl>
          </section>

          {report.warnings.length ? (
            <section className="alert alert-warn" role="status" aria-label="Warnings">
              <strong>{report.warnings.length === 1 ? "1 warning" : `${report.warnings.length} warnings`}</strong>
              {report.warnings.map((w) => <p key={w}>{w}</p>)}
              {unreviewed ? <p><Link href={`/admin/review?month=${month}`}>Review those transactions first</Link></p> : null}
            </section>
          ) : (
            <p className="alert alert-ok" role="status"><strong>No warnings</strong>Nothing was flagged for this month.</p>
          )}

          <form action={lockAndSendAction} className="stack">
            <input type="hidden" name="month" value={month} />
            {report.warnings.length ? (
              <label className="toggle">
                <input type="checkbox" name="ack" value="1" required />
                <span>I&rsquo;ve read the warnings and want to lock this month anyway.</span>
              </label>
            ) : null}
            <button type="submit" className="btn btn-primary">Lock and send {monthLabel(month)}</button>
            <Link href={`/admin/reports/${month}`} className="btn btn-ghost">Cancel</Link>
          </form>
        </>
      )}
    </>
  );
}
