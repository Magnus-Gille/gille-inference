// ORACLE — do NOT edit. Exits non-zero on any failed assertion.
import assert from "node:assert/strict";
import { withdraw } from "../src/account.ts";

const a = { balance: 100 };
assert.equal(withdraw(a, 30), 70, "normal withdrawal");
assert.equal(a.balance, 70, "balance mutated");
assert.equal(withdraw({ balance: 50 }, 50), 0, "exact-balance withdrawal");
assert.throws(() => withdraw({ balance: 100 }, -5), "must throw on negative amount");
assert.throws(() => withdraw({ balance: 100 }, 150), "must throw on overdraft");
// a guard must run BEFORE mutation: a rejected overdraft must not change the balance
const b = { balance: 40 };
assert.throws(() => withdraw(b, 99));
assert.equal(b.balance, 40, "balance unchanged after a rejected withdrawal");
console.log("oracle: PASS");
