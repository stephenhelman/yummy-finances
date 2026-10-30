import { db } from "@/lib/db";
import { currentMonth } from "@/lib/dates";
import { checkItemHealth, getPlaid, plaidErrorSummary, refreshAccounts } from "@/lib/plaid";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { applyRules, type ApplyResult } from "@/lib/rules/apply";
import { prismaRulesStore } from "@/lib/rules/prisma-store";
import {
  isReportable,
  lateAdjustment,
  mapPlaidTransaction,
  txnChanged,
  type ExistingTxn,
  type LateFields,
  type PlaidTxnInput,
  type TxnRow,
} from "@/lib/plaid/map";

export { isReportable };

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type PlaidPage = {
  added: PlaidTxnInput[];
  modified: PlaidTxnInput[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
};
export type FetchPage = (cursor: string) => Promise<PlaidPage>;

type Event = { t: "upsert"; txn: PlaidTxnInput } | { t: "remove"; id: string };

export type CreateRow = TxnRow & { accountId: string } & Partial<LateFields>;
export type UpdateRow = { plaidTransactionId: string; row: Omit<TxnRow, "accountPlaidId">; late?: LateFields };
export type WriteOp =
  | { type: "create"; rows: CreateRow[] }
  | { type: "update"; rows: UpdateRow[] }
  | { type: "remove"; rows: { plaidTransactionId: string; late?: LateFields }[]; at: Date }
  | { type: "supersede"; ids: string[]; at: Date }
  | { type: "audit"; entries: { entityId: string; message: string }[] };

/** Persistence seam. Every `apply` call is one atomic DB transaction. The cursor only moves in commitCursor. */
export interface SyncStore {
  accountIds(): Promise<Map<string, string>>; // plaidAccountId -> BankAccount.id
  refreshAccounts(): Promise<void>;
  loadExisting(ids: string[]): Promise<Map<string, ExistingTxn>>;
  lockedMonths(months: string[]): Promise<Set<string>>;
  apply(op: WriteOp): Promise<void>;
  commitCursor(cursor: string, at: Date): Promise<void>;
}

export type SyncCounts = {
  apiAdded: number;
  apiModified: number;
  apiRemoved: number;
  created: number;
  updated: number;
  unchanged: number;
  removed: number;
  superseded: number;
  late: number;
  audited: number;
};

export type SyncOutcome =
  | { status: "not_ready" }
  | {
      status: "synced";
      counts: SyncCounts;
      pages: number;
      restarts: number;
      nextCursor: string;
      /** Result of categorizing the new/changed rows (absent when no hook was given or nothing changed). */
      rules?: ApplyResult;
      /** Categorizing failed. The sync itself succeeded (its cursor is committed); the next sync retries. */
      rulesError?: string;
    };

const MUTATION = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";
const MAX_PAGES = 1000;
export const isMutationError = (e: unknown) =>
  (e as { response?: { data?: { error_code?: string } } })?.response?.data?.error_code === MUTATION;

// ---------------------------------------------------------------------------------------------
// 1. Fetch every page of updates (no DB writes happen here)
// ---------------------------------------------------------------------------------------------

type Fetched =
  | { kind: "not_ready" }
  | { kind: "ready"; events: Event[]; nextCursor: string; pages: number; restarts: number; api: { added: number; modified: number; removed: number } };

/**
 * Loops until has_more is false. If the underlying data mutates mid-pagination, everything fetched so
 * far is discarded and the loop restarts from the cursor held at the start (retrying only the failed
 * page is not valid per Plaid).
 */
export async function fetchAllUpdates(fetchPage: FetchPage, startCursor: string, maxRestarts = 3): Promise<Fetched> {
  for (let restarts = 0; ; restarts++) {
    const events: Event[] = [];
    const api = { added: 0, modified: 0, removed: 0 };
    let cursor = startCursor;
    let pages = 0;
    try {
      for (;;) {
        if (++pages > MAX_PAGES) throw new Error("transactions/sync pagination did not terminate");
        const page = await fetchPage(cursor);
        const empty = !page.added.length && !page.modified.length && !page.removed.length;
        if (!page.next_cursor) {
          if (page.has_more) throw new Error("Plaid returned has_more without a cursor");
          if (empty) return { kind: "not_ready" }; // data isn't ready yet: no transactions, empty cursor
        }
        for (const t of page.added) events.push({ t: "upsert", txn: t });
        for (const t of page.modified) events.push({ t: "upsert", txn: t });
        for (const r of page.removed) events.push({ t: "remove", id: r.transaction_id });
        api.added += page.added.length;
        api.modified += page.modified.length;
        api.removed += page.removed.length;
        cursor = page.next_cursor || cursor;
        if (!page.has_more) return { kind: "ready", events, nextCursor: cursor, pages, restarts, api };
      }
    } catch (e) {
      if (isMutationError(e) && restarts < maxRestarts) continue;
      throw e;
    }
  }
}

/** Net effect per transaction id after replaying events in order (e.g. added then removed = removed). */
function collapse(events: Event[]) {
  const last = new Map<string, Event>();
  for (const ev of events) {
    const id = ev.t === "upsert" ? ev.txn.transaction_id : ev.id;
    last.delete(id); // keep insertion order = order of the final event
    last.set(id, ev);
  }
  return [...last.values()];
}

const chunks = <T>(xs: readonly T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

// ---------------------------------------------------------------------------------------------
// 2. Plan and apply
// ---------------------------------------------------------------------------------------------

/**
 * Fetches all updates, plans the writes, applies them in chunks, and ONLY THEN advances the cursor.
 * Writes are idempotent (create skips duplicates, updates only differ when data differs), so if a
 * chunk fails the cursor stays put and the next run converges to the same state.
 */
export async function runSync(args: {
  startCursor: string;
  fetchPage: FetchPage;
  store: SyncStore;
  now: Date;
  openMonth: string;
  chunkSize?: number;
  maxRestarts?: number;
  /**
   * Called after the cursor is committed with the Plaid ids of every row this sync created, changed or removed,
   * to categorize them (and re-pair within the 5-day window). A failure here never fails the sync.
   */
  afterCommit?: (plaidTransactionIds: string[]) => Promise<ApplyResult>;
}): Promise<SyncOutcome> {
  const { startCursor, fetchPage, store, now, openMonth } = args;
  const size = args.chunkSize ?? 200;

  const fetched = await fetchAllUpdates(fetchPage, startCursor, args.maxRestarts);
  if (fetched.kind === "not_ready") return { status: "not_ready" };

  const net = collapse(fetched.events);
  const upserts = net.filter((e): e is Extract<Event, { t: "upsert" }> => e.t === "upsert").map((e) => mapPlaidTransaction(e.txn));
  const removeIds = net.filter((e): e is Extract<Event, { t: "remove" }> => e.t === "remove").map((e) => e.id);

  const existing = await store.loadExisting([
    ...new Set([...upserts.map((u) => u.plaidTransactionId), ...removeIds, ...upserts.map((u) => u.pendingTransactionId).filter((x): x is string => !!x)]),
  ]);

  // Every account must be known (FK). A new account at the bank is picked up by one refresh.
  let accountIds = await store.accountIds();
  if (upserts.some((u) => !accountIds.has(u.accountPlaidId))) {
    await store.refreshAccounts();
    accountIds = await store.accountIds();
    const missing = upserts.find((u) => !accountIds.has(u.accountPlaidId));
    if (missing) throw new Error(`Transaction references unknown account ${missing.accountPlaidId}`);
  }

  const months = new Set<string>();
  for (const u of upserts) months.add(u.date.slice(0, 7));
  for (const e of existing.values()) months.add(e.date.slice(0, 7));
  const locked = await store.lockedMonths([...months]);

  const creates: CreateRow[] = [];
  const updates: UpdateRow[] = [];
  const removes: { plaidTransactionId: string; late?: LateFields }[] = [];
  const audits: { entityId: string; message: string }[] = [];
  const supersedeIds = new Set<string>();
  let unchanged = 0, late = 0;
  // Pending rows arriving in this same run can be superseded in it too.
  const upsertIds = new Set(upserts.map((u) => u.plaidTransactionId));

  const decide = (prev: ExistingTxn | null, next: Parameters<typeof lateAdjustment>[0]["next"], id: string): LateFields | undefined => {
    const d = lateAdjustment({ existing: prev, next, lockedMonths: locked, openMonth });
    if (!d) return undefined;
    if ("audit" in d) {
      audits.push({ entityId: id, message: d.audit });
      return undefined;
    }
    late++;
    return d.late;
  };

  for (const u of upserts) {
    const prev = existing.get(u.plaidTransactionId) ?? null;
    if (!prev) {
      const lateFields = decide(null, u, u.plaidTransactionId);
      creates.push({ ...u, accountId: accountIds.get(u.accountPlaidId)!, ...lateFields });
    } else if (txnChanged(prev, u) || prev.removedAt) {
      const lateFields = decide(prev, u, u.plaidTransactionId);
      const { accountPlaidId: _unused, ...row } = u;
      void _unused;
      updates.push({ plaidTransactionId: u.plaidTransactionId, row, late: lateFields });
    } else {
      unchanged++;
    }
    // A posted row replaces its pending counterpart.
    if (!u.pending && u.pendingTransactionId) {
      const pend = existing.get(u.pendingTransactionId);
      if ((pend && !pend.supersededAt) || (!pend && upsertIds.has(u.pendingTransactionId))) supersedeIds.add(u.pendingTransactionId);
    }
  }
  for (const id of removeIds) {
    const prev = existing.get(id);
    if (!prev || prev.removedAt) continue; // never seen, or already removed
    removes.push({ plaidTransactionId: id, late: decide(prev, "removed", id) });
  }

  // Apply. Order: creates before supersedes (a pending row created in this run can be superseded in it).
  for (const rows of chunks(creates, size)) await store.apply({ type: "create", rows });
  for (const rows of chunks(updates, Math.min(size, 100))) await store.apply({ type: "update", rows });
  for (const rows of chunks(removes, Math.min(size, 100))) await store.apply({ type: "remove", rows, at: now });
  for (const ids of chunks([...supersedeIds], size)) await store.apply({ type: "supersede", ids, at: now });
  for (const entries of chunks(audits, size)) await store.apply({ type: "audit", entries });

  await store.commitCursor(fetched.nextCursor, now); // last, and only after every chunk committed

  // Categorize what changed. The data is already safely stored, so this cannot fail the sync.
  let rules: ApplyResult | undefined;
  let rulesError: string | undefined;
  const touched = [...new Set([...creates.map((r) => r.plaidTransactionId), ...updates.map((u) => u.plaidTransactionId), ...removes.map((r) => r.plaidTransactionId)])];
  if (args.afterCommit && touched.length) {
    try {
      rules = await args.afterCommit(touched);
    } catch (e) {
      rulesError = e instanceof Error ? e.message : "categorizing failed";
    }
  }

  return {
    status: "synced",
    pages: fetched.pages,
    restarts: fetched.restarts,
    nextCursor: fetched.nextCursor,
    ...(rules ? { rules } : {}),
    ...(rulesError ? { rulesError } : {}),
    counts: {
      apiAdded: fetched.api.added,
      apiModified: fetched.api.modified,
      apiRemoved: fetched.api.removed,
      created: creates.length,
      updated: updates.length,
      unchanged,
      removed: removes.length,
      superseded: supersedeIds.size,
      late,
      audited: audits.length,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// 3. Prisma store + item-level entry point
// ---------------------------------------------------------------------------------------------

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const toDay = (d: Date) => d.toISOString().slice(0, 10);

function prismaStore(item: { id: string; businessId: string }): SyncStore {
  return {
    async accountIds() {
      const rows = await db.bankAccount.findMany({ where: { plaidItemId: item.id }, select: { id: true, plaidAccountId: true } });
      return new Map(rows.map((r) => [r.plaidAccountId, r.id]));
    },
    async refreshAccounts() {
      await refreshAccounts(item.id);
    },
    async loadExisting(ids) {
      const out = new Map<string, ExistingTxn>();
      for (const part of chunks(ids, 1000)) {
        const rows = await db.bankTransaction.findMany({ where: { businessId: item.businessId, plaidTransactionId: { in: part } }, include: { account: { select: { plaidAccountId: true } } } });
        for (const r of rows) {
          out.set(r.plaidTransactionId, {
            plaidTransactionId: r.plaidTransactionId,
            accountPlaidId: r.account.plaidAccountId,
            pendingTransactionId: r.pendingTransactionId,
            pending: r.pending,
            date: toDay(r.date),
            authorizedDate: r.authorizedDate ? toDay(r.authorizedDate) : null,
            amountCents: r.amountCents,
            rawDescription: r.rawDescription,
            merchantName: r.merchantName,
            paymentChannel: r.paymentChannel,
            pfcPrimary: r.pfcPrimary,
            pfcDetailed: r.pfcDetailed,
            pfcConfidence: r.pfcConfidence,
            pfcVersion: r.pfcVersion,
            removedAt: r.removedAt,
            supersededAt: r.supersededAt,
            isLate: r.isLate,
            adjustmentMonth: r.adjustmentMonth,
            adjustmentBaseCents: r.adjustmentBaseCents,
          });
        }
      }
      return out;
    },
    async lockedMonths(months) {
      if (!months.length) return new Set();
      const rows = await db.monthSnapshot.findMany({ where: { businessId: item.businessId, status: "LOCKED", month: { in: months } }, select: { month: true } });
      return new Set(rows.map((r) => r.month));
    },
    async apply(op) {
      const businessId = item.businessId;
      switch (op.type) {
        case "create":
          await db.bankTransaction.createMany({
            data: op.rows.map(({ accountPlaidId: _a, date, authorizedDate, ...r }) => {
              void _a;
              return { businessId, ...r, date: toDate(date), authorizedDate: authorizedDate ? toDate(authorizedDate) : null };
            }),
            skipDuplicates: true,
          });
          return;
        case "update":
          await db.$transaction(
            op.rows.map((u) =>
              db.bankTransaction.update({
                where: { plaidTransactionId: u.plaidTransactionId },
                data: { ...u.row, date: toDate(u.row.date), authorizedDate: u.row.authorizedDate ? toDate(u.row.authorizedDate) : null, removedAt: null, ...u.late },
              }),
            ),
            { timeout: 30_000 },
          );
          return;
        case "remove":
          await db.$transaction(
            op.rows.map((r) => db.bankTransaction.update({ where: { plaidTransactionId: r.plaidTransactionId }, data: { removedAt: op.at, ...r.late } })),
            { timeout: 30_000 },
          );
          return;
        case "supersede":
          await db.bankTransaction.updateMany({ where: { businessId, plaidTransactionId: { in: op.ids }, supersededAt: null }, data: { supersededAt: op.at } });
          return;
        case "audit":
          await db.auditLog.createMany({
            data: op.entries.map((e) => ({ businessId, actor: "plaid-sync", action: "late_change_needs_review", entity: "BankTransaction", entityId: e.entityId, payload: { message: e.message } })),
          });
          return;
      }
    },
    async commitCursor(cursor, at) {
      await db.plaidItem.update({ where: { id: item.id }, data: { cursor, lastSyncAt: at } });
    },
  };
}

export type ItemSyncResult =
  | { outcome: "skipped"; itemStatus: string; errorCode: string | null; message?: string }
  | { outcome: "not_ready"; itemStatus: string }
  | ({ outcome: "synced"; itemStatus: string } & Extract<SyncOutcome, { status: "synced" }>);

/**
 * Syncs one Plaid Item. Health is checked first: LOGIN_REQUIRED/ERROR skip the sync. A consent that
 * is merely expiring soon (PENDING_EXPIRATION) still works, so it does not block syncing.
 */
export async function syncPlaidItem(itemId: string, now = new Date()): Promise<ItemSyncResult> {
  let health;
  try {
    health = await checkItemHealth(itemId, now);
  } catch (e) {
    // Foreign-environment or undecryptable Item (normal after copying a DB between environments): skip cleanly.
    if (e instanceof PlaidItemUnusableError) return { outcome: "skipped", itemStatus: "UNUSABLE", errorCode: e.code, message: e.message };
    throw e;
  }
  if (health.status === "LOGIN_REQUIRED" || health.status === "ERROR") {
    return { outcome: "skipped", itemStatus: health.status, errorCode: health.errorCode };
  }

  const item = await db.plaidItem.findUniqueOrThrow({ where: { id: itemId }, include: { business: true } });
  const { client, env } = getPlaid();
  const accessToken = unlockItemToken(item, env);

  const fetchPage: FetchPage = async (cursor) => {
    const res = await client.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
      count: 500,
      options: { include_original_description: true },
    });
    return res.data as unknown as PlaidPage;
  };

  try {
    const out = await runSync({
      startCursor: item.cursor ?? "",
      fetchPage,
      store: prismaStore(item),
      now,
      openMonth: currentMonth(now, item.business.timezone),
      afterCommit: (ids) => applyRules(prismaRulesStore(db, item.businessId), { plaidTransactionIds: ids }),
    });
    return out.status === "not_ready" ? { outcome: "not_ready", itemStatus: health.status } : { outcome: "synced", itemStatus: health.status, ...out };
  } catch (e) {
    // Never surface the SDK error object (it carries the access token); keep only code and message.
    throw new Error(`Plaid transactions sync failed: ${plaidErrorSummary(e)}`);
  }
}
