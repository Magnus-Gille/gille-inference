import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";

assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  Multiple---separators__here  "), "multiple-separators-here");
assert.equal(slugify("ABC123"), "abc123");
assert.equal(slugify("---"), "");
