import { DateTime } from "luxon";

// Months are "YYYY-MM" in the business timezone. Period ranges are half-open:
// [start, end). Clover timestamps are instants, so month membership must be
// decided in the merchant's timezone, never UTC.

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidTimezone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

function assertZone(tz: string): void {
  if (!isValidTimezone(tz)) throw new Error(`Invalid timezone: ${tz}`);
}

function parseMonth(month: string, tz: string): DateTime {
  const m = MONTH_RE.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  assertZone(tz);
  return DateTime.fromObject({ year: Number(m[1]), month: Number(m[2]), day: 1 }, { zone: tz });
}

/** Start (inclusive) and end (exclusive) instants of a month in `tz`. */
export function monthBounds(month: string, tz: string): { start: Date; end: Date } {
  const start = parseMonth(month, tz);
  return { start: start.toJSDate(), end: start.plus({ months: 1 }).toJSDate() };
}

/** Which "YYYY-MM" an instant falls in, in `tz`. */
export function monthOfInstant(instant: Date, tz: string): string {
  assertZone(tz);
  return DateTime.fromJSDate(instant, { zone: tz }).toFormat("yyyy-MM");
}

/** Month of a civil date string such as Plaid's "2026-09-30" (no timezone shift applies). */
export function monthOfCivilDate(date: string): string {
  if (!CIVIL_DATE_RE.test(date)) throw new Error(`Invalid date: ${date}`);
  return date.slice(0, 7);
}

/** The calendar month before the one containing `now` in `tz`. */
export function previousMonth(now: Date, tz: string): string {
  assertZone(tz);
  return DateTime.fromJSDate(now, { zone: tz }).startOf("month").minus({ months: 1 }).toFormat("yyyy-MM");
}

export function currentMonth(now: Date, tz: string): string {
  return monthOfInstant(now, tz);
}

export function addMonths(month: string, delta: number): string {
  return parseMonth(month, "UTC").plus({ months: delta }).toFormat("yyyy-MM");
}

/** Civil-date bounds [first day, first day of next month) as "YYYY-MM-DD", for matching Plaid dates. */
export function monthCivilBounds(month: string): { startDate: string; endDate: string } {
  const start = parseMonth(month, "UTC");
  return { startDate: start.toFormat("yyyy-MM-dd"), endDate: start.plus({ months: 1 }).toFormat("yyyy-MM-dd") };
}

/** Months (YYYY-MM) of a calendar year, for year-end rollups. */
export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
}

/** Clover timestamps are epoch milliseconds (verified against live data in the probe step). */
export function fromEpochMs(ms: number): Date {
  return new Date(ms);
}
