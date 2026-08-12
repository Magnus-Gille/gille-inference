import { beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import {
  MAX_KEY_LIFETIME_SECONDS,
  abortKeyRotation,
  commitKeyRotation,
  credentialInventory,
  credentialInventoryReadOnly,
  listKeyRotations,
  lookupKey,
  mintKey,
  preflightKeyRotation,
  recordKeyUse,
  stageKeyRotation,
  type KeyDefaults,
} from "../src/homeserver/keystore.js";

const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeEach(() => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-credential-lifecycle-")), "test.db"));
});

describe("credential lifetime and least-scope policy (#152)", () => {
  it("defaults new owner keys to agent scope and applies a bounded lifetime", () => {
    const minted = mintKey({ alias: "new-owner", tier: "owner" }, DEFAULTS);

    expect(minted.record.scope).toBe("agent");
    expect(minted.record.expiresAt).not.toBeNull();
    const lifetimeMs = Date.parse(minted.record.expiresAt!) - Date.parse(minted.record.createdAt);
    expect(lifetimeMs).toBe(MAX_KEY_LIFETIME_SECONDS.agent * 1_000);
  });

  it("requires explicit admin and rejects a lifetime above that scope's maximum", () => {
    expect(() =>
      mintKey(
        {
          alias: "too-long-admin",
          tier: "owner",
          scope: "admin",
          ttlSeconds: MAX_KEY_LIFETIME_SECONDS.admin + 1,
        },
        DEFAULTS
      )
    ).toThrow(/maximum.*admin|admin.*maximum/i);
    credentialInventory(); // initialize schema through the public seam after the rejected mint
    expect(getDb().prepare("SELECT alias FROM api_keys WHERE alias = ?").get("too-long-admin"))
      .toBeUndefined();
  });

  it("supports a narrow monitor service scope but rejects guest agent/admin authority", () => {
    expect(mintKey({ alias: "heimdall", tier: "guest", scope: "monitor" }, DEFAULTS).record.scope)
      .toBe("monitor");
    expect(() => mintKey({ alias: "guest-agent", tier: "guest", scope: "agent" }, DEFAULTS))
      .toThrow(/guest.*agent|agent.*guest/i);
    expect(() => mintKey({ alias: "guest-admin", tier: "guest", scope: "admin" }, DEFAULTS))
      .toThrow(/guest.*admin|admin.*guest/i);
  });
});

describe("secret-safe credential inventory (#152)", () => {
  it("classifies no-expiry, over-scoped, unused, and stale keys without hashes or plaintext", () => {
    const secret = mintKey(
      { alias: "legacy-service", tier: "owner", scope: "admin" },
      DEFAULTS
    ).plaintextKey;
    getDb().prepare("UPDATE api_keys SET expires_at = NULL WHERE alias = ?").run("legacy-service");

    const stale = mintKey({ alias: "stale-agent", tier: "owner", scope: "agent" }, DEFAULTS);
    recordKeyUse(stale.record.alias, new Date("2026-01-01T00:00:00.000Z"));

    const report = credentialInventory({
      now: new Date("2026-08-01T00:00:00.000Z"),
      staleAfterDays: 30,
    });
    const legacy = report.keys.find((key) => key.alias === "legacy-service");
    const staleEntry = report.keys.find((key) => key.alias === "stale-agent");

    expect(legacy?.findings).toEqual(expect.arrayContaining(["no_expiry", "over_scoped", "unused"]));
    expect(staleEntry?.findings).toContain("stale");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/keyHash|key_hash/i);
    expect(Object.keys(legacy ?? {})).not.toContain("keyHash");
  });

  it("uses a read-only connection without schema setup or database mutation", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "hs-credential-readonly-")), "inventory.db");
    initDb(dbPath);
    const minted = mintKey({ alias: "read-only", tier: "owner", scope: "agent" }, DEFAULTS);
    getDb().close();
    chmodSync(dbPath, 0o444);

    const report = credentialInventoryReadOnly({ dbPath });

    expect(report.summary).toMatchObject({ total: 1, active: 1 });
    expect(report.keys).toMatchObject([{ alias: "read-only", scope: "agent" }]);
    expect(JSON.stringify(report)).not.toContain(minted.plaintextKey);
  });
});

