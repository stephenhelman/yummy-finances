import { CAT } from "@/lib/rules/categories";
import { normalizeDescriptor } from "@/lib/rules/normalize";
import type { RuleDef } from "@/lib/rules/types";

// Zelle payments say who was paid in the descriptor ("Zelle payment to <NAME> Conf# …") but not WHY.
// This module (1) pulls out the counterparty, (2) summarizes each person's payment pattern so the owner
// can label them STAFF / FAMILY / VENDOR / OTHER, and (3) defines the shape of a recipient-level rule.
// Pure functions; nothing here reads or writes a database.

// ---------------------------------------------------------------------------------------------
// 1. counterparty
// ---------------------------------------------------------------------------------------------

export type ZelleCounterparty = { direction: "to" | "from"; name: string; scheduled: boolean };

/** "Zelle payment to MIGUEL LOPEZ Conf# x" -> { to, "MIGUEL LOPEZ" }. Names keep the descriptor's own casing. */
export function extractZelleCounterparty(raw: string): ZelleCounterparty | null {
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(/\s*Conf#.*$/i, "").replace(/;\s*$/, "").replace(/\s+for\s+["“”].*$/i, "").trim();
  const m = /^zelle\s+(scheduled\s+)?payment\s+(to|from)\s+(.+)$/i.exec(s);
  if (!m) return null;
  const name = m[3].trim().replace(/[;,.]+$/, "");
  return name ? { direction: m[2].toLowerCase() as "to" | "from", name, scheduled: !!m[1] } : null;
}

/** Case- and spacing-insensitive identity of a person, so "gabe terrazas" and "Gabe Terrazas" are one row. */
export const recipientKey = (name: string): string => name.toUpperCase().replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------
// 2. per-recipient pattern
// ---------------------------------------------------------------------------------------------

const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

export type Cadence = {
  period: "daily" | "weekly" | "biweekly" | "monthly" | null;
  regular: boolean;
  consistentAmounts: boolean;
  medianGapDays: number | null;
  hint: string;
};

const PERIODS: { name: NonNullable<Cadence["period"]>; min: number; max: number }[] = [
  { name: "daily", min: 0, max: 2 },
  { name: "weekly", min: 5, max: 9 },
  { name: "biweekly", min: 12, max: 16 },
  { name: "monthly", min: 26, max: 35 },
];

/** How regular the payments are and whether the amounts repeat. The hint is a guess for the owner to confirm. */
export function cadenceOf(dates: readonly string[], amounts: readonly number[]): Cadence {
  const n = dates.length;
  if (n <= 1) return { period: null, regular: false, consistentAmounts: false, medianGapDays: null, hint: "single payment" };
  const days = dates.map(dayNum).sort((a, b) => a - b);
  const gaps = days.slice(1).map((d, i) => d - days[i]);
  const gap = median(gaps);
  if (n === 2) return { period: null, regular: false, consistentAmounts: false, medianGapDays: gap, hint: `two payments ${gap} days apart (too few to see a pattern)` };

  const period = PERIODS.find((p) => gap >= p.min && gap <= p.max)?.name ?? null;
  const tol = Math.max(2, gap * 0.4);
  const regular = gaps.filter((g) => Math.abs(g - gap) <= tol).length / gaps.length >= 0.6;
  const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
  const sd = Math.sqrt(amounts.reduce((a, b) => a + (b - mean) ** 2, 0) / amounts.length);
  const consistentAmounts = mean > 0 && sd / mean <= 0.25;

  let hint: string;
  if (period && regular) {
    hint = consistentAmounts ? `~${period}, consistent amounts → likely staff (or a fixed-price vendor)` : `~${period}, varying amounts → possibly staff (variable pay) or a regular supplier`;
  } else {
    const label = `irregular (median gap ${gap} days)`;
    hint = consistentAmounts ? `${label}, consistent amounts → could be family or a fixed vendor` : `${label}, varying amounts → likely a vendor or one-off`;
  }
  return { period, regular, consistentAmounts, medianGapDays: gap, hint };
}

export type ZelleItem = { raw: string; date: string; cents: number; account: string };

export type RecipientRow = {
  name: string; // as it appears in the descriptor (most common casing)
  key: string;
  count: number;
  totalCents: number;
  total2026Cents: number;
  medianCents: number;
  first: string;
  last: string;
  typicalGapDays: number | null;
  accounts: string[];
  cadence: Cadence;
  signals: string[];
};

const WEEKDAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];

