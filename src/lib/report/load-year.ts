import { currentMonth } from "@/lib/dates";
import { loadReport } from "@/lib/report/load";
import { buildYearTable, trendSeries, type YearMonth, type YearTable } from "@/lib/report/year";
import { loadMonthRevenue } from "@/lib/revenue-db";

type Business = { id: string; timezone: string; salesTaxInRevenue: boolean };

const months = (year: string, upTo: number) => Array.from({ length: upTo }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);

/** Run `fn` over `xs` with at most `n` in flight (each month's report is several queries; the pool is small). */
async function pooled<T, R>(xs: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (next < xs.length) { const i = next++; out[i] = await fn(xs[i]); } }));
  return out;
}

export type LoadedYear = { table: YearTable; chart: ReturnType<typeof trendSeries>; hasLastYear: boolean };

/** January through the current month for the current year (all twelve for a past year), each month as its report. Read-only. */
export async function loadYear(business: Business, year: string, now = new Date()): Promise<LoadedYear> {
  const cur = currentMonth(now, business.timezone);
  const upTo = year === cur.slice(0, 4) ? Number(cur.slice(5)) : 12;
  const loaded: YearMonth[] = await pooled(months(year, upTo), 3, async (m) => {
    const r = await loadReport(business, m);
    return { month: m, status: r.status, report: r.report };
  });
  const table = buildYearTable(year, loaded);

  // Last year's net sales come from Clover only (payments minus refunds, before tax): expenses are deliberately not compared yet.
  const prev = String(Number(year) - 1);
  const lastYear = await pooled(months(prev, 12), 4, async (m) => (await loadMonthRevenue({ businessId: business.id, timezone: business.timezone, month: m })).netSales.total);
  const hasLastYear = lastYear.some((c) => c !== 0);
  return { table, chart: trendSeries(table, hasLastYear ? lastYear : null), hasLastYear };
}
