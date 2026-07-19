// ORACLE — do NOT edit. Exits non-zero on any failed assertion.
import assert from "node:assert/strict";
import { parsePort } from "../src/parse.ts";

assert.equal(parsePort("8080"), 8080, "plain port");
assert.equal(parsePort("0080"), 80, "leading zeros, base-10");
assert.equal(parsePort("0"), 0, "zero");
assert.throws(() => parsePort("0x1F"), "must not hex-auto-detect");
assert.throws(() => parsePort("nope"), "must throw on non-numeric");
assert.throws(() => parsePort("12.9"), "must throw on non-integer");
assert.throws(() => parsePort(""), "must throw on empty");
assert.throws(() => parsePort(" 80"), "must throw on whitespace");
console.log("oracle: PASS");
