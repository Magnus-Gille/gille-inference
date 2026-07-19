import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { cachePath } from "../src/cache-path.ts";

const root = resolve("fixture-cache");
assert.equal(cachePath(root, "users/alice.json"), resolve(root, "users/alice.json"));
assert.throws(() => cachePath(root, "../secret"));
assert.throws(() => cachePath(root, ""));
assert.throws(() => cachePath(root, resolve("elsewhere")));
