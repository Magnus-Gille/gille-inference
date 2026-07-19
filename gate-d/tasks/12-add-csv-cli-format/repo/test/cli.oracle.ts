import { strict as assert } from "node:assert";
import { run } from "../src/cli.ts";

assert.equal(run(["report"]), "alpha: 1\nbeta: 2");
assert.equal(run(["report", "--csv"]), "name,value\nalpha,1\nbeta,2");
