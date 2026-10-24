import assert from "node:assert/strict";
import { centsToDecimal, dollarsToCents, formatCents } from "../src/lib/money";
import {
  addMonths,
  monthBounds,
  monthCivilBounds,
  monthOfInstant,
  previousMonth,
} from "../src/lib/dates";

const NY = "America/New_York";
const hours = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

// Denver (shop is in El Paso, Mountain Time): MDT = UTC-6, MST = UTC-7
const DEN = "America/Denver";
const oct = monthBounds("2026-10", DEN);
assert.equal(oct.start.toISOString(), "2026-10-01T06:00:00.000Z");
assert.equal(oct.end.toISOString(), "2026-11-01T06:00:00.000Z");
const nov = monthBounds("2026-11", DEN); // DST ends Nov 1 2026: starts in MDT, ends in MST
assert.equal(nov.start.toISOString(), "2026-11-01T06:00:00.000Z");
assert.equal(nov.end.toISOString(), "2026-12-01T07:00:00.000Z");
assert.equal(hours(nov.start, nov.end), 721);
assert.equal(hours(...Object.values(monthBounds("2026-03", DEN)) as [Date, Date]), 743);
assert.equal(monthOfInstant(new Date("2026-10-01T05:59:59Z"), DEN), "2026-09"); // 11:59pm Sep 30 MDT
assert.equal(monthOfInstant(new Date("2026-10-01T06:00:00Z"), DEN), "2026-10");
assert.equal(previousMonth(new Date("2026-11-05T12:00:00Z"), DEN), "2026-10");

// money
assert.equal(dollarsToCents(12.34), 1234);
assert.equal(dollarsToCents("0.1") + dollarsToCents("0.2"), 30);
assert.equal(dollarsToCents(-5.005), -501);
assert.equal(dollarsToCents(1.005), 101);
assert.throws(() => dollarsToCents("abc"));
assert.equal(formatCents(-123456), "-$1,234.56");
assert.equal(centsToDecimal(-5), "-0.05");
assert.equal(centsToDecimal(100000), "1000.00");

// month bounds are timezone-correct: Sep 2026 in NY starts 04:00Z (EDT)
const sep = monthBounds("2026-09", NY);
assert.equal(sep.start.toISOString(), "2026-09-01T04:00:00.000Z");
assert.equal(sep.end.toISOString(), "2026-10-01T04:00:00.000Z");

// DST: March 2026 has 743h in NY (spring forward), Nov 2026 has 721h (fall back)
assert.equal(hours(...Object.values(monthBounds("2026-03", NY)) as [Date, Date]), 743);
assert.equal(hours(...Object.values(monthBounds("2026-11", NY)) as [Date, Date]), 721);

// Edge: 11:30pm local on the 30th is still September, though already Oct 1 in UTC
assert.equal(monthOfInstant(new Date("2026-10-01T03:30:00Z"), NY), "2026-09");
assert.equal(monthOfInstant(new Date("2026-10-01T04:00:00Z"), NY), "2026-10");

// previousMonth uses the business zone: Jan 1 02:00Z is still Dec 31 in NY
assert.equal(previousMonth(new Date("2027-01-01T02:00:00Z"), NY), "2026-11");
assert.equal(previousMonth(new Date("2027-01-05T15:00:00Z"), NY), "2026-12");

assert.equal(addMonths("2026-12", 1), "2027-01");
assert.equal(addMonths("2026-01", -1), "2025-12");
assert.deepEqual(monthCivilBounds("2026-12"), { startDate: "2026-12-01", endDate: "2027-01-01" });

assert.throws(() => monthBounds("2026-13", NY));
assert.throws(() => monthBounds("2026-09", "Mars/Olympus"));
console.log("utils ok");
