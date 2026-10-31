import type { Metadata } from "next";
import Link from "next/link";
import { Notice, PendingNotice } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { monthLabel } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { classificationIsReady } from "@/lib/review/gate";
import { unreviewedCount } from "@/lib/report/close";
import { MAX_FILE_MONTHS, monthRange, problemsFor } from "@/lib/report/file-months";
import { loadReport } from "@/lib/report/load";
import { fileMonthsAction } from "../close-actions";

export const metadata: Metadata = { title: "Lock and file past months" };
export const maxDuration = 300; // the action runs under this page: one Apps Script call per month

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function FilePastPage({ searchParams }: { searchParams: Params }) {
  await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;
  if (!(await classificationIsReady(business.id))) return <PendingNotice />;

  const cur = currentMonth(new Date(), business.timezone);
  const prevYear = String(Number(cur.slice(0, 4)) - 1);
  const choices: string[] = [];
  for (let m = `${prevYear}-01`; m <= cur; m = next(m)) choices.push(m); // the current month is offered so the confirm page can explain why it can't be locked
  const from = one(sp.from), to = one(sp.to);
  const months = from && to ? monthRange(from, to) : null;
  const rangeError = typeof months === "string" ? months : null;

  return (
    <>
      <p className="small"><Link href="/admin/reports">All reports</Link></p>
      <h1>Lock &amp; file past months</h1>
      <Notice notice={one(sp.notice)} error={one(sp.error) ?? rangeError ?? undefined} />
      <p className="muted">A one-time catch-up: lock several past months and write each one&rsquo;s tab and the YTD Summary to the real workbook. <strong>Nothing is emailed.</strong> Locked months can&rsquo;t change afterwards.</p>

      <form method="get" className="card stack" role="search">
        <div className="filter-row">
          <div className="field">
            <label htmlFor="from">First month</label>
            <select id="from" name="from" className="input" defaultValue={from ?? ""} required>
              <option value="" disabled>Choose</option>
              {choices.map((m) => <option key={m} value={m}>{monthLabel(m, true)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="to">Last month</label>
            <select id="to" name="to" className="input" defaultValue={to ?? ""} required>
              <option value="" disabled>Choose</option>
              {choices.map((m) => <option key={m} value={m}>{monthLabel(m, true)}</option>)}
            </select>
          </div>
        </div>
        <p className="small muted">Up to {MAX_FILE_MONTHS} months in a row. The current month and a month that ended less than 3 days ago can&rsquo;t be locked yet.</p>
        <button type="submit" className="btn btn-secondary">Review these months</button>
      </form>

      {Array.isArray(months) ? <Confirm months={months} business={business} from={from!} to={to!} /> : null}
    </>
  );
}

function next(m: string): string {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

async function Confirm({ months, business, from, to }: { months: string[]; business: Awaited<ReturnType<typeof getBusiness>>; from: string; to: string }) {
  const loaded = await Promise.all(months.map(async (m) => ({ month: m, ...(await loadReport(business, m)) })));
  const plans = loaded.map((l) => ({ month: l.month, status: l.status, report: l.report }));
  const problems = problemsFor(plans, new Date(), business.timezone, new Set());
  const hard = problems.filter((p) => p.kind !== "unacknowledged"); // can't be fixed by ticking a box
  const hardBy = new Map(hard.map((p) => [p.month, p]));
  const net = loaded.reduce((a, l) => a + l.report.netIncomeCents, 0);
  const toLock = loaded.filter((l) => l.status !== "LOCKED").length;

  return (
    <>
      <h2>{monthLabel(from, true)} to {monthLabel(to, true)}</h2>
      {hard.length ? (
        <section className="alert alert-bad" role="alert">
          <strong>Can&rsquo;t lock these yet</strong>
          {hard.map((p) => <p key={p.month}><strong>{monthLabel(p.month, true)}:</strong> {p.message}{p.kind === "unreviewed" ? <> <Link href={`/admin/review?month=${p.month}`}>Review it</Link></> : null}</p>)}
          <p>Nothing will be locked until every month can be.</p>
        </section>
      ) : null}

      <ul className="stack list-plain">
        {loaded.map((l) => {
          const warnings = l.report.warnings;
          const block = hardBy.get(l.month);
          return (
            <li key={l.month}>
              <section className="card" aria-labelledby={`m-${l.month}`}>
                <div className="row-between">
                  <h3 id={`m-${l.month}`}>{monthLabel(l.month, true)}</h3>
                  <span className={`badge ${l.status === "LOCKED" ? "badge-ok" : block ? "badge-bad" : "badge-neutral"}`}>{l.status === "LOCKED" ? "Already locked" : block ? "Blocked" : "Draft"}</span>
                </div>
                <dl className="kv">
                  <div><dt>Gross Revenue</dt><dd>{formatCents(l.report.revenue.grossRevenueCents)}</dd></div>
                  <div><dt>Total Expenses</dt><dd>{formatCents(l.report.expenses.totalCents)}</dd></div>
                  <div className="kv-main"><dt>Net Income</dt><dd>{formatCents(l.report.netIncomeCents)}</dd></div>
                </dl>
                {l.status === "LOCKED" ? <p className="small muted">Already locked: it is left as it is and its tab is written again from the saved numbers.</p> : null}
                {warnings.length ? (
                  <div className="alert alert-warn" role="status">
                    <strong>{warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`}</strong>
                    {warnings.map((w) => <p key={w}>{w}</p>)}
                  </div>
                ) : l.status !== "LOCKED" ? <p className="small muted">No warnings.</p> : null}
                {l.status !== "LOCKED" && warnings.length && !block ? (
                  <label className="toggle" form="file-form">
                    <input type="checkbox" name="ack" value={l.month} form="file-form" required />
                    <span>I&rsquo;ve read the warnings for {monthLabel(l.month)}.</span>
                  </label>
                ) : null}
                {unreviewedCount(l.report) ? <p className="small muted">Unreviewed bank transactions are not in Net Income.</p> : null}
              </section>
            </li>
          );
        })}
      </ul>

      <section className="card" aria-label="Confirm">
        <dl className="kv"><div className="kv-main"><dt>Net Income, {loaded.length} months</dt><dd>{formatCents(net)}</dd></div></dl>
        <form id="file-form" action={fileMonthsAction} className="stack">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <p className="small muted">This locks {toLock} month{toLock === 1 ? "" : "s"} and writes {loaded.length} tab{loaded.length === 1 ? "" : "s"} plus the YTD Summary to the real workbook. It sends <strong>no email</strong>. Locking can&rsquo;t be undone.</p>
          <button type="submit" className="btn btn-primary" disabled={hard.length > 0}>
            Lock {toLock} month{toLock === 1 ? "" : "s"} and file {loaded.length === 1 ? "it" : "them"} (no email)
          </button>
        </form>
      </section>
    </>
  );
}
