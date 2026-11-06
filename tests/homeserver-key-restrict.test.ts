import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  KeyRestrictError,
  abortKeyRotation,
  MAX_KEY_LIFETIME_SECONDS,
  buildCredentialPlan,
  credentialInventory,
  hashKey,
  isScopeNarrowing,
  lookupKey,
  mintKey,
  restrictKey,
  revokeKey,
  stageKeyRotation,
  type KeyDefaults,
  type KeyScope,
} from "../src/homeserver/keystore.js";
import { cmdKeys, parseArgs } from "../src/homeserver/cli.js";

const DEFAULTS: KeyDefaults = { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 };
const NOW = new Date("2026-11-06T12:00:00.000Z");
const DAY = 24 * 60 * 60;

beforeEach(() => {
  // Pin the wall clock (Date only) so mint/expiry arithmetic never depends on the real time.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  initDb(join(mkdtempSync(join(tmpdir(), "hs-restrict-")), "test.db"));
});

afterEach(() => {
  vi.useRealTimers();
});

function legacyAdmin(alias: string): string {
  const { plaintextKey } = mintKey({ alias, tier: "owner", scope: "admin" }, DEFAULTS);
  getDb().prepare("UPDATE api_keys SET expires_at = NULL WHERE alias = ?").run(alias);
  return plaintextKey;
}

function lookupKeyByAlias(alias: string): string {
  return (getDb().prepare("SELECT scope FROM api_keys WHERE alias = ?").get(alias) as { scope: string }).scope;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof KeyRestrictError) return err.code;
    throw err;
  }
  return "no_error";
}

describe("scope partial order (INFER-152)", () => {
  const scopes: KeyScope[] = ["admin", "agent", "ask", "inference", "monitor"];
  const allowed = new Set([
    "admin>agent", "admin>ask", "admin>inference", "admin>monitor",
    "agent>ask", "agent>inference", "inference>ask",
  ]);

  it("allows exactly admin→{agent,inference,monitor} and agent→inference", () => {
    for (const from of scopes) {
      for (const to of scopes) {
        expect(isScopeNarrowing(from, to), `${from}>${to}`).toBe(allowed.has(`${from}>${to}`));
      }
    }
  });
});

