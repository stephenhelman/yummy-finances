// Read-only: lists the merchant's configured tax rates. Run: npm run probe:clover-tax
// Needs the Clover token to have Inventory: Read; on 401/403 it says so and exits cleanly.
import "dotenv/config";
import { CloverApiError, CloverClient } from "../src/lib/clover/client";

// Clover stores `rate` as an integer where 662500 = 6.625% (divide by 100,000).
// (Inferred from examples, not stated in the docs we could load; the raw value is printed too.)
const RATE_DIVISOR = 100_000;

async function main() {
  const client = CloverClient.fromEnv();
  let rates;
  try {
    rates = await client.getAll("/tax_rates");
  } catch (e) {
    if (e instanceof CloverApiError && (e.status === 401 || e.status === 403)) {
      console.log(`HTTP ${e.status} from /tax_rates: this token probably lacks "Inventory: Read". Enable it for the API token in the Clover dashboard and re-run.`);
      return;
    }
    throw e;
  }
  console.log(`${rates.length} tax rate(s)\n`);
  console.log("name".padEnd(28) + "raw rate".padStart(10) + "percent".padStart(10) + "  isDefault  other fields");
  for (const r of rates) {
    const raw = typeof r.rate === "number" ? r.rate : null;
    const pct = raw === null ? "n/a" : `${(raw / RATE_DIVISOR).toFixed(4)}%`;
    const extra = Object.keys(r).filter((k) => !["id", "name", "rate", "isDefault"].includes(k)).join(",");
    console.log(`${String(r.name ?? "(unnamed)").padEnd(28)}${String(raw).padStart(10)}${pct.padStart(10)}  ${String(r.isDefault ?? "n/a").padEnd(9)}  ${extra}`);
  }
}
main().catch((e) => {
  console.error(e instanceof CloverApiError ? `${e.name}: ${e.message}` : (e as Error).message);
  process.exitCode = 1;
});