/** One row per person for payments in one direction, biggest total first. */
export function summarizeRecipients(items: readonly ZelleItem[], direction: "to" | "from"): RecipientRow[] {
  const groups = new Map<string, { names: Map<string, number>; items: ZelleItem[] }>();
  for (const it of items) {
    const cp = extractZelleCounterparty(it.raw);
    if (!cp || cp.direction !== direction) continue;
    const key = recipientKey(cp.name);
    const g = groups.get(key) ?? groups.set(key, { names: new Map(), items: [] }).get(key)!;
    g.names.set(cp.name, (g.names.get(cp.name) ?? 0) + 1);
    g.items.push(it);
  }
  const rows: RecipientRow[] = [];
  for (const [key, g] of groups) {
    const dates = g.items.map((i) => i.date).sort();
    const amounts = g.items.map((i) => Math.abs(i.cents));
    const cadence = cadenceOf(dates, amounts);
    const signals: string[] = [];
    if (/^YUMMY\b/.test(key)) signals.push("saved with a 'Yummy' contact name");
    if (g.items.length >= 4) {
      const byDay = new Map<number, number>();
      for (const d of dates) {
        const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
        byDay.set(wd, (byDay.get(wd) ?? 0) + 1);
      }
      const [day, cnt] = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
      const share = cnt / g.items.length;
      if (share >= 0.6) signals.push(`mostly ${WEEKDAYS[day]} (${cnt} of ${g.items.length})`);
      // A strong single-weekday pattern is a pay day, even when the weeks between payments vary
      // (shifts, time off). It outranks "irregular", which would otherwise read as "vendor".
      if (share >= 0.7 && !/likely staff/.test(cadence.hint)) {
        cadence.hint = `paid mostly ${WEEKDAYS[day]} (${cnt} of ${g.items.length}), ${cadence.consistentAmounts ? "consistent" : "varying"} amounts → likely staff (pay day)`;
      }
    }
    rows.push({
      name: [...g.names.entries()].sort((a, b) => b[1] - a[1])[0][0],
      key,
      count: g.items.length,
      totalCents: amounts.reduce((a, b) => a + b, 0),
      total2026Cents: g.items.filter((i) => i.date.startsWith("2026")).reduce((a, i) => a + Math.abs(i.cents), 0),
      medianCents: median(amounts),
      first: dates[0],
      last: dates[dates.length - 1],
      typicalGapDays: cadence.medianGapDays,
      accounts: [...new Set(g.items.map((i) => i.account))].sort(),
      cadence,
      signals,
    });
  }
  return rows.sort((a, b) => b.totalCents - a.totalCents || a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------------------------
// 3. recipient-level rule shape
// ---------------------------------------------------------------------------------------------

export type RecipientLabel = "STAFF" | "FAMILY" | "VENDOR" | "OTHER";

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/**
 * Rules for one labeled Zelle recipient (matches the normalized key exactly, scheduled or not):
 *   STAFF   out -> EXPENSE Wages
 *   FAMILY  out -> OWNER_DRAW, in -> OWNER_CONTRIBUTION            (never an expense, never revenue)
 *   VENDOR  out -> EXPENSE <category>, in -> VENDOR_REFUND <category>   (category required)
 *   OTHER   no rule: the payments stay in the review queue
 * Labeled by the owner, so they are confirmed and outrank seed rules (priority 50 vs 100).
 */
export function zelleRecipientRules(args: { name: string; label: RecipientLabel; vendorCategory?: string; wagesCategory?: string; familyCategory?: string; confirmed?: boolean; priority?: number }): RuleDef[] {
  const { name, label } = args;
  if (label === "OTHER") return [];
  if (label === "VENDOR" && !args.vendorCategory) throw new Error("A VENDOR recipient needs a category");
  const normalizedName = normalizeDescriptor(`Zelle payment to ${name}`).replace(/^ZELLE PAYMENT TO /, "");
  const base = { matchType: "REGEX" as const, target: "normalized" as const, confirmed: args.confirmed ?? true, source: "USER" as const, priority: args.priority ?? 50 };
  const out = (kind: RuleDef["kind"], categoryName?: string): RuleDef => ({
    ...base, id: `zelle:${slug(name)}:out`, name: `Zelle to ${name} (${label})`, pattern: `^ZELLE (SCHEDULED )?PAYMENT TO ${escapeRegex(normalizedName)}$`, direction: "out", kind, categoryName,
  });
  const inn = (kind: RuleDef["kind"], categoryName?: string): RuleDef => ({
    ...base, id: `zelle:${slug(name)}:in`, name: `Zelle from ${name} (${label})`, pattern: `^ZELLE (SCHEDULED )?PAYMENT FROM ${escapeRegex(normalizedName)}$`, direction: "in", kind, categoryName,
  });
  switch (label) {
    case "STAFF":
      return [out("EXPENSE", args.wagesCategory ?? CAT.WAGES)];
    case "FAMILY":
      return [out("OWNER_DRAW", args.familyCategory), inn("OWNER_CONTRIBUTION", args.familyCategory)];
    case "VENDOR":
      return [out("EXPENSE", args.vendorCategory), inn("VENDOR_REFUND", args.vendorCategory)];
  }
}
