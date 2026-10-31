import assert from "node:assert/strict";
import { archiveBlocker, mergeBlocker, moved, validateNewCategory } from "../src/lib/review/category-rules";

const ok: Parameters<typeof validateNewCategory>[0] = { name: "Ice Machine", treatment: "PNL_EXPENSE", nonPlKind: null, groupId: "g1" };
assert.equal(validateNewCategory(ok, ["Rent"]), null);
assert.match(validateNewCategory({ ...ok, name: "  " }, []) ?? "", /Give the category a name/);
assert.match(validateNewCategory({ ...ok, name: "rent" }, ["Rent"]) ?? "", /already a category called "rent"/, "case-insensitive duplicate");
assert.match(validateNewCategory({ ...ok, name: "Zelle (unclassified)" }, []) ?? "", /works out by itself/, "computed lines can't be categories");
assert.match(validateNewCategory({ ...ok, name: "Checks (unclassified)" }, []) ?? "", /works out by itself/);
assert.match(validateNewCategory({ ...ok, name: "Uncategorized" }, []) ?? "", /works out by itself/);
assert.match(validateNewCategory({ ...ok, treatment: "NON_PL" }, []) ?? "", /what kind of money/);
assert.equal(validateNewCategory({ ...ok, treatment: "NON_PL", nonPlKind: "DONATION" }, []), null);
assert.match(validateNewCategory({ ...ok, nonPlKind: "DONATION" }, []) ?? "", /Only a Not-in-P&L category has a kind/);
assert.match(validateNewCategory({ ...ok, treatment: "PERSONAL", groupId: null }, []) ?? "", /go in a group/);
assert.equal(validateNewCategory({ ...ok, treatment: "PNL_EXPENSE", groupId: null }, []), null, "an expense can be a top-level line");

assert.equal(archiveBlocker({ transactions: 0, rules: 0 }), null);
assert.match(archiveBlocker({ transactions: 3, rules: 0 }) ?? "", /3 transactions use it/);
assert.match(archiveBlocker({ transactions: 1, rules: 0 }) ?? "", /1 transaction uses it/);
assert.match(archiveBlocker({ transactions: 0, rules: 2 }) ?? "", /2 rules use it/);

const cat = (id: string, treatment: "PNL_EXPENSE" | "NON_PL" | "PERSONAL", nonPlKind: string | null = null, archived = false) => ({ id, name: id, treatment, nonPlKind, archived });
assert.equal(mergeBlocker(cat("a", "PNL_EXPENSE"), cat("b", "PNL_EXPENSE")), null);
assert.match(mergeBlocker(cat("a", "PNL_EXPENSE"), cat("a", "PNL_EXPENSE")) ?? "", /different category/);
assert.match(mergeBlocker(cat("a", "PNL_EXPENSE"), cat("b", "PERSONAL")) ?? "", /can't be merged/, "an expense can't be folded into a personal line");
assert.match(mergeBlocker(cat("a", "NON_PL", "DONATION"), cat("b", "NON_PL", "CARD_PAYMENT")) ?? "", /different kinds of money/);
assert.equal(mergeBlocker(cat("a", "NON_PL", "DONATION"), cat("b", "NON_PL", "DONATION")), null);
assert.match(mergeBlocker(cat("a", "PNL_EXPENSE"), cat("b", "PNL_EXPENSE", null, true)) ?? "", /archived/);

assert.deepEqual(moved(["a", "b", "c"], "b", "up"), ["b", "a", "c"]);
assert.deepEqual(moved(["a", "b", "c"], "b", "down"), ["a", "c", "b"]);
assert.equal(moved(["a", "b", "c"], "a", "up"), null, "already first");
assert.equal(moved(["a", "b", "c"], "c", "down"), null, "already last");
assert.equal(moved(["a", "b"], "zzz", "up"), null);

console.log("categories: all checks passed");
