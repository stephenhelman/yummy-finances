import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { CloverClient } from "@/lib/clover/client";
import {
  PAYMENT_COMPARE,
  REFUND_COMPARE,
  changed,
  mapPayment,
  mapRefund,
  mapTender,
  type TenderRow,
} from "@/lib/clover/map";
import { addMonths, currentMonth, monthBounds, monthOfInstant } from "@/lib/dates";
import { mapOrder, type OrderRow } from "@/lib/report/discounts";

/** Months re-synced before the target month. Clover's createdTime filter appears to match device
 *  time, so a later month's query will not return a payment uploaded late from an offline device. */
export const LOOKBACK_MONTHS = 2;

/** Clover's order LIST only returns recent orders (about 90 days); an older order can still be fetched by its id. */
export const ORDERS_BY_ID_PER_MONTH = 2000;
const ORDER_BATCH = 50;

type Counts = { fetched: number; created: number; updated: number; unchanged: number; outsideWindow: number; updatedInLockedMonth: number };

export type CloverMonthReport = {
  month: string;
  startUtc: string;
  endUtc: string;
  monthLocked: boolean;
  payments: Counts & { unknownTender: number; testMode: number; lateCreated: number };
  refunds: Counts & { unknownTender: number; lateCreated: number };
  /** Orders, kept only to report discounts (see src/lib/report/discounts.ts). */
  orders?: Pick<Counts, "fetched" | "created" | "updated" | "unchanged"> & { withDiscount: number; /** fetched one by one because the list no longer returns them */ byId: number; stillMissing: number };
};

export type CloverSyncReport = {
  month: string;
  timezone: string;
  tenders: number;
  months: CloverMonthReport[]; // oldest first; the last entry is the target month
  refundsLinked: number;
  refundsUnlinked: number; // refunds whose payment is not in our DB (e.g. an unsynced older month)
};

const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Verified on live data: price + modifier amounts reconcile to payments; discount objects are only used for names. */
const ORDER_EXPAND = "discounts,lineItems,lineItems.discounts,lineItems.modifications";

/** Updates in small transactions: one big batch outlives Prisma's 5s transaction timeout.
 *  Safe to interrupt: a re-run picks up whatever is still different. */
async function updateInChunks<T>(items: readonly T[], toOp: (item: T) => Prisma.PrismaPromise<unknown>, size = 100) {
  for (let i = 0; i < items.length; i += size) {
    await db.$transaction(items.slice(i, i + size).map(toOp), { timeout: 30_000 });
  }
}

/**
 * Syncs Clover payments and refunds for `month` and re-syncs the two months before it.
 * Month bounds use the business timezone (checked against Clover's properties.timezone);
 * month membership of every row is decided by its saleTime. Idempotent. Writes only
 * Clover* tables. New rows whose saleTime lands in an already-locked month are flagged
 * isLate with adjustmentMonth = the current open month.
 */
export async function syncCloverMonth(args: {
  businessId: string;
  timezone: string;
  month: string;
  client?: CloverClient;
  now?: Date;
  /** Most orders to fetch one by one per month (the list can't return old ones). Infinity for a backfill. */
  maxOrdersById?: number;
  /** Months before `month` to include (default LOOKBACK_MONTHS). A backfill of k months passes k - 1. */
  lookbackMonths?: number;
}): Promise<CloverSyncReport> {
  const { businessId, timezone, month } = args;
  const maxOrdersById = args.maxOrdersById ?? ORDERS_BY_ID_PER_MONTH;
  const client = args.client ?? CloverClient.fromEnv();
  const now = args.now ?? new Date();

  const props = await client.getMerchantProperties();
  const cloverTz = typeof props.timezone === "string" ? props.timezone : null;
  if (cloverTz && cloverTz !== timezone) {
    throw new Error(`Clover timezone ${cloverTz} does not match business timezone ${timezone}; refusing to sync`);
  }

  // Tenders: once per sync run.
  const tenderRows = (await client.getAll("/tenders")).map(mapTender);
  for (const t of tenderRows) {
    await db.cloverTender.upsert({
      where: { businessId_cloverId: { businessId, cloverId: t.cloverId } },
      create: { businessId, ...t },
      update: { label: t.label, labelKey: t.labelKey, isCash: t.isCash },
    });
  }
  const tenders = new Map<string, TenderRow>(tenderRows.map((t) => [t.cloverId, t]));

  const lookback = args.lookbackMonths ?? LOOKBACK_MONTHS;
  const months = Array.from({ length: lookback + 1 }, (_, i) => addMonths(month, i - lookback));
  const lockedMonths = new Set(
    (
      await db.monthSnapshot.findMany({
        where: { businessId, status: "LOCKED", month: { in: months } },
        select: { month: true },
      })
    ).map((s) => s.month),
  );
  const openMonth = currentMonth(now, timezone);

  const reports: CloverMonthReport[] = [];
  for (const m of months) {
    reports.push(await syncOneMonth({ businessId, timezone, month: m, client, tenders, lockedMonths, openMonth, maxOrdersById }));
  }

  // Link refunds to their payments (set-based, idempotent). A refund can reference a payment
  // from a month that hasn't been synced; it links once that payment is stored.
  const refundsLinked = await db.$executeRaw`
    UPDATE "CloverRefund" r SET "paymentId" = p."id"
    FROM "CloverPayment" p
    WHERE r."businessId" = ${businessId} AND r."paymentId" IS NULL
      AND r."cloverPaymentId" = p."cloverId" AND p."businessId" = r."businessId"`;
  const { start } = monthBounds(months[0], timezone);
  const { end } = monthBounds(month, timezone);
  const refundsUnlinked = await db.cloverRefund.count({
    where: { businessId, paymentId: null, saleTime: { gte: start, lt: end } },
  });

  return { month, timezone, tenders: tenderRows.length, months: reports, refundsLinked, refundsUnlinked };
}

