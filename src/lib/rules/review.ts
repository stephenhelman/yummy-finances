import { CAT } from "@/lib/rules/categories";
import type { Kind } from "@/lib/rules/types";

// Quick picks for the review queue: one tap instead of the full category picker. Design only for now;
// the UI that renders them comes with the review page.

export type QuickPick = {
  id: string;
  label: string;
  /** What choosing it does. null kind = "Other": open the full picker. */
  kind: Kind | null;
  categoryName: string | null;
  /** Whether choosing it should also offer to create a rule (a "CHECK" key is too generic for that). */
  offerRule: "none" | "recipient";
};

/** Checks carry no payee: the owner says they are payroll or vendors. Per-transaction only, never a rule. */
export const CHECK_PICKS: QuickPick[] = [
  { id: "check:payroll", label: "Payroll", kind: "EXPENSE", categoryName: CAT.WAGES, offerRule: "none" },
  { id: "check:vendor-cogs", label: "Vendor / COGS", kind: "EXPENSE", categoryName: CAT.OTHER_COGS, offerRule: "none" },
  { id: "check:other", label: "Other", kind: null, categoryName: null, offerRule: "none" },
];

/** Zelle payments are labeled per recipient; choosing one offers a recipient-level rule (see zelle.ts). */
export const ZELLE_PICKS: QuickPick[] = [
  { id: "zelle:staff", label: "Staff", kind: "EXPENSE", categoryName: CAT.WAGES, offerRule: "recipient" },
  { id: "zelle:family", label: "Family", kind: "OWNER_DRAW", categoryName: null, offerRule: "recipient" },
  { id: "zelle:vendor", label: "Vendor", kind: "EXPENSE", categoryName: null, offerRule: "recipient" }, // category chosen next
  { id: "zelle:other", label: "Other", kind: null, categoryName: null, offerRule: "recipient" },
];

/** Quick picks for a review item, from its normalized key. Empty = use the full picker. */
export function quickPicksFor(normalizedKey: string): QuickPick[] {
  if (normalizedKey === "CHECK") return CHECK_PICKS;
  if (/^ZELLE (SCHEDULED )?PAYMENT TO\b/.test(normalizedKey)) return ZELLE_PICKS;
  return [];
}
