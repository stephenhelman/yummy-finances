import type { Metadata } from "next";
import Link from "next/link";
import { ClassifyForm } from "@/components/review/classify-form";
import { LockedNote, Notice, PendingNotice, TxnDetails } from "@/components/review/txn-card";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { monthLabel } from "@/lib/format";
import { classificationIsReady } from "@/lib/review/gate";
import { prismaClassifyStore } from "@/lib/review/prisma-store";
import { loadCategories, loadTxnViews } from "@/lib/review/queries";
import { describeUndo } from "@/lib/review/service";
import { monthCounts, pickNext, queueSince, reviewMonth, reviewQueue } from "@/lib/review/view";
import { formatCents } from "@/lib/money";
import { undoAction } from "./actions";

export const metadata: Metadata = { title: "Review" };

type Params = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ReviewPage({ searchParams }: { searchParams: Params }) {
  const { actor } = await requireAdmin();
  const business = await getBusiness();
  const sp = await searchParams;

  if (!(await classificationIsReady(business.id))) {
    return (
      <>
        <h1>Review</h1>
        <PendingNotice />
      </>
    );
  }

  const [all, categories] = await Promise.all([loadTxnViews(db, business.id, { reviewOnly: true }), loadCategories(db, business.id)]);
  const cur = currentMonth(new Date(), business.timezone);
  const queue = reviewQueue(all, queueSince(cur));
  const counts = monthCounts(queue);
  const month = reviewMonth(counts, one(sp.month), cur);
  const items = queue.filter((t) => t.month === month);
  const txn = pickNext(items, one(sp.after));
  const undo = await describeUndo(prismaClassifyStore(db, business.id, actor));
  const here = `/admin/review?month=${month}`;
  const otherMonth = counts.find((c) => c.month !== month);
  const chips = counts.some((c) => c.month === month) ? counts : [{ month, count: 0, cents: 0 }, ...counts];

  return (
    <>
      <h1>Review</h1>
      <Notice notice={one(sp.notice)} error={one(sp.error)} />

      {chips.length ? (
        <nav className="chips" aria-label="Month">
          {chips.map((c) => (
            <Link key={c.month} href={`/admin/review?month=${c.month}`} className="chip-link" aria-current={c.month === month ? "page" : undefined}>
              {monthLabel(c.month)} <span className="num">{c.count}</span>
            </Link>
          ))}
        </nav>
      ) : null}

      {txn ? (
        <>
          <p className="muted" aria-live="polite">
            <strong className="num">{items.length}</strong> left in {monthLabel(month, true)}
          </p>
          <section className="card" aria-label="Transaction to review">
            <TxnDetails txn={txn} />
            {txn.locked ? <LockedNote /> : <ClassifyForm txn={txn} categories={categories} returnTo={here} />}
          </section>
          <div className="row-between">
            {items.length > 1 ? (
              <Link href={`${here}&after=${txn.id}`} className="btn btn-ghost">Skip for now</Link>
            ) : (
              <span />
            )}
            {undo ? (
              <form action={undoAction}>
                <input type="hidden" name="returnTo" value={here} />
                <button type="submit" className="btn btn-ghost" title={undo.label}>Undo last</button>
              </form>
            ) : null}
          </div>
          {undo ? <p className="small muted">Last: {undo.label}</p> : null}
        </>
      ) : (
        <section className="card">
          <h2>All caught up for {monthLabel(month, true)}</h2>
          <p className="muted">Nothing left to review this month.</p>
          {otherMonth ? (
            <p>
              <Link href={`/admin/review?month=${otherMonth.month}`} className="btn btn-primary">
                Go to {monthLabel(otherMonth.month)} ({otherMonth.count} left, {formatCents(otherMonth.cents)})
              </Link>
            </p>
          ) : null}
          {undo ? (
            <form action={undoAction}>
              <input type="hidden" name="returnTo" value={here} />
              <button type="submit" className="btn btn-ghost">Undo last: {undo.label}</button>
            </form>
          ) : null}
        </section>
      )}
    </>
  );
}
