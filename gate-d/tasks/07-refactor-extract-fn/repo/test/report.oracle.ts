// ORACLE — do NOT edit. Characterization tests: behaviour must be PRESERVED by the refactor.
import assert from "node:assert/strict";
import { summary, detailed } from "../src/report.ts";

const lines = [{ qty: 2, price: 3 }, { qty: 1, price: 10 }];
assert.equal(summary(lines), "subtotal: 16", "summary");
assert.equal(detailed(lines), "2x@3, 1x@10 = 16", "detailed");
assert.equal(summary([]), "subtotal: 0", "empty summary");
console.log("oracle: PASS");
