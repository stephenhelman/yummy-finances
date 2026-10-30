import "dotenv/config";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "../src/generated/prisma/client";
import { isValidTimezone } from "../src/lib/dates";
import { ALL_RULES } from "../src/lib/rules/all";
import { applyCategoryChanges } from "../src/lib/rules/category-store";
import { persistRules } from "../src/lib/rules/prisma-store";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}


type Section = "REVENUE" | "COGS" | "OPEX" | "OTHER" | "NON_PL";

// Order here is the order on the P&L within each section.
const CATEGORIES: [Section, string[]][] = [
  ["REVENUE", ["Uncategorized income"]],
  ["COGS", ["Dairy & ingredients", "Candy & toppings", "Cones, cups and packaging", "Other COGS"]],
  [
    "OPEX",
    [
      "Wages",
      "Payroll taxes",
      "Payroll service fees",
      "Rent",
      "Utilities",
      "Internet and phone",
      "Supplies",
      "Repairs and maintenance",
      "Equipment leases",
      "Card processing fees",
      "Bank fees",
      "Software and subscriptions",
      "Insurance",
      "Licenses and permits",
      "Accounting and professional",
      "Advertising and marketing",
      "Other operating expenses",
      "Uncategorized",
    ],
  ],
  ["OTHER", ["Interest", "Income taxes paid", "Other income and expense"]],
  ["NON_PL", ["Sales tax remitted", "Tips paid out", "Owner draws and contributions", "Loan principal", "Equipment purchases", "Transfers"]],
];

async function main() {
  const db = new PrismaClient({
    adapter: new PrismaNeon({ connectionString: required("DIRECT_URL") }),
  });
  // Required and validated: no default, because month boundaries depend on it.
  const timezone = required("BUSINESS_TIMEZONE");
  if (!isValidTimezone(timezone)) throw new Error(`BUSINESS_TIMEZONE is not a valid IANA zone: ${timezone}`);
  try {
    // Single-tenant: exactly one business. Seed is idempotent.
    const existing = await db.business.findFirst();
    // Never silently change the zone of an existing business: locked months were cut with it.
    if (existing && existing.timezone !== timezone) {
      throw new Error(
        `Business timezone is ${existing.timezone} but BUSINESS_TIMEZONE is ${timezone}. Change it deliberately, not via seed.`,
      );
    }
    const b =
      existing ??
      (await db.business.create({
      data: {
        name: process.env.BUSINESS_NAME ?? "Ice Cream Shop",
        timezone,
        ownerEmail: required("OWNER_EMAIL"),
        ccEmail: process.env.CC_EMAIL || null,
      },
    }));
    console.log(`${existing ? "Found" : "Created"} business ${b.id}`);

    // Renames first: the upsert below is keyed by name, so without this a renamed category would be created
    // anew and the old row (and any transactions already pointing at it) left behind.
    const changes = await applyCategoryChanges(db, b.id);
    if (changes.renamed) console.log(`Renamed ${changes.renamed} category(ies) per the planned changes`);

    let order = 0;
    for (const [section, names] of CATEGORIES) {
      for (const name of names) {
        await db.category.upsert({
          where: { businessId_name: { businessId: b.id, name } },
          update: {},
          create: { businessId: b.id, name, section, sortOrder: order++, isSystem: true },
        });
      }
    }
    console.log(`Categories ensured: ${order}`);

    // Persist the seed rules and the owner's confirmed rules. A person's confirmations on existing rules are kept.
    const rules = await persistRules(db, b.id, ALL_RULES);
    console.log(`Rules: ${rules.created} created, ${rules.updated} updated, ${rules.unchanged} unchanged (${ALL_RULES.length} defined)`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