describe("keys restrict — narrowing only (INFER-152)", () => {
  it("narrows a no-expiry legacy admin to agent with a bounded expiry in one update", () => {
    const secret = legacyAdmin("legacy");
    const result = restrictKey("legacy", { scope: "agent", expiresInSeconds: 30 * DAY, now: NOW });

    expect(result).toMatchObject({
      changed: true,
      before: { scope: "admin", expiresAt: null },
      after: { scope: "agent", expiresAt: new Date(NOW.getTime() + 30 * DAY * 1000).toISOString() },
    });
    const rec = lookupKey(secret, NOW);
    expect(rec).toMatchObject({ alias: "legacy", scope: "agent" });
    // Key material is untouched: the same plaintext still hashes to the stored hash.
    expect(rec?.keyHash).toBe(hashKey(secret));
  });

  it("narrows to ask only for owner-tier keys; a guest key is refused, not silently reinterpreted", () => {
    mintKey({ alias: "owner-inf", tier: "owner", scope: "inference" }, DEFAULTS);
    mintKey({ alias: "guest-inf", tier: "guest", scope: "inference" }, DEFAULTS);
    expect(restrictKey("owner-inf", { scope: "ask", now: NOW }).after.scope).toBe("ask");
    expect(lookupKeyByAlias("owner-inf")).toBe("ask");
    expect(codeOf(() => restrictKey("guest-inf", { scope: "ask", now: NOW }))).toBe("tier_incompatible");
    expect(lookupKeyByAlias("guest-inf")).toBe("inference");
    // ask itself can narrow to nothing, and cannot move sideways or up.
    for (const to of ["admin", "agent", "inference", "monitor"] as const) {
      expect(codeOf(() => restrictKey("owner-inf", { scope: to, now: NOW }))).toBe("widening_scope");
    }
  });

  it("refuses every widening of scope and leaves the row unchanged", () => {
    mintKey({ alias: "a", tier: "owner", scope: "agent" }, DEFAULTS);
    mintKey({ alias: "i", tier: "guest", scope: "inference" }, DEFAULTS);
    mintKey({ alias: "m", tier: "guest", scope: "monitor" }, DEFAULTS);
    const before = getDb().prepare("SELECT * FROM api_keys ORDER BY alias").all();

    expect(codeOf(() => restrictKey("a", { scope: "admin", now: NOW }))).toBe("widening_scope");
    expect(codeOf(() => restrictKey("a", { scope: "monitor", now: NOW }))).toBe("widening_scope");
    expect(codeOf(() => restrictKey("m", { scope: "ask", now: NOW }))).toBe("widening_scope");
    expect(codeOf(() => restrictKey("i", { scope: "agent", now: NOW }))).toBe("widening_scope");
    expect(codeOf(() => restrictKey("i", { scope: "monitor", now: NOW }))).toBe("widening_scope");
    expect(codeOf(() => restrictKey("m", { scope: "inference", now: NOW }))).toBe("widening_scope");

    expect(getDb().prepare("SELECT * FROM api_keys ORDER BY alias").all()).toEqual(before);
  });

  it("may shorten but never extend an existing expiry", () => {
    mintKey({ alias: "k", tier: "owner", scope: "agent", ttlSeconds: 10 * DAY }, DEFAULTS);
    const original = (getDb().prepare("SELECT expires_at FROM api_keys WHERE alias='k'").get() as { expires_at: string }).expires_at;

    expect(codeOf(() => restrictKey("k", { expiresInSeconds: 80 * DAY, now: new Date(original) }))).toBe("expired");
    const created = Date.parse(
      (getDb().prepare("SELECT created_at FROM api_keys WHERE alias='k'").get() as { created_at: string }).created_at
    );
    const at = new Date(created);
    expect(codeOf(() => restrictKey("k", { expiresInSeconds: 20 * DAY, now: at }))).toBe("widening_expiry");
    expect(restrictKey("k", { expiresInSeconds: 5 * DAY, now: at }).after.expiresAt)
      .toBe(new Date(created + 5 * DAY * 1000).toISOString());
  });

  it("enforces the resulting scope's maximum lifetime, including for a no-expiry key", () => {
    legacyAdmin("legacy");
    expect(codeOf(() => restrictKey("legacy", { expiresInSeconds: MAX_KEY_LIFETIME_SECONDS.admin + 1, now: NOW })))
      .toBe("lifetime_exceeds_scope_max");
    // Narrowing first raises the cap, and the same call is judged against the new scope.
    expect(restrictKey("legacy", { scope: "agent", expiresInSeconds: MAX_KEY_LIFETIME_SECONDS.admin + 1, now: NOW }).changed)
      .toBe(true);
  });

  it("rejects invalid parameters and a no-op", () => {
    legacyAdmin("legacy");
    expect(codeOf(() => restrictKey("legacy", { now: NOW }))).toBe("invalid_param");
    expect(codeOf(() => restrictKey("legacy", { expiresInSeconds: 0, now: NOW }))).toBe("invalid_param");
    expect(codeOf(() => restrictKey("legacy", { expiresInSeconds: -5, now: NOW }))).toBe("invalid_param");
    expect(codeOf(() => restrictKey("legacy", { expiresInSeconds: 1.5, now: NOW }))).toBe("invalid_param");
    expect(codeOf(() => restrictKey("legacy", { scope: "admin", now: NOW }))).toBe("no_change");
  });

  it("refuses unknown, revoked and expired keys", () => {
    expect(codeOf(() => restrictKey("ghost", { scope: "agent", now: NOW }))).toBe("unknown_alias");
    legacyAdmin("gone");
    revokeKey("gone");
    expect(codeOf(() => restrictKey("gone", { scope: "agent", now: NOW }))).toBe("revoked");
    mintKey({ alias: "old", tier: "owner", scope: "agent", ttlSeconds: 60 }, DEFAULTS);
    expect(codeOf(() => restrictKey("old", { expiresInSeconds: 30, now: new Date(NOW.getTime() + 3_600_000) })))
      .toBe("expired");
  });

  it("refuses a key that is part of a staged rotation", () => {
    mintKey({ alias: "svc", tier: "owner", scope: "admin" }, DEFAULTS);
    const staged = stageKeyRotation("svc", { scope: "agent" }, DEFAULTS);
    expect(codeOf(() => restrictKey("svc", { scope: "agent" }))).toBe("staged_rotation");
    expect(codeOf(() => restrictKey(staged.newAlias, { expiresInSeconds: 3_600 }))).toBe("staged_rotation");
  });

  it("dry-run reports the change and writes nothing", () => {
    legacyAdmin("legacy");
    const before = getDb().prepare("SELECT * FROM api_keys WHERE alias='legacy'").get();
    const result = restrictKey("legacy", { scope: "agent", expiresInSeconds: DAY, dryRun: true, now: NOW });
    expect(result).toMatchObject({ dryRun: true, changed: true, after: { scope: "agent" } });
    expect(getDb().prepare("SELECT * FROM api_keys WHERE alias='legacy'").get()).toEqual(before);
  });

  it("changes only scope and expires_at", () => {
    legacyAdmin("legacy");
    const before = getDb().prepare("SELECT * FROM api_keys WHERE alias='legacy'").get() as Record<string, unknown>;
    restrictKey("legacy", { scope: "inference", expiresInSeconds: DAY, now: NOW });
    const after = getDb().prepare("SELECT * FROM api_keys WHERE alias='legacy'").get() as Record<string, unknown>;
    const diff = Object.keys(before).filter((column) => before[column] !== after[column]).sort();
    expect(diff).toEqual(["expires_at", "scope"]);
  });
});

