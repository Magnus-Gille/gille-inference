// Harness-authored tests (reference). ≥3 assertions required by the structural gate.
import assert from "node:assert/strict";
import { clamp } from "../src/clamp.ts";
assert.equal(clamp(5, 0, 10), 5);
assert.equal(clamp(-1, 0, 10), 0);
assert.equal(clamp(50, 0, 10), 10);
