// Prime-cost style ratios, always against NET SALES (after discounts and returns, before sales tax and tips), so they mean the same
// whether or not sales tax is shown in revenue. Fractions (0.31 = 31%); null when net sales isn't positive.

export type Ratios = { laborPct: number | null; productPct: number | null; primePct: number | null; rentPct: number | null };

export function computeRatios(a: { netSalesCents: number; laborCents: number; productCents: number; rentCents: number }): Ratios {
  const d = a.netSalesCents;
  if (!(d > 0)) return { laborPct: null, productPct: null, primePct: null, rentPct: null };
  return { laborPct: a.laborCents / d, productPct: a.productCents / d, primePct: (a.laborCents + a.productCents) / d, rentPct: a.rentCents / d };
}

export const RATIO_LABELS = {
  laborPct: "Labor % (Wages and Benefits ÷ net sales)",
  productPct: "Product cost % (Purchase ÷ net sales)",
  primePct: "Prime cost % (labor + product)",
  rentPct: "Rent % (Rent ÷ net sales)",
} as const;

/** "31.4%", or "-" when there is nothing to divide by. */
export function formatPct(p: number | null): string {
  return p === null ? "-" : `${(p * 100).toFixed(1)}%`;
}
