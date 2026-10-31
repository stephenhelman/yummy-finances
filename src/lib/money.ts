// All money is integer cents. Never store or add floats.

/** Parse a decimal string/number in dollars (e.g. Plaid's 12.34) to cents, rounding half away from zero. */
export function dollarsToCents(dollars: number | string): number {
  const n = typeof dollars === "string" ? Number(dollars) : dollars;
  if (!Number.isFinite(n)) throw new Error(`Invalid amount: ${dollars}`);
  // toPrecision(15) strips binary float noise (1.005 * 100 = 100.49999999999999) before rounding.
  const cents = Math.round(Number((Math.abs(n) * 100).toPrecision(15)));
  return n < 0 ? -cents : cents;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Display only. Negative values render as -$1.23. */
export function formatCents(cents: number): string {
  return usd.format(cents / 100);
}

/** Plain decimal for CSV export, e.g. -1234 -> "-12.34". */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Display only, whole dollars (wide tables). -$1,234 */
export function formatWhole(cents: number): string {
  return usdWhole.format(Math.round(cents / 100) + 0); // + 0: a rounded -0 must not print as -$0
}
