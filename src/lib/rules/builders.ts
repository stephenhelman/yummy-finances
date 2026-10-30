import type { Direction, Kind, RuleDef, RuleSource } from "@/lib/rules/types";

// Helpers for writing rule definitions in code (seed rules and the owner's confirmed rules).

export type RuleOpt = Partial<
  Pick<RuleDef, "accounts" | "expectMultiAccount" | "expectBothDirections" | "note" | "matchType" | "priority" | "confirmed" | "amountMinCents" | "amountMaxCents" | "target">
>;

export function makeBuilders(defaults: { idPrefix: string; source: RuleSource; confirmed: boolean; priority: number }) {
  const rule = (id: string, name: string, pattern: string, direction: Direction, kind: Kind, categoryName: string | undefined, opt: RuleOpt = {}): RuleDef => ({
    target: "normalized",
    matchType: "STARTS_WITH",
    confirmed: defaults.confirmed,
    priority: defaults.priority,
    source: defaults.source,
    id: `${defaults.idPrefix}:${id}`,
    name,
    pattern,
    direction,
    kind,
    categoryName,
    ...opt,
  });

  /** A vendor you buy from: purchases are EXPENSE in the category; refunds from the same vendor are VENDOR_REFUND in it. */
  const vendor = (id: string, name: string, pattern: string, category: string, opt: RuleOpt = {}): RuleDef[] => [
    rule(`${id}:purchase`, `${name} (purchases)`, pattern, "out", "EXPENSE", category, { expectMultiAccount: true, ...opt }),
    rule(`${id}:refund`, `${name} (refunds)`, pattern, "in", "VENDOR_REFUND", category, { expectMultiAccount: true, ...opt }),
  ];

  return { rule, vendor };
}
