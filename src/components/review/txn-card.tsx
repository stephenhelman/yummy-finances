import { formatCents } from "@/lib/money";
import { chipLabel, dayLabel, isUnconfirmed, kindLabel, type TxnView } from "@/lib/review/view";

/** What the transaction is: date, merchant, amount, direction, account, the bank's own text, Plaid's guess. */
export function TxnDetails({ txn }: { txn: TxnView }) {
  return (
    <div className="stack">
      <div className="row-between small muted">
        <span>{dayLabel(txn.date)}</span>
        <span>{txn.account}</span>
      </div>
      <div>
        <p className="amount num">{formatCents(Math.abs(txn.amountCents))}</p>
        <p className="small"><span className={`dir ${txn.direction === "out" ? "dir-out" : "dir-in"}`}>{txn.direction === "out" ? "Money out" : "Money in"}</span></p>
      </div>
      <h2 className="merchant">{txn.merchant}</h2>
      <details className="raw">
        <summary>Bank&rsquo;s description</summary>
        <p>{txn.raw}</p>
      </details>
      {txn.hint ? <p className="small faint">Plaid&rsquo;s guess: {txn.hint}</p> : null}
    </div>
  );
}

/** Where the current classification came from, for the edit sheet. */
export function CurrentClassification({ txn }: { txn: TxnView }) {
  if (txn.reviewStatus === "NEEDS_REVIEW") return <p className="small muted">Not categorized yet.</p>;
  const why =
    txn.categorySource === "MANUAL" ? "You chose this" : txn.categorySource === "PAIR" ? "Matched with the other side of a transfer" : txn.ruleName ? `Rule: ${txn.ruleName}` : "Automatic";
  return (
    <div className="stack">
      <p>
        <span className="chip">{chipLabel(txn)}</span> {txn.categoryName ? <span className="small muted">{kindLabel(txn.kind)}</span> : null}
      </p>
      <p className="small muted">{why}{isUnconfirmed(txn) ? ". Not confirmed yet." : ""}</p>
    </div>
  );
}

export function LockedNote() {
  return (
    <p className="alert alert-warn" role="status">
      <strong>This month is locked</strong>
      Locked months are read-only, so this can&rsquo;t be changed.
    </p>
  );
}

export function Notice({ notice, error }: { notice?: string; error?: string }) {
  if (error) return <p className="alert alert-bad" role="alert">{error}</p>;
  if (notice) return <p className="alert alert-ok" role="status">{notice}</p>;
  return null;
}

export function PendingNotice() {
  return (
    <section className="card">
      <h2>Not categorized yet</h2>
      <p className="muted">Transactions haven&rsquo;t been run through the rules yet, so there is nothing reliable to show here. This fills in after the rules release has run.</p>
    </section>
  );
}
