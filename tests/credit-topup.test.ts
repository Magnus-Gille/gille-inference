import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { lookupKey, mintKey, recordUsage, revokeKey, stageKeyRotation, topUpCredits } from "../src/homeserver/keystore.js";

const defaults = { rpm: 60, tpm: 60000, dailyTokenBudget: 100000, maxParallel: 1 };
let sequence = 0;
const mint = (creditLimit = 100) => mintKey({ alias: `topup-${sequence++}`, tier: "guest", creditLimit }, defaults);
beforeAll(() => initDb(join(mkdtempSync(join(tmpdir(), "credit-topup-")), "test.db")));

describe("audited same-key top-ups", () => {
  it("increments only the limit and durably replays an exact idempotency receipt", () => {
    const key = mint();
    recordUsage(lookupKey(key.plaintextKey)!.keyHash, 20);
    const before = lookupKey(key.plaintextKey)!;
    const result = topUpCredits(key.record.alias, 50, "request-one", "operator");
    expect(result).toMatchObject({ alias: key.record.alias, amount: 50, previousLimit: 100, creditLimit: 150 });
    expect(topUpCredits(key.record.alias, 50, "request-one", "operator")).toEqual(result);
    expect(lookupKey(key.plaintextKey)).toEqual({ ...before, creditLimit: 150 });
    const stored = getDb().prepare("SELECT * FROM credit_topups WHERE request_id = ?").get("request-one");
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain(key.plaintextKey);
    expect(JSON.stringify(stored)).not.toContain(before.keyHash);
  });
  it("rejects conflicting replays without modifying either key", () => {
    const a = mint(), b = mint();
    topUpCredits(a.record.alias, 10, "conflict", "operator");
    expect(() => topUpCredits(a.record.alias, 11, "conflict", "operator")).toThrow();
    expect(() => topUpCredits(b.record.alias, 10, "conflict", "operator")).toThrow();
    expect(() => topUpCredits(a.record.alias, 10, "conflict", "different-operator")).toThrow();
    expect(lookupKey(a.plaintextKey)!.creditLimit).toBe(110);
    expect(lookupKey(b.plaintextKey)!.creditLimit).toBe(100);
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("rejects invalid amount %s", amount => {
    const key = mint();
    expect(() => topUpCredits(key.record.alias, amount, `invalid-${sequence}`, "operator")).toThrow();
    expect(lookupKey(key.plaintextKey)!.creditLimit).toBe(100);
  });
  it("refuses missing, uncapped, revoked, expired, staged and overflowing targets", () => {
    expect(() => topUpCredits("missing", 10, "missing", "operator")).toThrow();
    const unlimited = mint(0), revoked = mint(), expired = mint(), staged = mint(), overflow = mint(Number.MAX_SAFE_INTEGER);
    revokeKey(revoked.record.alias);
    getDb().prepare("UPDATE api_keys SET expires_at = '2000-01-01' WHERE alias = ?").run(expired.record.alias);
    stageKeyRotation(staged.record.alias, {}, defaults);
    for (const key of [unlimited, revoked, expired, staged, overflow]) {
      expect(() => topUpCredits(key.record.alias, 1, `refused-${key.record.alias}`, "operator")).toThrow();
    }
  });
  it("allows independent additive receipts without resetting used counters", () => {
    const key = mint();
    topUpCredits(key.record.alias, 20, "add-one", "operator");
    topUpCredits(key.record.alias, 30, "add-two", "operator");
    expect(lookupKey(key.plaintextKey)!.creditLimit).toBe(150);
  });
});
