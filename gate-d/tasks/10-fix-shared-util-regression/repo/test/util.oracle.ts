// ORACLE — do NOT edit. `key` is RED at seed; `format` and `label` must STAY green.
import assert from "node:assert/strict";
import { key } from "../src/key.ts";
import { format } from "../src/format.ts";
import { label } from "../src/label.ts";

assert.equal(key("  a   b  "), "a b", "key must fully normalise (the regression target)");
assert.equal(format("  x  y "), "[x y]", "format must stay green");
assert.equal(label(" hi  there "), "HI THERE", "label must stay green");
console.log("oracle: PASS");
