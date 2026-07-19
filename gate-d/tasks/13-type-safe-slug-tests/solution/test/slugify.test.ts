import { strict as assert } from "node:assert";
import { slugify } from "../src/slugify.ts";

assert.equal(slugify("Hello World"), "hello-world");
assert.equal(slugify("  Two---words  "), "two-words");
assert.equal(slugify("Already_Spaced"), "already-spaced");