describe("keys restrict — locking, concurrency and audit (INFER-152 review)", () => {
  it("a lost compare-and-swap reports concurrent_change, not no_change", () => {
    legacyAdmin("legacy");
    // RAISE(IGNORE) makes the guarded UPDATE affect zero rows, as if another writer had won.
    getDb().exec(`CREATE TRIGGER ignore_restrict BEFORE UPDATE ON api_keys
      BEGIN SELECT RAISE(IGNORE); END`);
    expect(codeOf(() => restrictKey("legacy", { scope: "agent", now: NOW }))).toBe("concurrent_change");
  });

  it("dry-run takes no write lock: it succeeds while another connection holds one", () => {
    const dbPath = (getDb().pragma("database_list") as Array<{ file: string }>)[0]!.file;
    legacyAdmin("legacy");
    const other = new Database(dbPath);
    other.exec("BEGIN IMMEDIATE");
    try {
      expect(restrictKey("legacy", { scope: "agent", dryRun: true, now: NOW })).toMatchObject({ dryRun: true, changed: true });
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("logs one content-free audit line on a real change and none on dry-run", () => {
    legacyAdmin("legacy");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      restrictKey("legacy", { scope: "agent", expiresInSeconds: DAY, dryRun: true, now: NOW });
      expect(warn).not.toHaveBeenCalled();
      restrictKey("legacy", { scope: "agent", expiresInSeconds: DAY, now: NOW });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toBe(
        "[audit] keys.restrict alias=legacy scope=admin->agent expires=never->2026-11-07T12:00:00.000Z"
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("scope-only narrowing keeps the existing expiry unchanged (documented behaviour)", () => {
    legacyAdmin("legacy");
    const result = restrictKey("legacy", { scope: "agent", now: NOW });
    expect(result.after.expiresAt).toBeNull();
    expect(result.before.expiresAt).toBeNull();
  });

  it("refuses a key in any non-terminal rotation plan (the guard excludes only committed/aborted)", () => {
    mintKey({ alias: "svc", tier: "owner", scope: "admin" }, DEFAULTS);
    const staged = stageKeyRotation("svc", { scope: "agent" }, DEFAULTS);
    expect(codeOf(() => restrictKey("svc", { expiresInSeconds: 3_600, now: NOW }))).toBe("staged_rotation");
    abortKeyRotation(staged.plan.planId);
    // A terminal plan no longer blocks restriction of the surviving predecessor.
    expect(restrictKey("svc", { expiresInSeconds: 3_600, dryRun: true, now: NOW }).changed).toBe(true);
  });
});

describe("keys restrict CLI (INFER-152)", () => {
  function run(argv: string[]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      cmdKeys(parseArgs(argv));
      return log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }
  }

  it("applies, supports --dry-run, and rejects typos and missing arguments", () => {
    legacyAdmin("legacy");
    expect(run(["restrict", "--alias", "legacy", "--scope", "agent", "--dry-run"])).toContain("(dry-run)");
    expect(getDb().prepare("SELECT scope FROM api_keys WHERE alias='legacy'").get()).toEqual({ scope: "admin" });
    expect(run(["restrict", "--alias", "legacy", "--scope", "agent", "--expires-in", String(DAY)])).toContain("restricted");
    expect(getDb().prepare("SELECT scope FROM api_keys WHERE alias='legacy'").get()).toEqual({ scope: "agent" });

    expect(() => run(["restrict", "--alias", "legacy", "--scpoe", "inference"])).toThrow(/unknown flag/);
    expect(() => run(["restrict", "--alias", "legacy"])).toThrow(/usage/);
    expect(() => run(["restrict", "--alias", "legacy", "--scope"])).toThrow(/--scope/);
    expect(() => run(["restrict", "--alias", "legacy", "--scope", "admin"])).toThrow(/not a narrowing|already satisfies/);
  });
});

describe("credential plan and inventory output are secret-free (INFER-152)", () => {
  const PLANTED = {
    HOMESERVER_ADMIN_API_KEYS: "planted-static-admin-9f3a1c",
    HOMESERVER_API_KEYS: "planted-static-user-77be02,planted-static-user-2-c41d9e",
    HOMESERVER_MONITOR_API_KEYS: "planted-static-monitor-5a60b8",
  } as const;
  const saved: Record<string, string | undefined> = {};
  let secrets: string[] = [];
  let hashes: string[] = [];
  let dbPath = "";

  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), "hs-restrict-inv-")), "inv.db");
    initDb(dbPath);
    secrets = [
      legacyAdmin("legacy-admin"),
      mintKey({ alias: "bounded-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey,
      mintKey({ alias: "heimdall", tier: "guest", scope: "monitor" }, DEFAULTS).plaintextKey,
    ];
    hashes = secrets.map(hashKey);
    getDb().close();
    chmodSync(dbPath, 0o444);
    for (const [name, value] of Object.entries(PLANTED)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    saved["EVAL_DB_PATH"] = process.env["EVAL_DB_PATH"];
    process.env["EVAL_DB_PATH"] = dbPath;
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function run(argv: string[]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      cmdKeys(parseArgs(argv));
      return [...log.mock.calls, ...warn.mock.calls].flat().join("\n");
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  }

  function expectClean(output: string): void {
    for (const forbidden of [...secrets, ...hashes, ...Object.values(PLANTED).flatMap((v) => v.split(","))]) {
      expect(output).not.toContain(forbidden);
    }
    expect(output).not.toMatch(/key_?hash/i);
    expect(output).not.toMatch(/\b[0-9a-f]{64}\b/);
  }

  it("reports static counts (not values) in JSON, table, --static and --plan views", () => {
    const json = run(["inventory", "--json"]);
    expectClean(json);
    expect(JSON.parse(json).legacyStaticCredentialCounts).toMatchObject({
      counts: { admin: 1, user: 2, monitor: 1, total: 4 },
      suggestedAction: "migrate to minted keys",
    });

    const table = run(["inventory"]);
    expectClean(table);
    expect(table).toContain("admin=1 user=2 monitor=1 total=4");

    const onlyStatic = run(["inventory", "--static", "--json"]);
    expectClean(onlyStatic);
    expect(JSON.parse(onlyStatic).legacyStaticCredentialCounts.counts.total).toBe(4);
    expectClean(run(["inventory", "--static"]));

    const planJson = run(["inventory", "--plan", "--json"]);
    expectClean(planJson);
    expectClean(run(["inventory", "--plan"]));
    const plan = JSON.parse(planJson).plan as Array<{ alias: string; suggestedAction: string }>;
    // Freshly minted, unused admin without expiry is never "keep" (N7).
    expect(plan.find((entry) => entry.alias === "legacy-admin")?.suggestedAction).toBe("rotate");
  });

  it("--static does not need the keystore and rejects an invalid switch without echoing it", () => {
    process.env["EVAL_DB_PATH"] = join(tmpdir(), "does-not-exist", "nope.db");
    expect(run(["inventory", "--static", "--json"])).toContain('"total": 4');

    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "bogus-switch-value";
    try {
      expect(() => run(["inventory", "--static"])).toThrow(/HOMESERVER_DISABLE_STATIC_KEYS/);
      let message = "";
      try { run(["inventory", "--static"]); } catch (err) { message = (err as Error).message; }
      expect(message).not.toContain("bogus-switch-value");
    } finally {
      delete process.env["HOMESERVER_DISABLE_STATIC_KEYS"];
    }
  });

  it("rejects combining --static with --plan", () => {
    expect(() => run(["inventory", "--static", "--plan"])).toThrow(/mutually exclusive/);
  });
});

describe("flag combinations on inventory (INFER-152 + INFER-450)", () => {
  function runInv(argv: string[]): string {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      cmdKeys(parseArgs(argv));
      return log.mock.calls.flat().join("\n");
    } finally {
      log.mockRestore();
    }
  }

  function seed(): void {
    const dbPath = join(mkdtempSync(join(tmpdir(), "hs-inv-combo-")), "inv.db");
    initDb(dbPath);
    mintKey({ alias: "ask-key", tier: "owner", scope: "ask" }, DEFAULTS);
    mintKey({ alias: "agent-key", tier: "owner", scope: "agent" }, DEFAULTS);
    getDb().prepare("UPDATE api_keys SET expires_at = NULL, use_count = 4, last_used_at = '2026-11-05T00:00:00.000Z' WHERE alias = 'ask-key'").run();
    getDb().close();
    chmodSync(dbPath, 0o444);
    process.env["EVAL_DB_PATH"] = dbPath;
  }

  it("--plan --scope ask lists only ask keys and respects the 90-day cap", () => {
    seed();
    const out = JSON.parse(runInv(["inventory", "--plan", "--scope", "ask", "--json"]));
    expect(out.plan.map((e: { alias: string }) => e.alias)).toEqual(["ask-key"]);
    expect(out.plan[0]).toMatchObject({
      scope: "ask", suggestedAction: "keep+expiry", maxExpiresInSeconds: MAX_KEY_LIFETIME_SECONDS.ask,
    });
    expect(out.plan[0].reason).toMatch(/at most 90 days \(ask cap\)/);
  });

  it("an ask key whose expiry is beyond the cap is told to shorten it", () => {
    seed();
    const far = new Date(NOW.getTime() + 200 * DAY * 1000).toISOString();
    // Rebuild a plan from a report with a far expiry (pure function; no write to the read-only DB).
    const entry = buildCredentialPlan({
      generatedAt: NOW.toISOString(), staleAfterDays: 30,
      summary: { total: 1, active: 1, expired: 0, revoked: 0, findings: {} as never },
      keys: [{
        alias: "ask-far", tier: "owner", scope: "ask", expiresAt: far, createdAt: NOW.toISOString(),
        lastUsedAt: NOW.toISOString(), useCount: 5, status: "active", findings: [],
      } as never],
    })[0]!;
    expect(entry.suggestedAction).toBe("keep+expiry");
    expect(entry.reason).toMatch(/beyond the 90-day ask cap/);
  });

  it("--static with --scope or --plan, and --plan with --static, are rejected", () => {
    seed();
    expect(() => runInv(["inventory", "--static", "--scope", "ask"])).toThrow(/cannot be combined with --static/);
    expect(() => runInv(["inventory", "--static", "--plan"])).toThrow(/mutually exclusive/);
    expect(() => runInv(["inventory", "--scope"])).toThrow(/--scope/);
    expect(() => runInv(["inventory", "--scope", "bogus"])).toThrow(/--scope/);
  });

  it("--scope alone still filters the table and JSON and carries static counts", () => {
    seed();
    const out = JSON.parse(runInv(["inventory", "--scope", "ask", "--json"]));
    expect(out.keys.map((k: { alias: string }) => k.alias)).toEqual(["ask-key"]);
    expect(out.legacyStaticCredentialCounts.counts).toBeDefined();
  });
});

describe("credential plan suggestions (INFER-152)", () => {
  it("maps each situation to one action", () => {
    const t0 = new Date("2026-01-01T00:00:00.000Z");
    const inventoryNow = NOW;
    // active admin, used recently, no expiry → rotate
    legacyAdmin("admin-noexp");
    // active admin with expiry, used → narrow
    mintKey({ alias: "admin-exp", tier: "owner", scope: "admin" }, DEFAULTS);
    // agent with no expiry, used → keep+expiry
    mintKey({ alias: "agent-noexp", tier: "owner", scope: "agent" }, DEFAULTS);
    getDb().prepare("UPDATE api_keys SET expires_at = NULL WHERE alias = 'agent-noexp'").run();
    // bounded and used → keep
    mintKey({ alias: "fine", tier: "guest", scope: "inference" }, DEFAULTS);
    // never used and old → retire
    mintKey({ alias: "idle", tier: "guest", scope: "inference" }, DEFAULTS);
    // never used but fresh → keep
    mintKey({ alias: "fresh", tier: "guest", scope: "inference" }, DEFAULTS);
    // fresh, never-used admin must never be "keep" (N7): no expiry → rotate, with expiry → narrow
    legacyAdmin("fresh-admin-noexp");
    mintKey({ alias: "fresh-admin-exp", tier: "owner", scope: "admin" }, DEFAULTS);
    getDb().prepare("UPDATE api_keys SET created_at = ? WHERE alias NOT LIKE 'fresh%'").run(t0.toISOString());
    for (const alias of ["admin-noexp", "admin-exp", "agent-noexp", "fine"]) {
      getDb().prepare("UPDATE api_keys SET last_used_at = ?, use_count = 3 WHERE alias = ?")
        .run("2026-11-01T00:00:00.000Z", alias);
    }

    getDb().prepare("UPDATE api_keys SET created_at = ? WHERE alias = 'fresh'").run("2026-11-05T00:00:00.000Z");
    const report = credentialInventory({ now: inventoryNow, staleAfterDays: 30 });
    const actions = Object.fromEntries(
      buildCredentialPlan(report)
        .map((entry) => [entry.alias, entry.suggestedAction])
    );
    expect(report.keys).toHaveLength(8);
    expect(actions).toEqual({
      "admin-noexp": "rotate",
      "admin-exp": "narrow",
      "agent-noexp": "keep+expiry",
      fine: "keep",
      idle: "retire",
      fresh: "keep",
      "fresh-admin-noexp": "rotate",
      "fresh-admin-exp": "narrow",
    });
  });
});
