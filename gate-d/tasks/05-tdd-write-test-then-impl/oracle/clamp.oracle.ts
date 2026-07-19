// HIDDEN ORACLE — the ground truth for clamp. The harness writes its OWN tests; this checks
// the implementation independently so a vacuous self-test cannot pass the task.
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.ts";

assert.equal(clamp(5, 0, 10), 5, "in range");
assert.equal(clamp(-3, 0, 10), 0, "below lo");
assert.equal(clamp(99, 0, 10), 10, "above hi");
assert.equal(clamp(0, 0, 10), 0, "at lo");
assert.equal(clamp(10, 0, 10), 10, "at hi");
assert.equal(clamp(7, -5, 5), 5, "negative range above");
console.log("hidden-oracle: PASS");
