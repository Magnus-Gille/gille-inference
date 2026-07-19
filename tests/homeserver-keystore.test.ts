import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import {
  mintKey,
  lookupKey,
  revokeKey,
  listKeys,
  hashKey,
  rotateKey,
  nextFreeAlias,
  KeyAliasExistsError,
  createInvite,
  reserveCredits,
  reconcileCredits,
  recordUsage,
  InvalidParamError,
  type KeyDefaults,
} from "../src/homeserver/keystore.js";

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "hs-keystore-test-"));
  initDb(join(dir, "test.db"));
});

const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };

let n = 0;
function alias(): string {
  return `k-${n++}`;
}

describe("keystore mint / lookup", () => {
  it("mintKey returns a tier-prefixed plaintext key and persists only a hash", () => {
    const a = alias();
    const owner = mintKey({ alias: a, tier: "owner" }, DEFAULTS);
    expect(owner.plaintextKey.startsWith("hs_owner_")).toBe(true);
    expect("keyHash" in owner.record).toBe(false);

    const guest = mintKey({ alias: alias(), tier: "guest" }, DEFAULTS);
    expect(guest.plaintextKey.startsWith("hs_guest_")).toBe(true);

    // Plaintext must never be stored — the stored hash differs from plaintext.
    const row = getDb()
      .prepare("SELECT key_hash FROM api_keys WHERE alias = ?")
      .get(a) as { key_hash: string };
    expect(row.key_hash).not.toBe(owner.plaintextKey);
    expect(row.key_hash).toBe(hashKey(owner.plaintextKey));
    // No plaintext column exists at all.
    const cols = getDb().prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "plaintext")).toBe(false);
  });

  it("lookupKey resolves the right record and rejects an unknown token", () => {
    const a = alias();
    const { plaintextKey } = mintKey({ alias: a, tier: "guest" }, DEFAULTS);
    const rec = lookupKey(plaintextKey);
    expect(rec?.alias).toBe(a);
    expect(lookupKey("wrong")).toBeNull();
  });

  it("two keys never cross-match", () => {
    const a1 = alias();
    const a2 = alias();
    const k1 = mintKey({ alias: a1, tier: "owner" }, DEFAULTS);
    const k2 = mintKey({ alias: a2, tier: "guest" }, DEFAULTS);
    expect(lookupKey(k1.plaintextKey)?.alias).toBe(a1);
    expect(lookupKey(k2.plaintextKey)?.alias).toBe(a2);
  });

  it("revokeKey soft-revokes; subsequent lookup is null; second revoke is false", () => {
    const a = alias();
    const { plaintextKey } = mintKey({ alias: a, tier: "guest" }, DEFAULTS);
    expect(revokeKey(a)).toBe(true);
    expect(lookupKey(plaintextKey)).toBeNull();
    expect(revokeKey(a)).toBe(false);
    expect(revokeKey("never-existed")).toBe(false);
  });

  it("expiry is enforced against the provided now", () => {
    const a = alias();
    const { plaintextKey } = mintKey({ alias: a, tier: "guest", ttlSeconds: 1 }, DEFAULTS);
    const before = new Date(Date.now() - 1000);
    const after = new Date(Date.now() + 10_000);
    expect(lookupKey(plaintextKey, before)?.alias).toBe(a);
    expect(lookupKey(plaintextKey, after)).toBeNull();
  });

  it("listKeys excludes revoked by default, includes with flag, never leaks keyHash", () => {
    const live = alias();
    const dead = alias();
    mintKey({ alias: live, tier: "guest" }, DEFAULTS);
    mintKey({ alias: dead, tier: "guest" }, DEFAULTS);
    revokeKey(dead);

    const def = listKeys();
    expect(def.some((r) => r.alias === live)).toBe(true);
    expect(def.some((r) => r.alias === dead)).toBe(false);
    for (const r of def) expect("keyHash" in r).toBe(false);

    const all = listKeys({ includeRevoked: true });
    expect(all.some((r) => r.alias === dead)).toBe(true);
    for (const r of all) expect("keyHash" in r).toBe(false);
  });

  it("hashKey is stable and equals the stored hash", () => {
    const a = alias();
    const { plaintextKey } = mintKey({ alias: a, tier: "owner" }, DEFAULTS);
    const h1 = hashKey(plaintextKey);
    const h2 = hashKey(plaintextKey);
    expect(h1).toBe(h2);
    const row = getDb()
      .prepare("SELECT key_hash FROM api_keys WHERE alias = ?")
      .get(a) as { key_hash: string };
    expect(row.key_hash).toBe(h1);
  });

  it("mint honours overrides for limits and allow-list", () => {
    const a = alias();
    const { record } = mintKey(
      {
        alias: a,
        tier: "guest",
        modelAllowList: ["m1", "m2"],
        rpm: 5,
        tpm: 500,
        dailyTokenBudget: 1000,
        maxParallel: 2,
      },
      DEFAULTS
    );
    expect(record.modelAllowList).toEqual(["m1", "m2"]);
    expect(record.rpm).toBe(5);
    expect(record.tpm).toBe(500);
    expect(record.dailyTokenBudget).toBe(1000);
    expect(record.maxParallel).toBe(2);
  });
});

