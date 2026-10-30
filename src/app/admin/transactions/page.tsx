import type { Metadata } from "next";
import Link from "next/link";
import { ClassifyForm } from "@/components/review/classify-form";
import { CurrentClassification, LockedNote, Notice, PendingNotice, TxnDetails } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { monthLabel } from "@/lib/format";
import { formatCents } from "@/lib/money";
import { classificationIsReady } from "@/lib/review/gate";
import { loadAccounts, loadCategories, loadTxnViews } from "@/lib/review/queries";
import { chipLabel, dayLabel, filterTxns, isUnconfirmed, kindLabel } from "@/lib/review/view";
import { KINDS } from "@/lib/rules/types";

export const metadata: Metadata = { title: "Transactions" };

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export default async function TransactionsPage({ searchParams }: { searchParams: Params }) {
  await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;

  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>Transactions</h1>
        <PendingNotice />
      </>
    );
  }

  const cur = currentMonth(new Date(), business.timezone);
  const requested = one(sp.month);
  const month = requested && MONTH.test(requested) ? requested : cur;
  const [rows, categories, accounts] = await Promise.all([loadTxnViews(db, business.id, { month }), loadCategories(db, business.id), loadAccounts(db, business.id)]);

  const status = one(sp.show); // review | unconfirmed
  const filter = { needsReview: status === "review", unconfirmed: status === "unconfirmed", kind: one(sp.kind), categoryId: one(sp.category), accountId: one(sp.account), q: one(sp.q) };
  const list = filterTxns(rows, filter);
  const filtersOn = !!(status || filter.kind || filter.categoryId || filter.accountId);

  // The list's own URL (without the sheet or one-shot messages): where the sheet closes to and actions return to.
  const base = new URLSearchParams();
  base.set("month", month);
  for (const [k, v] of [["show", status], ["kind", filter.kind], ["category", filter.categoryId], ["account", filter.accountId], ["q", filter.q]] as const) if (v) base.set(k, v);
  const listUrl = `/admin/transactions?${base}`;
  const editId = one(sp.edit);
  const editing = editId ? rows.find((r) => r.id === editId) ?? null : null;

  const months = monthOptions(cur, month);

  return (
    <>
      <h1>Transactions</h1>
      <Notice notice={one(sp.notice)} error={one(sp.error)} />

      <form method="get" action="/admin/transactions" className="card stack" role="search">
        <div className="filter-row">
          <div className="field">
            <label htmlFor="f-month">Month</label>
            <select id="f-month" name="month" className="input" defaultValue={month}>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m, true)}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="f-q">Search</label>
            <input id="f-q" name="q" type="search" className="input" defaultValue={filter.q ?? ""} placeholder="Merchant or description" />
          </div>
        </div>
        <details className="more" open={filtersOn}>
          <summary className="btn btn-secondary btn-block">Filters{filtersOn ? " (on)" : ""}</summary>
          <div className="stack more-body">
            <div className="field">
              <label htmlFor="f-show">Show</label>
              <select id="f-show" name="show" className="input" defaultValue={status ?? ""}>
                <option value="">Everything</option>
                <option value="review">Needs review</option>
                <option value="unconfirmed">Unconfirmed rule</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-kind">Kind</label>
              <select id="f-kind" name="kind" className="input" defaultValue={filter.kind ?? ""}>
                <option value="">Any</option>
                {KINDS.map((k) => <option key={k} value={k}>{kindLabel(k)}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" name="category" className="input" defaultValue={filter.categoryId ?? ""}>
                <option value="">Any</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-acct">Account</label>
              <select id="f-acct" name="account" className="input" defaultValue={filter.accountId ?? ""}>
                <option value="">Any</option>
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          </div>
        </details>
        <div className="row">
          <button type="submit" className="btn btn-primary">Apply</button>
          {filtersOn || filter.q ? <Link href={`/admin/transactions?month=${month}`} className="btn btn-ghost">Clear</Link> : null}
        </div>
      </form>

      <p className="small muted" aria-live="polite">
        {list.length} {list.length === 1 ? "transaction" : "transactions"} in {monthLabel(month, true)}
      </p>

      {list.length ? (
        <ul className="txn-list">
          {list.map((t) => (
            <li key={t.id}>
              <Link href={`${listUrl}&edit=${t.id}`} className="txn-row" prefetch={false}>
                <span className="txn-main">
                  <span className="txn-merchant">{t.merchant}</span>
                  <span className="small muted">{dayLabel(t.date)} · {t.account}</span>
                </span>
                <span className="txn-side">
                  <span className={`num txn-amount ${t.direction === "in" ? "dir-in" : ""}`}>{t.direction === "in" ? "+" : ""}{formatCents(Math.abs(t.amountCents))}</span>
                  <span className={`chip ${t.reviewStatus === "NEEDS_REVIEW" ? "chip-warn" : ""}`}>{chipLabel(t)}</span>
                  {isUnconfirmed(t) ? <span className="chip chip-warn">Unconfirmed</span> : null}
                  {t.locked ? <span className="chip chip-neutral">Locked</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <section className="card"><p className="muted">Nothing matches.</p></section>
      )}

      {editing ? (
        <>
          <Link href={listUrl} className="sheet-backdrop" aria-label="Close" prefetch={false} />
          <section className="sheet" role="dialog" aria-modal="true" aria-label="Edit transaction">
            <div className="row-between">
              <h2>Edit</h2>
              <Link href={listUrl} className="btn btn-ghost btn-sm" prefetch={false}>Close</Link>
            </div>
            <TxnDetails txn={editing} />
            <CurrentClassification txn={editing} />
            {editing.locked ? <LockedNote /> : <ClassifyForm txn={editing} categories={categories} returnTo={listUrl} />}
          </section>
        </>
      ) : null}
    </>
  );
}

/** Months to offer: Jan of the current year through now, plus the selected one. Newest first. */
function monthOptions(cur: string, selected: string): string[] {
  const year = cur.slice(0, 4);
  const set = new Set<string>([selected]);
  for (let m = 1; m <= Number(cur.slice(5)); m++) set.add(`${year}-${String(m).padStart(2, "0")}`);
  return [...set].sort().reverse();
}
