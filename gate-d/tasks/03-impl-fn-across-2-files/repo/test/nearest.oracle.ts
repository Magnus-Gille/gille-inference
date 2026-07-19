// ORACLE — do NOT edit. Exits non-zero on any failed assertion.
import assert from "node:assert/strict";
import { nearest } from "../src/index.ts";
import { distance } from "../src/geo.ts";

// distance must be a real Euclidean metric
assert.equal(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5, "distance (3,4) = 5");
assert.equal(distance({ x: 1, y: 1 }, { x: 1, y: 1 }), 0, "distance to self = 0");

// nearest must pick the closest candidate
assert.deepEqual(
  nearest({ x: 0, y: 0 }, [{ x: 3, y: 4 }, { x: 1, y: 1 }, { x: 5, y: 5 }]),
  { x: 1, y: 1 },
  "nearest to origin"
);
assert.deepEqual(
  nearest({ x: 10, y: 10 }, [{ x: 0, y: 0 }, { x: 9, y: 9 }, { x: 11, y: 12 }]),
  { x: 9, y: 9 },
  "nearest to (10,10)"
);
console.log("oracle: PASS");