describe("staged credential rotation (#152)", () => {
  it("rejects a predecessor that expires during the overlap before minting a replacement", () => {
    const now = new Date("2026-08-01T10:00:00.000Z");
    mintKey({ alias: "expiring", tier: "owner", scope: "agent" }, DEFAULTS);
    getDb().prepare("UPDATE api_keys SET expires_at = ? WHERE alias = ?")
      .run("2026-08-01T11:00:00.000Z", "expiring");

    expect(() => stageKeyRotation("expiring", {}, DEFAULTS, { now, overlapSeconds: 3_600 }))
      .toThrow(/active predecessor.*overlap/i);
    expect(listKeyRotations()).toEqual([]);

    getDb().prepare("UPDATE api_keys SET expires_at = ? WHERE alias = ?")
      .run("2026-08-01T11:00:00.001Z", "expiring");
    const staged = stageKeyRotation("expiring", {}, DEFAULTS, { now, overlapSeconds: 3_600 });

    expect(staged.plan.overlapExpiresAt).toBe("2026-08-01T11:00:00.000Z");
    expect(listKeyRotations()).toHaveLength(1);
  });

  it("keeps an overlap window, then atomically retires the old key after preflight", () => {
    const old = mintKey({ alias: "codex", tier: "owner", scope: "agent" }, DEFAULTS);
    const staged = stageKeyRotation("codex", {}, DEFAULTS, {
      now: new Date("2026-08-01T10:00:00.000Z"),
      overlapSeconds: 3_600,
    });

    expect(lookupKey(old.plaintextKey, new Date("2026-08-01T10:01:00.000Z"))?.alias).toBe("codex");
    expect(lookupKey(staged.plaintextKey, new Date("2026-08-01T10:01:00.000Z"))?.alias)
      .toBe(staged.newAlias);

    expect(() =>
      commitKeyRotation(staged.plan.planId, new Date("2026-08-01T10:04:00.000Z"))
    ).toThrow(/preflight.*not passed/i);
    expect(() =>
      preflightKeyRotation(staged.plan.planId, new Date("2026-08-01T10:04:15.000Z"))
    ).toThrow(/no successful.*gateway authentication/i);
    recordKeyUse(staged.newAlias, new Date("2026-08-01T10:04:20.000Z"));
    preflightKeyRotation(staged.plan.planId, new Date("2026-08-01T10:04:30.000Z"));
    const committed = commitKeyRotation(staged.plan.planId, new Date("2026-08-01T10:05:00.000Z"));
    expect(committed.revokedAliases).toEqual(["codex"]);
    expect(lookupKey(old.plaintextKey, new Date("2026-08-01T10:05:01.000Z"))).toBeNull();
    expect(lookupKey(staged.plaintextKey, new Date("2026-08-01T10:05:01.000Z"))?.alias)
      .toBe(staged.newAlias);
    expect(listKeyRotations()[0]).toMatchObject({ status: "committed", replacementAlias: staged.newAlias });
  });

  it("aborts safely during overlap by revoking only the replacement", () => {
    const old = mintKey({ alias: "pi", tier: "owner", scope: "agent" }, DEFAULTS);
    const staged = stageKeyRotation("pi", {}, DEFAULTS, {
      now: new Date("2026-08-01T10:00:00.000Z"),
      overlapSeconds: 3_600,
    });

    abortKeyRotation(staged.plan.planId, new Date("2026-08-01T10:05:00.000Z"));
    expect(lookupKey(old.plaintextKey, new Date("2026-08-01T10:05:01.000Z"))?.alias).toBe("pi");
    expect(lookupKey(staged.plaintextKey, new Date("2026-08-01T10:05:01.000Z"))).toBeNull();
    expect(listKeyRotations()[0]?.status).toBe("aborted");
  });

  it("fails commit atomically if the replacement is no longer active", () => {
    const old = mintKey({ alias: "claude", tier: "owner", scope: "agent" }, DEFAULTS);
    const staged = stageKeyRotation("claude", {}, DEFAULTS, {
      now: new Date("2026-08-01T10:00:00.000Z"),
      overlapSeconds: 3_600,
    });
    recordKeyUse(staged.newAlias, new Date("2026-08-01T10:00:20.000Z"));
    preflightKeyRotation(staged.plan.planId, new Date("2026-08-01T10:00:30.000Z"));
    getDb().prepare("UPDATE api_keys SET revoked_at = ? WHERE alias = ?")
      .run("2026-08-01T10:01:00.000Z", staged.newAlias);

    expect(() =>
      commitKeyRotation(staged.plan.planId, new Date("2026-08-01T10:05:00.000Z"))
    ).toThrow(/replacement.*active/i);
    expect(lookupKey(old.plaintextKey, new Date("2026-08-01T10:05:01.000Z"))?.alias).toBe("claude");
    expect(listKeyRotations()[0]?.status).toBe("staged");
  });
});
