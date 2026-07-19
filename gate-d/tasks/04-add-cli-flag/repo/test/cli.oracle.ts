// ORACLE — do NOT edit. Exits non-zero on any failed assertion.
import assert from "node:assert/strict";
import { run } from "../src/cli.ts";
import { formatJson } from "../src/format.ts";

assert.equal(run(["report"]), "alpha: 1\nbeta: 2", "text report unchanged");

const out = run(["report", "--json"]);
const parsed = JSON.parse(out) as Array<{ name: string; value: number }>;
assert.equal(parsed.length, 2, "json has two rows");
assert.equal(parsed[0]!.name, "alpha", "first row name");
assert.equal(parsed[1]!.value, 2, "second row value");

// formatJson must exist in format.ts and actually serialize (forces the cross-file factoring)
const direct = formatJson([{ name: "x", value: 9 }]);
assert.deepEqual(JSON.parse(direct), [{ name: "x", value: 9 }], "formatJson works");
console.log("oracle: PASS");
