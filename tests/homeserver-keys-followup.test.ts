import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { lookupKey, mintKey, type KeyDefaults } from "../src/homeserver/keystore.js";
import { cmdKeys, parseArgs, strictNumFlag } from "../src/homeserver/cli.js";

// Codex second-pass review of #99 (post-merge) — two follow-up fixes.

describe("strictNumFlag — invalid key-mgmt numeric flags fail loud (#99 Codex M)", () => {
  it("absent flag → undefined (caller inherits / applies a default)", () => {
    expect(strictNumFlag({}, "credits")).toBeUndefined();
  });

  it("valid numeric string → number, including 0", () => {
    expect(strictNumFlag({ credits: "500" }, "credits")).toBe(500);
    expect(strictNumFlag({ credits: "0" }, "credits")).toBe(0);
  });

  it("a bare `--credits` (boolean, no value) THROWS instead of silently inheriting", () => {
    // This is the dangerous case: a silent undefined would leave an unlimited key uncapped.
    expect(() => strictNumFlag({ credits: true }, "credits")).toThrow(/--credits/);
  });

  it("a non-numeric value (`--credits abc`) THROWS", () => {
    expect(() => strictNumFlag({ credits: "abc" }, "credits")).toThrow(/number/);
  });

  it("an empty or whitespace-only value THROWS (Number('')===0 = the unlimited sentinel)", () => {
    // e.g. `--credits "$UNSET"` must not silently become creditLimit:0 (unlimited).
    expect(() => strictNumFlag({ credits: "" }, "credits")).toThrow(/requires a numeric value/);
    expect(() => strictNumFlag({ credits: "   " }, "credits")).toThrow(/requires a numeric value/);
  });

  it("trims surrounding whitespace around a valid number", () => {
    expect(strictNumFlag({ credits: " 500 " }, "credits")).toBe(500);
  });
});

describe("keys CLI — valueless scope fails closed (#139 review)", () => {
  const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };
  const nextAlias = (prefix: string): string => `${prefix}-${randomUUID()}`;

  it("rejects bare --scope on mint before it can create a default-admin credential", () => {
    const alias = nextAlias("bare-scope-mint");
    const args = parseArgs(["mint", "--alias", alias, "--tier", "owner", "--scope"]);

    expect(args.flags["scope"]).toBe(true);
    expect(() => cmdKeys(args)).toThrow(/--scope.*value/i);
    expect(getDb().prepare("SELECT alias FROM api_keys WHERE alias = ?").get(alias)).toBeUndefined();
  });

  it("rejects bare --scope on rotate before it can mint an admin-inheriting replacement", () => {
    const alias = nextAlias("bare-scope-rotate");
    const original = mintKey({ alias, tier: "owner" }, DEFAULTS);
    const args = parseArgs(["rotate", "--alias", alias, "--scope"]);

    expect(args.flags["scope"]).toBe(true);
    expect(() => cmdKeys(args)).toThrow(/--scope.*value/i);
    expect(lookupKey(original.plaintextKey)).toMatchObject({ alias, scope: "admin" });
    expect(getDb().prepare("SELECT alias FROM api_keys WHERE alias = ?").get(`${alias}-r2`)).toBeUndefined();
  });
});

describe("keystore migration idempotency (#99 Codex L)", () => {
  const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };
  const indexName = "idx_api_keys_logical_alias";
  const hasIndex = (): boolean =>
    !!getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`)
      .get(indexName);

  it("recreates the logical_alias index on an already-migrated DB that is missing it", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hs-mig-test-")), "m.db");
    initDb(path);
    mintKey({ alias: "seed", tier: "owner" }, DEFAULTS); // ensureSchema → column + index
    expect(hasIndex()).toBe(true);

    // Simulate a DB that HAS the logical_alias column but LOST the index (partial/manual
    // migration). The old code created the index only inside the column-add branch, so it
    // would never be recreated.
    getDb().exec(`DROP INDEX ${indexName}`);
    expect(hasIndex()).toBe(false);

    // A fresh connection re-runs ensureSchema; the unconditional CREATE INDEX IF NOT EXISTS
    // restores it even though logical_alias already exists.
    initDb(path);
    mintKey({ alias: "after", tier: "owner" }, DEFAULTS); // triggers ensureSchema on the new conn
    expect(hasIndex()).toBe(true);
  });
});
