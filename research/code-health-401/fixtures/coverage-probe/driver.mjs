import assert from "node:assert/strict";
import { classify } from "./imported.mjs";

assert.equal(classify(1), "positive");