// ─── Fix #5 — integer-param validation (the "-1 ⇒ unlimited" foot-gun) ────────────────

describe("mint / invite param validation (Fix #5)", () => {
  it("rejects a negative creditLimit (would read as unlimited otherwise)", () => {
    expect(() => mintKey({ alias: alias(), tier: "guest", creditLimit: -1 }, DEFAULTS)).toThrow(
      InvalidParamError
    );
  });

  it("rejects a fractional creditLimit", () => {
    expect(() => mintKey({ alias: alias(), tier: "guest", creditLimit: 1.5 }, DEFAULTS)).toThrow(
      InvalidParamError
    );
  });

  it("rejects negative / fractional rpm, tpm, daily, parallel, ttl", () => {
    expect(() => mintKey({ alias: alias(), tier: "guest", rpm: -1 }, DEFAULTS)).toThrow(InvalidParamError);
    expect(() => mintKey({ alias: alias(), tier: "guest", tpm: 2.5 }, DEFAULTS)).toThrow(InvalidParamError);
    expect(() => mintKey({ alias: alias(), tier: "guest", dailyTokenBudget: -5 }, DEFAULTS)).toThrow(
      InvalidParamError
    );
    expect(() => mintKey({ alias: alias(), tier: "guest", maxParallel: -1 }, DEFAULTS)).toThrow(
      InvalidParamError
    );
    expect(() => mintKey({ alias: alias(), tier: "guest", ttlSeconds: -10 }, DEFAULTS)).toThrow(
      InvalidParamError
    );
  });

  it("a rejected mint leaves no key row behind", () => {
    const a = alias();
    expect(() => mintKey({ alias: a, tier: "guest", creditLimit: -1 }, DEFAULTS)).toThrow();
    const row = getDb().prepare("SELECT alias FROM api_keys WHERE alias = ?").get(a);
    expect(row).toBeUndefined();
  });

  it("createInvite rejects a negative creditLimit", () => {
    expect(() => createInvite({ label: alias(), tier: "guest", creditLimit: -1 })).toThrow(
      InvalidParamError
    );
  });

  it("0 stays valid (unlimited), and a normal positive integer passes", () => {
    expect(() => mintKey({ alias: alias(), tier: "guest", creditLimit: 0 }, DEFAULTS)).not.toThrow();
    expect(() => mintKey({ alias: alias(), tier: "guest", creditLimit: 1000 }, DEFAULTS)).not.toThrow();
  });
});

// ─── Fix #3 — atomic credit reservation primitives ───────────────────────────────────

describe("atomic credit reserve / reconcile (Fix #3)", () => {
  it("reserveCredits debits only while under the limit, then rejects", () => {
    const { plaintextKey } = mintKey({ alias: alias(), tier: "guest", creditLimit: 100 }, DEFAULTS);
    const h = lookupKey(plaintextKey)!.keyHash;
    expect(reserveCredits(h, 60).ok).toBe(true); // used=0 → 0+60=60 <= 100: ok
    // used=60, amount=60 → would reach 120 > 100: must be REJECTED
    expect(reserveCredits(h, 60).ok).toBe(false);
    // credits_used must not have changed from the rejected call
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(60);
    // exact-fit: 60+40=100 == limit: must be ALLOWED
    expect(reserveCredits(h, 40).ok).toBe(true);
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(100);
    // now at limit: any further reservation must fail
    expect(reserveCredits(h, 1).ok).toBe(false);
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(100);
  });

  it("reserveCredits on an unlimited key (creditLimit 0) always admits and accrues", () => {
    const { plaintextKey } = mintKey({ alias: alias(), tier: "guest", creditLimit: 0 }, DEFAULTS);
    const h = lookupKey(plaintextKey)!.keyHash;
    expect(reserveCredits(h, 5_000).ok).toBe(true);
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(5_000);
  });

  it("reconcileCredits adjusts a reservation to real usage (over- and under-estimate)", () => {
    const { plaintextKey } = mintKey({ alias: alias(), tier: "guest", creditLimit: 10_000 }, DEFAULTS);
    const h = lookupKey(plaintextKey)!.keyHash;
    reserveCredits(h, 500); // reserve 500
    reconcileCredits(h, 500, 120); // real usage 120 → net 120
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(120);

    reserveCredits(h, 100); // reserve 100 → 220
    reconcileCredits(h, 100, 300); // real usage 300 → net 120 + 300 = 420
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(420);
  });

  it("reconcile to 0 fully releases a reservation (failed/errored call)", () => {
    const { plaintextKey } = mintKey({ alias: alias(), tier: "guest", creditLimit: 10_000 }, DEFAULTS);
    const h = lookupKey(plaintextKey)!.keyHash;
    reserveCredits(h, 800);
    reconcileCredits(h, 800, 0); // errored call charges nothing
    expect(lookupKey(plaintextKey)!.creditsUsed).toBe(0);
    void recordUsage; // referenced for parity with sibling import
  });
});

