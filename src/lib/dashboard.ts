import { CloverApiError, CloverClient } from "@/lib/clover/client";
import { currentMonth, previousMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { resolvePlaidEnv } from "@/lib/plaid-config";
import type { ItemStatus } from "@/lib/plaid-health";
import { loadMonthRevenue } from "@/lib/revenue-db";
import type { RevenueResult } from "@/lib/revenue";
import { classificationIsReady } from "@/lib/review/gate";
import { loadTxnViews } from "@/lib/review/queries";
import { queueSince, reviewQueue, reviewSummary } from "@/lib/review/view";
import { getLastSyncSummary } from "@/lib/sync-now";

type Business = { id: string; timezone: string };

export type BankSummary =
  | { kind: "unusable"; itemId: string; institution: string | null; message: string }
  | { kind: "connected"; itemId: string; institution: string | null; status: ItemStatus; lastSyncAt: Date | null; errorCode: string | null };

export type BankCardState =
  | { kind: "config_error"; message: string }
  | { kind: "none" }
  | { kind: "banks"; banks: BankSummary[] };

/** Anything but a healthy bank: needs a reconnect, has a bank-side problem, or can't be used here. */
export const bankNeedsAttention = (b: BankSummary) => b.kind === "unusable" || b.status !== "OK";

export async function loadBankCard(business: Business): Promise<BankCardState> {
  let env: string;
  try {
    env = resolvePlaidEnv();
  } catch (e) {
    return { kind: "config_error", message: (e as Error).message };
  }
  const items = await db.plaidItem.findMany({ where: { businessId: business.id, environment: env }, orderBy: { createdAt: "asc" } });
  if (!items.length) return { kind: "none" };
  const banks: BankSummary[] = items.map((item) => {
    try {
      unlockItemToken(item, env);
    } catch (e) {
      if (e instanceof PlaidItemUnusableError) return { kind: "unusable", itemId: item.id, institution: item.institutionName, message: e.message };
      throw e;
    }
    return { kind: "connected", itemId: item.id, institution: item.institutionName, status: item.status, lastSyncAt: item.lastSyncAt, errorCode: item.lastErrorCode };
  });
  return { kind: "banks", banks };
}

export type CloverCheck = { ok: true; name: string } | { ok: false; message: string };

/** Lightweight GET /merchants/{mId}. Never throws; the message is safe to show. */
export async function checkClover(): Promise<CloverCheck> {
  let client: CloverClient;
  try {
    client = CloverClient.fromEnv();
  } catch {
    return { ok: false, message: "Clover isn't set up yet." };
  }
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 6000));
    const merchant = await Promise.race([client.getMerchant(), timeout]);
    return { ok: true, name: typeof merchant.name === "string" && merchant.name ? merchant.name : "Clover" };
  } catch (e) {
    if (e instanceof CloverApiError && (e.status === 401 || e.status === 403)) return { ok: false, message: "Clover turned down the access token. It may have been revoked." };
    return { ok: false, message: "Couldn't reach Clover just now." };
  }
}

export type DashboardData = {
  currentMonth: string;
  previousMonth: string;
  current: RevenueResult;
  previous: RevenueResult;
  bank: BankCardState;
  lastSync: Awaited<ReturnType<typeof getLastSyncSummary>>;
};

export async function loadDashboard(business: Business, now = new Date()): Promise<DashboardData> {
  const cur = currentMonth(now, business.timezone);
  const prev = previousMonth(now, business.timezone);
  const args = { businessId: business.id, timezone: business.timezone };
  const [current, previous, bank, lastSync] = await Promise.all([
    loadMonthRevenue({ ...args, month: cur }),
    loadMonthRevenue({ ...args, month: prev }),
    loadBankCard(business),
    getLastSyncSummary(business.id),
  ]);
  return { currentMonth: cur, previousMonth: prev, current, previous, bank, lastSync };
}

export const hasSales = (r: RevenueResult) => r.counts.payments.total + r.counts.refunds.total > 0;

export type ReviewCardData = { kind: "pending" } | { kind: "ready"; month: string; year: string; monthCount: number; monthCents: number; yearCount: number };

/** The "To review" numbers: this month's queue and the year's backlog. Goes through the classification gate. */
export async function loadReviewCard(business: Business, month: string): Promise<ReviewCardData> {
  if (!(await classificationIsReady(business.id))) return { kind: "pending" };
  const queue = reviewQueue(await loadTxnViews(db, business.id, { reviewOnly: true }), queueSince(month));
  const year = month.slice(0, 4);
  return { kind: "ready", month, year, ...reviewSummary(queue, month, year) };
}
