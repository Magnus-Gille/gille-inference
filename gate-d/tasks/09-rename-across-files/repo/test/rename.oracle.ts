// ORACLE — do NOT edit. Imports the RENAMED symbol; fails to resolve until the rename is done.
import assert from "node:assert/strict";
import { gadget } from "../src/core.ts";
import { labelA } from "../src/a.ts";
import { labelB } from "../src/b.ts";
import { gadget as reExported } from "../src/index.ts";

assert.equal(gadget("x"), "x", "renamed function works");
assert.equal(labelA, "a", "consumer a");
assert.equal(labelB, "b", "consumer b");
assert.equal(reExported("z"), "z", "index re-export renamed");
console.log("oracle: PASS");
