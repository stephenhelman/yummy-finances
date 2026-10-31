import type { Metadata } from "next";
import Link from "next/link";
import { PendingNotice } from "@/components/review/txn-card";
import { TrendChart } from "@/components/trend-chart";
import { YearTableView } from "@/components/year-table";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { monthLabel } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { classificationIsReady } from "@/lib/review/gate";
import { loadYear } from "@/lib/report/load-year";

export const metadata: Metadata = { title: "Year to date" };
export const maxDuration = 120;

type Params = Promise<Record<string, string | string[] | undefined>>;

export default async function YearPage({ searchParams }: { searchParams: Params }) {
  await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;
  const thisYear = currentMonth(new Date(), business.timezone).slice(0, 4);
  const asked = Array.isArray(sp.year) ? sp.year[0] : sp.year;
  const year = asked && /^20\d\d$/.test(asked) && asked <= thisYear && asked >= "2024" ? asked : thisYear;
  const years = Array.from({ length: Number(thisYear) - 2024 + 1 }, (_, i) => String(Number(thisYear) - i));

  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>Year to date</h1>
        <PendingNotice />
      </>
    );
  }
  const { table, chart, hasLastYear } = await loadYear(business, year);
  const c = table.cash;
  const last = table.columns.at(-1);

  return (
    <>
      <p className="small"><Link href="/admin/reports">All reports</Link></p>
      <div className="row-between">
        <h1>{year} year to date</h1>
        <a className="btn btn-secondary btn-sm" href={`/admin/reports/year/csv?year=${year}`} download>Download CSV</a>
      </div>

      <form method="get" className="row" role="search">
        <label htmlFor="y" className="small muted">Year</label>
        <select id="y" name="year" className="input yr-select" defaultValue={year}>
          {years.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        <button type="submit" className="btn btn-secondary btn-sm">Show</button>
      </form>

      {table.draftMonths.length ? (
        <p className="alert alert-warn" role="status">
          <strong>{table.draftMonths.length === 1 ? "1 month is a draft" : `${table.draftMonths.length} months are drafts`}</strong>
          Marked &ldquo;draft&rdquo; in the table. Locked months show exactly what was reported.
        </p>
      ) : null}

      <section className="card" aria-labelledby="trend-h">
        <h2 id="trend-h">Trend</h2>
        <TrendChart labels={chart.labels} series={chart.series} title={`${year} net sales, total expenses and net income by month`} />
        <p className="small muted">
          {hasLastYear ? `The dotted line is ${Number(year) - 1} net sales, from Clover.` : `No ${Number(year) - 1} Clover sales are stored, so there is no year-over-year line.`} Expenses are not compared with last year yet: {Number(year) - 1} hasn&rsquo;t been reviewed.
        </p>
      </section>

      <YearTableView table={table} />
      <p className="small muted">Whole dollars. Money out is positive on expense lines; returns and discounts are negative. Ratios use net sales (after discounts and returns, before tax).{last ? ` Through ${monthLabel(last.month, true)}.` : ""}</p>

      <section className="card" aria-labelledby="cash-h">
        <h2 id="cash-h">Cash notes, year to date</h2>
        <ul className="notes">
          <li>Sales tax: collected {formatCents(c.taxCollectedCents)}, remitted {formatCents(c.taxRemittedCents)} ({c.taxCollectedCents >= c.taxRemittedCents ? "still owed" : "paid ahead"} {formatCents(Math.abs(c.taxCollectedCents - c.taxRemittedCents))}).</li>
          <li>Owner draws {formatCents(c.ownerDrawsCents)}, owner contributions {formatCents(c.ownerContributionsCents)} (net {formatCents(c.ownerDrawsCents - c.ownerContributionsCents)} taken out).</li>
          <li>Tips: {formatCents(c.tipsCents)} collected and passed through to staff (not revenue, not an expense).</li>
          {c.loanPaymentsCents ? <li>Loan payments: {formatCents(c.loanPaymentsCents)}. Interest portion is deductible; the accountant needs the loan statement.</li> : null}
          <li>Cash: {formatCents(c.cashDepositedCents)} deposited vs {formatCents(c.cashCollectedCents)} cash collected in Clover.</li>
        </ul>
      </section>

      {table.warnings.length ? (
        <details className="more">
          <summary className="btn btn-secondary btn-block">Warnings ({table.warnings.length})</summary>
          <ul className="notes more-body">
            {table.warnings.map((w, i) => <li key={i}><strong>{monthLabel(w.month)}:</strong> {w.text}</li>)}
          </ul>
        </details>
      ) : null}
    </>
  );
}
