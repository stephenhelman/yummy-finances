import Link from "next/link";
import { ConnectButton } from "@/app/admin/connections/connect-button";
import { checkClover, hasSales, type BankCardState } from "@/lib/dashboard";
import { LOCAL_SALES_TAX_RATE_LABEL, formatDateTime, monthLabel, percent } from "@/lib/format";
import { formatCents } from "@/lib/money";
import type { RevenueResult } from "@/lib/revenue";

export function CloverCardSkeleton() {
  return (
    <section className="card" aria-busy="true" aria-label="Clover, checking connection">
      <div className="skeleton" style={{ width: "40%", height: 20 }} />
      <div className="skeleton" style={{ width: "70%" }} />
      <div className="skeleton" style={{ width: "55%" }} />
    </section>
  );
}

/** Streams in after the page: it makes a live call to Clover. */
export async function CloverCard({ lastSyncedAt, timezone }: { lastSyncedAt: Date | null; timezone: string }) {
  const clover = await checkClover();
  return (
    <section className="card" aria-labelledby="clover-h">
      <div className="card-title">
        <h2 id="clover-h">Clover</h2>
        <span className={`badge ${clover.ok ? "badge-ok" : "badge-bad"}`}>{clover.ok ? "Connected" : "Problem"}</span>
      </div>
      {clover.ok ? <p>{clover.name}</p> : <p className="alert alert-bad" role="alert">{clover.message}</p>}
      <p className="small muted">{lastSyncedAt ? `Last synced ${formatDateTime(lastSyncedAt, timezone)}` : "Not synced yet. Tap Sync now below."}</p>
    </section>
  );
}

export function BankCard({ bank, timezone }: { bank: BankCardState; timezone: string }) {
  return (
    <section className="card" aria-labelledby="bank-h">
      <div className="card-title">
        <h2 id="bank-h">Bank</h2>
        {bank.kind === "connected" ? <BankBadge status={bank.status} /> : <span className="badge badge-neutral">Not connected</span>}
      </div>

      {bank.kind === "none" ? (
        <>
          <p>Connect the business bank account so expenses can be pulled in automatically.</p>
          <Link href="/admin/connections" className="btn btn-primary">Connect your bank</Link>
        </>
      ) : null}

      {bank.kind === "config_error" ? <p className="alert alert-bad" role="alert">{bank.message}</p> : null}

      {bank.kind === "unusable" ? (
        <div className="alert alert-bad" role="alert">
          <strong>{bank.institution ?? "This bank"} can&rsquo;t be used here</strong>
          <p>{bank.message}</p>
        </div>
      ) : null}

      {bank.kind === "connected" ? (
        <>
          <p>{bank.institution ?? "Your bank"}</p>
          <p className="small muted">{bank.lastSyncAt ? `Last synced ${formatDateTime(bank.lastSyncAt, timezone)}` : "Not synced yet. Tap Sync now below."}</p>
          {bank.status === "LOGIN_REQUIRED" ? (
            <div className="alert alert-warn" role="alert">
              <strong>Your bank needs you to sign in again</strong>
              <p>New transactions are paused until you reconnect. It takes about a minute.</p>
              <ConnectButton mode="reconnect" label="Reconnect" />
            </div>
          ) : null}
          {bank.status === "PENDING_EXPIRATION" ? (
            <div className="alert alert-warn" role="status">
              <strong>Your bank&rsquo;s permission expires soon</strong>
              <p>Reconnect now so syncing doesn&rsquo;t stop.</p>
              <ConnectButton mode="reconnect" label="Reconnect" />
            </div>
          ) : null}
          {bank.status === "ERROR" ? (
            <p className="alert alert-bad" role="alert">
              There&rsquo;s a problem on the bank&rsquo;s side{bank.errorCode ? ` (${bank.errorCode})` : ""}. It usually clears up on its own.{" "}
              <Link href="/admin/connections">Details</Link>
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function BankBadge({ status }: { status: "OK" | "LOGIN_REQUIRED" | "PENDING_EXPIRATION" | "ERROR" }) {
  if (status === "OK") return <span className="badge badge-ok">Connected</span>;
  if (status === "ERROR") return <span className="badge badge-bad">Problem</span>;
  return <span className="badge badge-warn">Needs attention</span>;
}

export function RevenueCard({ title, subtitle, revenue }: { title: string; subtitle: string; revenue: RevenueResult }) {
  return (
    <section className="card" aria-labelledby={`rev-${revenue.month}`}>
      <div>
        <h2 id={`rev-${revenue.month}`}>{title}</h2>
        <p className="small muted">{subtitle}</p>
      </div>
      {hasSales(revenue) ? (
        <>
          <dl className="kv">
            <div className="kv-main"><dt>Net sales</dt><dd>{formatCents(revenue.netSales.total)}</dd></div>
            <div><dt>Card</dt><dd>{formatCents(revenue.netSales.card)}</dd></div>
            <div><dt>Cash</dt><dd>{formatCents(revenue.netSales.cash)}</dd></div>
            <div><dt>Refunds</dt><dd>{formatCents(revenue.refunds.total)}</dd></div>
          </dl>
          <p className="small muted">Net sales are sales minus refunds, before sales tax and tips.</p>
        </>
      ) : (
        <p className="muted">No sales synced for {monthLabel(revenue.month)} yet. Tap Sync now below.</p>
      )}
    </section>
  );
}

/** Plain-language tax note for the owner. Shown when either month's effective rate looks too high. */
export function TaxNote({ months }: { months: RevenueResult[] }) {
  const flagged = months.filter((m) => m.warnings.some((w) => w.code === "HIGH_EFFECTIVE_TAX_RATE") && m.effectiveTaxRate !== null);
  if (!flagged.length) return null;
  return (
    <section className="alert alert-warn" role="status" aria-label="Sales tax check">
      <strong>Sales tax looks high</strong>
      {flagged.map((m) => (
        <p key={m.month}>
          {flagged.length > 1 ? `${monthLabel(m.month)}: ` : ""}Sales tax collected is {percent(m.effectiveTaxRate!)} of sales; El Paso&rsquo;s rate is {LOCAL_SALES_TAX_RATE_LABEL}.
        </p>
      ))}
      <p>Ask your accountant to review your Clover tax settings.</p>
    </section>
  );
}