async function syncOneMonth(ctx: {
  businessId: string;
  timezone: string;
  month: string;
  client: CloverClient;
  tenders: ReadonlyMap<string, TenderRow>;
  lockedMonths: ReadonlySet<string>;
  openMonth: string;
  maxOrdersById: number;
}): Promise<CloverMonthReport> {
  const { businessId, timezone, month, client, tenders, lockedMonths, openMonth, maxOrdersById } = ctx;
  const { start, end } = monthBounds(month, timezone);
  const inWindow = (d: Date) => d >= start && d < end;

  // Per-row: a row first seen after the month of its saleTime was locked rolls into the
  // open month's "Prior-month adjustments" line.
  const lateOf = (saleTime: Date) => {
    const locked = lockedMonths.has(monthOfInstant(saleTime, timezone));
    return locked ? { isLate: true, adjustmentMonth: openMonth } : {};
  };
  const inLockedMonth = (saleTime: Date) => lockedMonths.has(monthOfInstant(saleTime, timezone));

  // Payments
  const rawPayments = await client.listPayments(start.getTime(), end.getTime(), "order,refunds");
  const payments = rawPayments.map((p) => mapPayment(p, tenders));
  const existingP = new Map(
    (await db.cloverPayment.findMany({ where: { businessId, cloverId: { in: payments.map((p) => p.cloverId) } } })).map((r) => [r.cloverId, r]),
  );
  const newP = payments.filter((p) => !existingP.has(p.cloverId));
  const updP = payments.filter((p) => {
    const e = existingP.get(p.cloverId);
    return e && changed(e, p, PAYMENT_COMPARE);
  });
  if (newP.length) {
    await db.cloverPayment.createMany({
      data: newP.map((p) => ({ businessId, ...p, raw: json(p.raw), ...lateOf(p.saleTime) })),
      skipDuplicates: true,
    });
  }
  if (updP.length) {
    await updateInChunks(updP, (p) => db.cloverPayment.update({ where: { cloverId: p.cloverId }, data: { ...p, raw: json(p.raw) } }));
  }

  // Refunds
  const rawRefunds = await client.listRefunds(start.getTime(), end.getTime(), "payment");
  const refunds = rawRefunds.map((r) => mapRefund(r, tenders));
  const existingR = new Map(
    (await db.cloverRefund.findMany({ where: { businessId, cloverId: { in: refunds.map((r) => r.cloverId) } } })).map((r) => [r.cloverId, r]),
  );
  const newR = refunds.filter((r) => !existingR.has(r.cloverId));
  const updR = refunds.filter((r) => {
    const e = existingR.get(r.cloverId);
    return e && changed(e, r, REFUND_COMPARE);
  });
  if (newR.length) {
    await db.cloverRefund.createMany({
      data: newR.map((r) => ({ businessId, ...r, raw: json(r.raw), ...lateOf(r.saleTime) })),
      skipDuplicates: true,
    });
  }
  if (updR.length) {
    await updateInChunks(updR, (r) => db.cloverRefund.update({ where: { cloverId: r.cloverId }, data: { ...r, raw: json(r.raw) } }));
  }

  // Orders (discounts). Same window and idempotency as payments: new rows are created, changed rows updated, the rest untouched.
  const rawOrders = await client.listOrders(start.getTime(), end.getTime(), ORDER_EXPAND);
  const orders = rawOrders.map(mapOrder);
  const existingO = new Map(
    (await db.cloverOrder.findMany({ where: { businessId, cloverId: { in: orders.map((o) => o.cloverId) } } })).map((r) => [r.cloverId, r]),
  );
  const orderChanged = (e: { subtotalCents: number; hasDiscount: boolean; discountNames: unknown; testMode: boolean }, o: OrderRow) =>
    e.subtotalCents !== o.subtotalCents || e.hasDiscount !== o.hasDiscount || e.testMode !== o.testMode || JSON.stringify(e.discountNames ?? []) !== JSON.stringify(o.discountNames);
  const newO = orders.filter((o) => !existingO.has(o.cloverId));
  const updO = orders.filter((o) => {
    const e = existingO.get(o.cloverId);
    return e && orderChanged(e, o);
  });
  if (newO.length) await db.cloverOrder.createMany({ data: newO.map((o) => ({ businessId, ...o, discountNames: o.discountNames })), skipDuplicates: true });
  if (updO.length) await updateInChunks(updO, (o) => db.cloverOrder.update({ where: { businessId_cloverId: { businessId, cloverId: o.cloverId } }, data: { ...o } }));

  // Orders the list didn't return (older than its window) but that a stored SUCCESS payment points at: fetch them by id.
  const byId = await fetchMissingOrders({ businessId, client, start, end, max: maxOrdersById });

  return {
    month,
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    monthLocked: lockedMonths.has(month),
    payments: {
      fetched: payments.length,
      created: newP.length,
      updated: updP.length,
      unchanged: payments.length - newP.length - updP.length,
      // Rows Clover returned whose saleTime is not in this month: should be 0 now that
      // saleTime (device time) drives membership.
      outsideWindow: payments.filter((p) => !inWindow(p.saleTime)).length,
      updatedInLockedMonth: updP.filter((p) => inLockedMonth(p.saleTime)).length,
      unknownTender: payments.filter((p) => p.tenderId && !p.tenderLabel).length,
      testMode: rawPayments.filter((p) => (p.order as { testMode?: unknown } | undefined)?.testMode === true).length,
      lateCreated: newP.filter((p) => inLockedMonth(p.saleTime)).length,
    },
    refunds: {
      fetched: refunds.length,
      created: newR.length,
      updated: updR.length,
      unchanged: refunds.length - newR.length - updR.length,
      outsideWindow: refunds.filter((r) => !inWindow(r.saleTime)).length,
      updatedInLockedMonth: updR.filter((r) => inLockedMonth(r.saleTime)).length,
      unknownTender: refunds.filter((r) => r.cloverPaymentId && !r.tenderLabel).length,
      lateCreated: newR.filter((r) => inLockedMonth(r.saleTime)).length,
    },
    orders: { fetched: orders.length, created: newO.length + byId.created, updated: updO.length, unchanged: orders.length - newO.length - updO.length, withDiscount: orders.filter((o) => o.hasDiscount).length + byId.withDiscount, byId: byId.created, stillMissing: byId.stillMissing },
  };
}

