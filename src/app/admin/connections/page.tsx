import type { Metadata } from "next";
import { getBusiness, requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatDateTime } from "@/lib/format";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { resolvePlaidEnv } from "@/lib/plaid-config";
import { RECONNECT_STATUSES } from "@/lib/plaid-health";
import { getLastSyncSummary } from "@/lib/sync-now";
import { setAccountIncluded } from "./actions";
import { CheckHealthButton, ConnectButton } from "./connect-button";
import { SyncNowButton } from "./sync-now-button";

export const metadata: Metadata = { title: "Connections" };

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad"; help: string }> = {
  OK: { label: "Connected", tone: "ok", help: "Your bank is connected." },
  LOGIN_REQUIRED: { label: "Sign in again", tone: "warn", help: "Your bank needs you to sign in again before more transactions can be pulled." },
  PENDING_EXPIRATION: { label: "Reconnect soon", tone: "warn", help: "Your bank's permission is about to expire. Reconnect to keep syncing." },
  ERROR: { label: "Problem", tone: "bad", help: "There's a problem on the bank's side. This usually clears up on its own." },
};

export default async function ConnectionsPage() {
  await requireAdmin();
  const business = await getBusiness();

  let env: string;
  let envError: string | null = null;
  try {
    env = resolvePlaidEnv();
  } catch (e) {
    env = "unavailable";
    envError = (e as Error).message;
  }

  const item = await db.plaidItem.findFirst({
    where: { businessId: business.id, environment: env },
    include: { accounts: { orderBy: { name: "asc" } } },
  });
  // Expected after copying a DB between environments: rows from another Plaid environment, or
  // encrypted with another key. Say so plainly instead of failing.
  const otherEnvItems = envError ? [] : await db.plaidItem.findMany({ where: { businessId: business.id, environment: { not: env } }, select: { environment: true, institutionName: true } });
  let problem: string | null = null;
  if (item) {
    try {
      unlockItemToken(item, env);
    } catch (e) {
      if (e instanceof PlaidItemUnusableError) problem = e.message;
      else throw e;
    }
  }
  const needsReconnect = !problem && !!item && RECONNECT_STATUSES.includes(item.status);
  const status = item ? STATUS[item.status] : null;
  const lastSync = await getLastSyncSummary(business.id);

  return (
    <>
      <h1>Connections</h1>

      <section className="card" aria-labelledby="bank-h">
        <div className="card-title">
          <h2 id="bank-h">Bank</h2>
          {item && !problem && status ? <span className={`badge badge-${status.tone}`}>{status.label}</span> : null}
        </div>
        <p className="small muted">Plaid environment: {env}</p>
        {envError ? <p role="alert" className="alert alert-bad">{envError}</p> : null}
        {otherEnvItems.length ? (
          <p className="small muted">
            Not used here: {otherEnvItems.map((o) => `${o.institutionName ?? "a bank"} (${o.environment})`).join(", ")} belongs to another Plaid environment.
          </p>
        ) : null}

        {item ? (
          <div className="stack">
            <div>
              <h3>{item.institutionName ?? "Your bank"}</h3>
              <p className="small muted">
                Connected {formatDateTime(item.createdAt, business.timezone)}
                {item.lastSyncAt ? ` · last synced ${formatDateTime(item.lastSyncAt, business.timezone)}` : ""}
                {item.lastErrorCode ? ` · ${item.lastErrorCode}` : ""}
              </p>
            </div>
            {problem ? (
              <div className="alert alert-bad" role="alert"><strong>This connection can&rsquo;t be used here</strong><p>{problem}</p></div>
            ) : status ? (
              <p>{status.help}</p>
            ) : null}
            {problem ? null : needsReconnect ? <ConnectButton mode="reconnect" /> : <div><CheckHealthButton /></div>}

            <h3>Accounts</h3>
            <p className="small muted">
              {needsReconnect ? "You can change these again once the bank is reconnected." : "Only accounts marked “synced” are used for your numbers."}
            </p>
            <ul className="list">
              {item.accounts.map((a) => (
                <li key={a.id}>
                  <div className="grow">
                    <div>{a.name}{a.mask ? ` ••••${a.mask}` : ""}</div>
                    <div className="small muted">{a.subtype ?? a.type} · {a.included ? "synced" : "not synced"}</div>
                  </div>
                  {needsReconnect ? null : (
                    <form action={setAccountIncluded}>
                      <input type="hidden" name="accountId" value={a.id} />
                      <input type="hidden" name="included" value={a.included ? "false" : "true"} />
                      <button type="submit" className="btn btn-secondary btn-sm">{a.included ? "Stop syncing" : "Sync"}</button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : envError ? null : (
          <div className="stack">
            <p>Connect the business bank account so expenses can be pulled in automatically.</p>
            <ConnectButton />
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="sync-h">
        <h2 id="sync-h">Sync now</h2>
        <p className="small muted">Pulls the latest bank transactions and this month&rsquo;s Clover sales (plus the two months before it).</p>
        <SyncNowButton last={lastSync} />
      </section>
    </>
  );
}
