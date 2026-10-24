import { CloverApiError, CloverClient } from "@/lib/clover/client";
import { currentMonth, previousMonth } from "@/lib/dates";
import { db } from "@/lib/db";
import { PlaidItemUnusableError, unlockItemToken } from "@/lib/plaid-item";
import { resolvePlaidEnv } from "@/lib/plaid-config";
import { loadMonthRevenue } from "@/lib/revenue-db";
import type { RevenueResult } from "@/lib/revenue";
import { getLastSyncSummary } from "@/lib/sync-now";

type Business = { id: string; timezone: string };

export type BankCardState =
  | { kind: "config_error"; message: string }
  | { kind: "none" }
  | { kind: "unusable"; institution: string | null; message: string }
  | { kind: "connected"; institution: string | null; status: "OK" | "LOGIN_REQUIRED" | "PENDING_EXPIRATION" | "ERROR"; lastSyncAt: Date | null; errorCode: string | null };

export async function loadBankCard(business: Business): Promise<BankCardState> {
  let env: string;
  try {
    env = resolvePlaidEnv();
  } catch (e) {
    return { kind: "config_error", message: (e as Error).message };
  }
  const item = await db.plaidItem.findUnique({ where: { businessId_environment: { businessId: business.id, environment: env } } });
  if (!item) return { kind: "none" };
  try {
    unlockItemToken(item, env);
  } catch (e) {
    if (e instanceof PlaidItemUnusableError) return { kind: "unusable", institution: item.institutionName, message: e.message };
    throw e;
  }
  return { kind: "connected", institution: item.institutionName, status: item.status, lastSyncAt: item.lastSyncAt, errorCode: item.lastErrorCode };
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
