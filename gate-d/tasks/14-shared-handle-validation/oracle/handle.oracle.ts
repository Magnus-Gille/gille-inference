import { strict as assert } from "node:assert";
import { memberTag } from "../src/member.ts";
import { lookupKey } from "../src/lookup.ts";

assert.equal(memberTag("  Alice_42 "), "@alice_42");
assert.equal(lookupKey("Team-One"), "member:team-one");
for (const bad of ["", "two words", "bad!", "a".repeat(21)]) {
  assert.throws(() => memberTag(bad));
  assert.throws(() => lookupKey(bad));
}
