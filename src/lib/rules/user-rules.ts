import { makeBuilders } from "@/lib/rules/builders";
import { CAT } from "@/lib/rules/categories";
import type { RuleDef } from "@/lib/rules/types";

// Rules the owner confirmed (recorded as source USER, by Stephen). They outrank the seed rules (priority 50 vs 100).
// Each vendor rule has a refund twin. The patterns were taken from the real descriptors.

const { vendor } = makeBuilders({ idPrefix: "user", source: "USER", confirmed: true, priority: 50 });
const note = { note: "Confirmed by Stephen" };

export const USER_RULES: RuleDef[] = [
  // produce, distribution and dairy suppliers (the bank truncates all three names)
  ...vendor("el-paso-produce", "El Paso Produce", "EL PASO PRODUC", CAT.DAIRY, note),
  ...vendor("segovias-distributing", "Segovia's Distributing", "SEGOVIAS DISTR", CAT.DAIRY, note),
  ...vendor("alta-dena-dairy", "Alta Dena Certified Dairy", "ALTA DENA", CAT.DAIRY, note),
  // fees, subscriptions, insurance
  ...vendor("overdraft-fee", "Overdraft fee", "OVERDRAFT ITEM FEE", CAT.BANK_FEES, note),
  ...vendor("homebase-subscription", "Homebase subscription", "JOINHOMEBASE", CAT.PAYROLL_SERVICE, note),
  ...vendor("att", "AT&T", "ATT BILL PAYMENT", CAT.INTERNET_PHONE, note),
  ...vendor("wix", "Wix", "WIX ", CAT.SOFTWARE, note),
  ...vendor("farmers-insurance", "Farmers Insurance", "FARMERS INS EXCH", CAT.INSURANCE, note),
];
