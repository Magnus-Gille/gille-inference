// ORACLE — do NOT edit. Exits non-zero on any failed assertion.
import assert from "node:assert/strict";
import { paginate } from "../src/paginate.ts";

const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
assert.deepEqual(paginate(items, 0, 5), [0, 1, 2, 3, 4], "page 0");
assert.deepEqual(paginate(items, 1, 5), [5, 6, 7, 8, 9], "page 1 — no overlap");
assert.deepEqual(paginate(items, 2, 5), [], "page 2 — empty");
assert.deepEqual(paginate(items, 0, 3), [0, 1, 2], "size 3 page 0");
assert.deepEqual(paginate(items, 3, 3), [9], "size 3 last page");
console.log("oracle: PASS");