// ─── #99 — keys rotate (same-alias rotation footgun) ──────────────────────────────────

describe("nextFreeAlias (pure)", () => {
  it("uses the bare alias when free, else the lowest free -rN", () => {
    expect(nextFreeAlias("harness", [])).toBe("harness");
    expect(nextFreeAlias("harness", ["harness"])).toBe("harness-r2");
    expect(nextFreeAlias("harness", ["harness", "harness-r2"])).toBe("harness-r3");
  });

  it("fills the lowest free slot rather than chasing the max index", () => {
    // bare + -r5 taken but -r2 free → returns -r2 (no collision; the alias is just a label).
    expect(nextFreeAlias("h", ["h", "h-r5"])).toBe("h-r2");
    expect(nextFreeAlias("h", ["h", "h-r2", "h-r3"])).toBe("h-r4");
  });

  it("is overflow-proof against a crafted huge pre-existing suffix (Codex #99 medium-2)", () => {
    // A parse-the-suffix approach would compute MAX_SAFE_INTEGER+1 → precision loss / collision.
    // The incremental scan just returns the lowest free slot, ignoring the huge alias entirely.
    expect(nextFreeAlias("h", ["h", "h-r9007199254740993"])).toBe("h-r2");
  });

  it("accepts a Set and treats the name literally (no regex semantics)", () => {
    expect(nextFreeAlias("a.b", new Set(["a.b"]))).toBe("a.b-r2");
    expect(nextFreeAlias("a.b", new Set(["axb"]))).toBe("a.b"); // 'axb' does not collide
  });
});

