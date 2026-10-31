import assert from "node:assert/strict";
import { MAX_BACKFILL_MONTHS, parseBackfill } from "../src/lib/clover/backfill";

const cur = "2026-10";
const plan = (b: unknown, c = cur) => { const r = parseBackfill(b, c); assert.ok(r.ok, `expected ok for ${JSON.stringify(b)}: ${JSON.stringify(r)}`); return r.plan; };
const err = (b: unknown, re: RegExp, c = cur) => { const r = parseBackfill(b, c); assert.ok(!r.ok && re.test(r.error), `expected /${re.source}/ for ${JSON.stringify(b)}, got ${JSON.stringify(r)}`); };

// quarters: the target is the quarter's last month and the sync reaches back to its first
assert.deepEqual(plan({ year: 2025, quarter: 1 }), { months: ["2025-01", "2025-02", "2025-03"], target: "2025-03", lookbackMonths: 2, clipped: false });
assert.deepEqual(plan({ year: 2025, quarter: 2 }).months, ["2025-04", "2025-05", "2025-06"]);
assert.equal(plan({ year: 2025, quarter: 3 }).target, "2025-09");
assert.equal(plan({ year: 2025, quarter: 4 }).target, "2025-12");
// together the four quarters of a year cover all twelve months exactly once
assert.deepEqual([1, 2, 3, 4].flatMap((q) => plan({ year: 2025, quarter: q }).months), Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`));
assert.equal(plan({ year: "2026", quarter: "3" }).target, "2026-09", "numbers sent as strings are fine");

// the current quarter is clipped to months that exist
assert.deepEqual(plan({ year: 2026, quarter: 4 }), { months: ["2026-10"], target: "2026-10", lookbackMonths: 0, clipped: true });
assert.deepEqual(plan({ year: 2026, quarter: 4 }, "2026-11").months, ["2026-10", "2026-11"]);
err({ year: 2027, quarter: 1 }, /year must be/);
assert.equal(parseBackfill({ from: "2026-11", to: "2026-12" }, cur).ok, false, "all in the future");
err({ from: "2026-11", to: "2026-12" }, /future/);

// month ranges
assert.deepEqual(plan({ from: "2026-01", to: "2026-03" }).months, ["2026-01", "2026-02", "2026-03"]);
assert.deepEqual(plan({ from: "2026-05", to: "2026-05" }), { months: ["2026-05"], target: "2026-05", lookbackMonths: 0, clipped: false }, "one month syncs one month, not three");
assert.deepEqual(plan({ from: "2025-11", to: "2026-01" }).months, ["2025-11", "2025-12", "2026-01"], "ranges may cross a year");
assert.equal(MAX_BACKFILL_MONTHS, 3);
err({ from: "2026-01", to: "2026-04" }, /At most 3 months per call/);
err({ from: "2025-01", to: "2026-10" }, /At most 3 months per call/);
err({ from: "2026-03", to: "2026-01" }, /not be after/);

// bad input
for (const bad of [null, undefined, "x", 5, {}, { year: 2025 }, { quarter: 2 }, { year: 2025, quarter: 0 }, { year: 2025, quarter: 5 }, { year: 2025, quarter: 1.5 }, { year: 1999, quarter: 1 }, { year: "abc", quarter: 1 }, { from: "2026-01" }, { from: "2026-13", to: "2026-14" }, { from: "26-01", to: "26-02" }, { from: 202601, to: 202602 }, { year: 2025, quarter: 1, from: "2025-01", to: "2025-02" }]) {
  assert.equal(parseBackfill(bad, cur).ok, false, `rejects ${JSON.stringify(bad)}`);
}
console.log("backfill: all checks passed");