/**
 * Orders for this month's successful payments that we have no stored order for, fetched in batches of 50 ids (the client backs off
 * on 429). Bounded by `max` per call so a routine sync stays quick; a backfill passes Infinity and is simply re-run.
 */
async function fetchMissingOrders(args: { businessId: string; client: CloverClient; start: Date; end: Date; max: number }): Promise<{ created: number; withDiscount: number; stillMissing: number }> {
  const { businessId, client, start, end, max } = args;
  const paid = await db.cloverPayment.findMany({ where: { businessId, saleTime: { gte: start, lt: end }, result: "SUCCESS", excluded: false, orderId: { not: null } }, select: { orderId: true } });
  const ids = [...new Set(paid.map((p) => p.orderId!))];
  const have = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    for (const o of await db.cloverOrder.findMany({ where: { businessId, cloverId: { in: ids.slice(i, i + 1000) } }, select: { cloverId: true } })) have.add(o.cloverId);
  }
  const missing = ids.filter((id) => !have.has(id));
  const todo = missing.slice(0, max);
  const rows: OrderRow[] = [];
  let withDiscount = 0;
  // 50 ids per request: Clover accepts `id in ('A','B',...)` (quoted; unquoted or bracketed is a 400)
  for (let i = 0; i < todo.length; i += ORDER_BATCH) {
    const batch = todo.slice(i, i + ORDER_BATCH);
    const got = await client.getPage("/orders", { limit: ORDER_BATCH, expand: ORDER_EXPAND, filter: [`id in (${batch.map((id) => `'${id.replace(/'/g, "")}'`).join(",")})`] });
    for (const raw of got) {
      try {
        const r = mapOrder(raw);
        rows.push(r);
        if (r.hasDiscount) withDiscount++;
      } catch {
        /* an order we can't read stays "missing" and shows as a warning on the report */
      }
    }
    if (rows.length >= 200) await db.cloverOrder.createMany({ data: rows.splice(0).map((o) => ({ businessId, ...o, discountNames: o.discountNames })), skipDuplicates: true });
  }
  if (rows.length) await db.cloverOrder.createMany({ data: rows.map((o) => ({ businessId, ...o, discountNames: o.discountNames })), skipDuplicates: true });
  const stored = await db.cloverOrder.count({ where: { businessId, cloverId: { in: todo } } });
  return { created: stored, withDiscount, stillMissing: missing.length - stored };
}
