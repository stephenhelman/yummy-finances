import { getBusiness, requireAdmin } from "@/lib/auth";
import { currentMonth } from "@/lib/dates";
import { classificationIsReady } from "@/lib/review/gate";
import { loadYear } from "@/lib/report/load-year";
import { toCsv } from "@/lib/report/year";

export const maxDuration = 120;

/** The full year table as a CSV download. Admin only; read-only. */
export async function GET(request: Request) {
  await requireAdmin();
  const business = await getBusiness();
  if (!(await classificationIsReady(business.id))) return new Response("Transactions haven't been categorized yet.", { status: 409 });
  const thisYear = currentMonth(new Date(), business.timezone).slice(0, 4);
  const asked = new URL(request.url).searchParams.get("year");
  const year = asked && /^20\d\d$/.test(asked) && asked <= thisYear && asked >= "2024" ? asked : thisYear;
  const { table } = await loadYear(business, year);
  return new Response(toCsv(table), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="yummy-pnl-${year}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
