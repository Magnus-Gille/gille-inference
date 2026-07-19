import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";

const cases: Array<[string, string]> = [
  ["Hello World", "hello-world"],
  ["Two words", 2],
];

for (const [input, expected] of cases) assert.equal(slugify(input), expected);