describe("rotateKey (#99)", () => {
  it("rotates a fresh name: mints the bare alias, revokes nothing, key works", () => {
    const base = alias();
    const r = rotateKey(base, { tier: "owner" }, DEFAULTS);
    expect(r.newAlias).toBe(base);
    expect(r.revokedAliases).toEqual([]);
    expect(r.plaintextKey.startsWith("hs_owner_")).toBe(true);
    expect(lookupKey(r.plaintextKey)?.alias).toBe(base);
  });

  it("inherits tier + limits from the current active key and revokes it atomically", () => {
    const base = alias();
    const first = mintKey(
      { alias: base, tier: "guest", modelAllowList: ["m1"], rpm: 7, tpm: 700, dailyTokenBudget: 70, maxParallel: 3, creditLimit: 5000 },
      DEFAULTS
    );
    // Rotate WITHOUT re-specifying tier/limits — they must be inherited.
    const rot = rotateKey(base, {}, DEFAULTS);
    expect(rot.newAlias).toBe(`${base}-r2`);
    expect(rot.revokedAliases).toEqual([base]);
    // Old key no longer authenticates; new one does.
    expect(lookupKey(first.plaintextKey)).toBeNull();
    const live = lookupKey(rot.plaintextKey)!;
    expect(live.alias).toBe(`${base}-r2`);
    expect(live.tier).toBe("guest");
    expect(live.modelAllowList).toEqual(["m1"]);
    expect(live.rpm).toBe(7);
    expect(live.creditLimit).toBe(5000);
    expect(live.creditsUsed).toBe(0); // fresh balance
  });

  it("explicit opts override inherited settings", () => {
    const base = alias();
    mintKey({ alias: base, tier: "guest", rpm: 7 }, DEFAULTS);
    const rot = rotateKey(base, { rpm: 99, modelAllowList: ["only-this"] }, DEFAULTS);
    const live = lookupKey(rot.plaintextKey)!;
    expect(live.rpm).toBe(99);
    expect(live.modelAllowList).toEqual(["only-this"]);
    expect(live.tier).toBe("guest"); // tier still inherited
  });

  it("rotating a brand-new name without --tier is rejected (nothing to inherit)", () => {
    expect(() => rotateKey(alias(), {}, DEFAULTS)).toThrow(/--tier/);
  });

  it("repeated rotation keeps exactly one active key for the logical name", () => {
    const base = alias();
    const r1 = rotateKey(base, { tier: "owner" }, DEFAULTS); // base
    const r2 = rotateKey(base, {}, DEFAULTS); // base-r2
    const r3 = rotateKey(base, {}, DEFAULTS); // base-r3
    expect([r1.newAlias, r2.newAlias, r3.newAlias]).toEqual([base, `${base}-r2`, `${base}-r3`]);
    // Family is column-defined: filter active keys by logicalAlias (plus the bare original).
    const activeInFamily = listKeys().filter((k) => k.logicalAlias === base || k.alias === base);
    expect(activeInFamily.map((k) => k.alias)).toEqual([`${base}-r3`]);
    expect(lookupKey(r1.plaintextKey)).toBeNull();
    expect(lookupKey(r2.plaintextKey)).toBeNull();
    expect(lookupKey(r3.plaintextKey)?.alias).toBe(`${base}-r3`);
  });

  it("does NOT sweep an unrelated standalone key that merely looks like a rotation (Codex #99 medium-1)", () => {
    const base = alias();
    mintKey({ alias: base, tier: "owner" }, DEFAULTS);
    // A separate, independently-minted key whose NAME matches the -rN shape but is NOT a rotation
    // of `base` (it carries logical_alias = NULL).
    const bystander = mintKey({ alias: `${base}-r2`, tier: "guest", rpm: 3 }, DEFAULTS);

    const rot = rotateKey(base, {}, DEFAULTS);
    // It must skip the occupied `${base}-r2` and only revoke the real `base`.
    expect(rot.newAlias).toBe(`${base}-r3`);
    expect(rot.revokedAliases).toEqual([base]);
    // The bystander must remain ACTIVE and unchanged — never swept into base's family.
    const survivor = lookupKey(bystander.plaintextKey);
    expect(survivor?.alias).toBe(`${base}-r2`);
    expect(survivor?.tier).toBe("guest");
    expect(survivor?.rpm).toBe(3);
  });

  it("rolls back the revoke when the mint fails (atomicity — Codex #99 low-4)", () => {
    const base = alias();
    const first = mintKey({ alias: base, tier: "owner" }, DEFAULTS);
    // A negative rpm makes mintKey throw AFTER the revoke loop has run inside the transaction.
    expect(() => rotateKey(base, { rpm: -1 }, DEFAULTS)).toThrow(InvalidParamError);
    // The transaction must have rolled back: the original key is still active.
    expect(lookupKey(first.plaintextKey)?.alias).toBe(base);
    expect(lookupKey(first.plaintextKey)?.revokedAt).toBeNull();
  });

  it("rejects rotating a CHILD alias and leaves it ACTIVE (self-review #99 high)", () => {
    const base = alias();
    rotateKey(base, { tier: "owner" }, DEFAULTS); // base (logical_alias = base)
    const child = rotateKey(base, {}, DEFAULTS); // base-r2 (logical_alias = base), active
    // Targeting the rotation child instead of the logical name must be REFUSED, not silently
    // mint an orphan `base-r2-r2` and leave base-r2 live.
    expect(() => rotateKey(`${base}-r2`, { tier: "owner" }, DEFAULTS)).toThrow(
      new RegExp(`rotation of '${base}'`)
    );
    // The child key is untouched and still authenticates.
    expect(lookupKey(child.plaintextKey)?.alias).toBe(`${base}-r2`);
    // …and rotating the LOGICAL name still works (the self case logical_alias===alias is allowed).
    const next = rotateKey(base, {}, DEFAULTS);
    expect(next.newAlias).toBe(`${base}-r3`);
    expect(lookupKey(child.plaintextKey)).toBeNull(); // base-r2 now revoked by the real rotation
  });

  it("rotate honours a --credits override, else inherits the cap", () => {
    const base = alias();
    mintKey({ alias: base, tier: "guest", creditLimit: 100 }, DEFAULTS);
    const lifted = rotateKey(base, { creditLimit: 500 }, DEFAULTS);
    expect(lookupKey(lifted.plaintextKey)?.creditLimit).toBe(500);
    const inherited = rotateKey(base, {}, DEFAULTS);
    expect(lookupKey(inherited.plaintextKey)?.creditLimit).toBe(500); // carried from the prior key
  });

  it("is the fix for the footgun: revoke+re-mint same alias fails, rotate succeeds", () => {
    const base = alias();
    const first = mintKey({ alias: base, tier: "owner" }, DEFAULTS);
    expect(revokeKey(base)).toBe(true);
    // The intuitive rotation fails — alias is the PRIMARY KEY, revoked row still owns it.
    expect(() => mintKey({ alias: base, tier: "owner" }, DEFAULTS)).toThrow(KeyAliasExistsError);
    // rotate handles it (inheriting tier from the now-revoked original): fresh alias, old dead.
    const rot = rotateKey(base, {}, DEFAULTS);
    expect(rot.newAlias).toBe(`${base}-r2`);
    expect(lookupKey(first.plaintextKey)).toBeNull();
    expect(lookupKey(rot.plaintextKey)?.alias).toBe(`${base}-r2`);
  });
});
