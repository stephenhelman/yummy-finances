const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-09" -> "September" (or "September 2026"). */
export function monthLabel(month: string, withYear = false): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return month;
  const name = MONTHS[Number(m[2]) - 1];
  return withYear ? `${name} ${m[1]}` : name;
}

/** "Oct 24, 10:36 AM" in the given timezone. */
export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

/** Day of month (1-31) of `date` in the given timezone. */
export function dayOfMonth(date: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, day: "numeric" }).format(date));
}

/** 0.1183 -> "11.83%" */
export function percent(ratio: number, digits = 2): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** El Paso's combined sales tax rate, shown to the owner next to what Clover actually collected. */
export const LOCAL_SALES_TAX_RATE_LABEL = "8.25%";
