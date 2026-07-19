import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * Unit tests for the CONTENT-BLIND, PSEUDONYMOUS durable request_log.
 *
 * Privacy invariant under test:
 *   • the table stores ONLY metadata — alias (pseudonym), tier, key_hash, model, route,
 *     status, outcome, token counts, timing — and has NO column for prompt/response content.
 *   • a write failure is best-effort and NEVER propagates to the caller.
 */

let recordRequestLog: typeof import("../src/homeserver/request-log.js").recordRequestLog;
let requestLogColumns: typeof import("../src/homeserver/request-log.js").requestLogColumns;
let requestLogTotals: typeof import("../src/homeserver/request-log.js").requestLogTotals;
let cachedRequestLogTotals: typeof import("../src/homeserver/request-log.js").cachedRequestLogTotals;
let bustStatsCache: typeof import("../src/homeserver/request-log.js").bustStatsCache;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-reqlog-unit-"));
  initDb(join(dir, "test.db"));
  const mod = await import("../src/homeserver/request-log.js");
  recordRequestLog = mod.recordRequestLog;
  requestLogColumns = mod.requestLogColumns;
  requestLogTotals = mod.requestLogTotals;
  cachedRequestLogTotals = mod.cachedRequestLogTotals;
  bustStatsCache = mod.bustStatsCache;
  // Create the table eagerly so beforeEach's DELETE has something to clear.
  mod.ensureRequestLogSchema();
});

/** Minimal row factory so each test only specifies the fields it cares about. */
function row(over: Partial<Parameters<typeof recordRequestLog>[0]> = {}): Parameters<typeof recordRequestLog>[0] {
  return {
    requestId: `r-${Math.random().toString(36).slice(2)}`,
    alias: "alice",
    tier: "guest",
    keyHash: null,
    model: "m1",
    route: "/v1/chat/completions",
    status: 200,
    outcome: "ok",
    errorClass: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    queueWaitMs: null,
    ttftMs: null,
    totalMs: 10,
    admission: "admitted",
    ...over,
  };
}

beforeEach(() => {
  getDb().exec("DELETE FROM request_log");
});

interface CountRow {
  n: number;
}

function rowCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM request_log").get() as CountRow).n;
}

describe("request_log — content-blind schema", () => {
  it("has NO content column (no prompt / response / messages / completion / content)", () => {
    const cols = requestLogColumns().map((c) => c.toLowerCase());
    // Hard privacy gate: not a single column may hold content.
    for (const banned of ["prompt", "response", "messages", "messages_json", "completion", "content", "body", "text"]) {
      expect(cols).not.toContain(banned);
    }
    // Sanity: the metadata columns we DO expect are present.
    for (const expected of ["id", "ts", "alias", "tier", "key_hash", "model", "route", "status", "outcome", "ttft_ms", "total_ms"]) {
      expect(cols).toContain(expected);
    }
  });

  it("writes exactly one row with the correct content-blind fields", () => {
    expect(rowCount()).toBe(0);
    recordRequestLog({
      requestId: "req-1",
      alias: "alice",
      tier: "guest",
      keyHash: "deadbeef",
      model: "qwen3",
      route: "/v1/chat/completions",
      status: 200,
      outcome: "ok",
      errorClass: null,
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
      queueWaitMs: null,
      ttftMs: 42,
      totalMs: 123,
      admission: "admitted",
    });
    expect(rowCount()).toBe(1);
    const row = getDb().prepare("SELECT * FROM request_log WHERE id = 'req-1'").get() as Record<string, unknown>;
    expect(row["alias"]).toBe("alice");
    expect(row["tier"]).toBe("guest");
    expect(row["key_hash"]).toBe("deadbeef");
    expect(row["model"]).toBe("qwen3");
    expect(row["route"]).toBe("/v1/chat/completions");
    expect(row["status"]).toBe(200);
    expect(row["outcome"]).toBe("ok");
    expect(row["prompt_tokens"]).toBe(5);
    expect(row["completion_tokens"]).toBe(7);
    expect(row["total_tokens"]).toBe(12);
    expect(row["ttft_ms"]).toBe(42);
    expect(row["total_ms"]).toBe(123);
    expect(row["admission"]).toBe("admitted");
    expect(typeof row["ts"]).toBe("number");
  });

  it("stores the pseudonym alias and a key_hash but NEVER a raw key", () => {
    recordRequestLog({
      requestId: "req-pseudo",
      alias: "bob-the-friend",
      tier: "guest",
      keyHash: "abc123hash",
      model: "m1",
      route: "/v1/chat/completions",
      status: 200,
      outcome: "ok",
      errorClass: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      queueWaitMs: null,
      ttftMs: null,
      totalMs: 10,
      admission: "admitted",
    });
    const row = getDb().prepare("SELECT * FROM request_log WHERE id = 'req-pseudo'").get() as Record<string, unknown>;
    // The pseudonym (alias) is the identity; key_hash is a hash, not the plaintext.
    expect(row["alias"]).toBe("bob-the-friend");
    expect(row["key_hash"]).toBe("abc123hash");
    // No column may contain anything resembling a raw "hs_" key — there is simply no such column.
    expect(requestLogColumns()).not.toContain("key");
    expect(requestLogColumns()).not.toContain("token");
  });

  it("nullable fields persist as NULL (model/alias/tier coerce-to-default at the call site, not here)", () => {
    recordRequestLog({
      requestId: "req-nulls",
      alias: null,
      tier: null,
      keyHash: null,
      model: "none",
      route: "/healthz",
      status: 200,
      outcome: "ok",
      errorClass: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      queueWaitMs: null,
      ttftMs: null,
      totalMs: 1,
      admission: "n/a",
    });
    const row = getDb().prepare("SELECT * FROM request_log WHERE id = 'req-nulls'").get() as Record<string, unknown>;
    expect(row["alias"]).toBeNull();
    expect(row["tier"]).toBeNull();
    expect(row["key_hash"]).toBeNull();
    expect(row["ttft_ms"]).toBeNull();
    expect(row["model"]).toBe("none");
  });

  it("a write failure is swallowed — recordRequestLog never throws", () => {
    // A duplicate primary key would normally throw inside SQLite; the best-effort wrapper
    // must swallow it so a log write can never break a request.
    const write = (): void =>
      recordRequestLog({
        requestId: "dup-id",
        alias: "a",
        tier: "guest",
        keyHash: null,
        model: "m1",
        route: "/v1/chat/completions",
        status: 200,
        outcome: "ok",
        errorClass: null,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        queueWaitMs: null,
        ttftMs: null,
        totalMs: 5,
        admission: "admitted",
      });
    write();
    // Second insert with the SAME id violates the PK — must NOT throw.
    expect(write).not.toThrow();
    // Still exactly one row (the duplicate was rejected, silently).
    expect((getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE id='dup-id'").get() as CountRow).n).toBe(1);
  });
});

describe("requestLogTotals — content-blind grand aggregate (powers the PUBLIC portal stats)", () => {
  it("returns zeros / null on an empty log", () => {
    expect(requestLogTotals()).toEqual({ totalTokens: 0, totalRequests: 0, since: null });
  });

  it("sums total_tokens and counts rows across all aliases/models (grand totals only)", () => {
    recordRequestLog(row({ requestId: "a1", alias: "alice", model: "m1", totalTokens: 100 }));
    recordRequestLog(row({ requestId: "a2", alias: "bob", model: "m2", totalTokens: 250 }));
    recordRequestLog(row({ requestId: "a3", alias: "carol", model: "m1", totalTokens: 50 }));
    const t = requestLogTotals();
    expect(t.totalTokens).toBe(400);
    expect(t.totalRequests).toBe(3);
  });

  it("treats NULL total_tokens as 0 in the sum but still counts the request", () => {
    recordRequestLog(row({ requestId: "n1", totalTokens: null }));
    recordRequestLog(row({ requestId: "n2", totalTokens: 30 }));
    const t = requestLogTotals();
    expect(t.totalTokens).toBe(30);
    expect(t.totalRequests).toBe(2);
  });

  it("reports `since` as the earliest row timestamp (MIN(ts))", () => {
    recordRequestLog(row({ requestId: "ts1" }));
    const t = requestLogTotals();
    expect(typeof t.since).toBe("number");
    // The earliest ts must not be in the future and must be a real epoch-ms value.
    expect(t.since!).toBeGreaterThan(0);
    expect(t.since!).toBeLessThanOrEqual(Date.now());
  });
});

// ─── cachedRequestLogTotals — origin-side TTL cache (Finding 1) ──────────────────────

describe("cachedRequestLogTotals — origin-side TTL cache", () => {
  beforeEach(() => {
    bustStatsCache();
    getDb().exec("DELETE FROM request_log");
  });

  it("returns the same result on consecutive calls within the TTL (no re-scan)", () => {
    recordRequestLog(row({ requestId: "c1", totalTokens: 42 }));

    const first = cachedRequestLogTotals();
    expect(first.totalRequests).toBe(1);
    expect(first.totalTokens).toBe(42);

    // Insert another row — the TTL has not expired, so the cache must not reflect it.
    recordRequestLog(row({ requestId: "c2", totalTokens: 100 }));

    const second = cachedRequestLogTotals();
    expect(second.totalRequests).toBe(1);   // stale
    expect(second.totalTokens).toBe(42);    // stale
    // Same object reference — proves zero DB scan on the second call.
    expect(second).toBe(first);
  });

  it("bustStatsCache() forces a fresh DB scan on the next call", () => {
    recordRequestLog(row({ requestId: "b1", totalTokens: 10 }));

    const before = cachedRequestLogTotals();
    expect(before.totalRequests).toBe(1);

    recordRequestLog(row({ requestId: "b2", totalTokens: 20 }));
    bustStatsCache();

    const after = cachedRequestLogTotals();
    expect(after.totalRequests).toBe(2);
    expect(after.totalTokens).toBe(30);
    expect(after).not.toBe(before);
  });

  it("propagates throws from requestLogTotals — callers handle DB errors", () => {
    // Drop the table to force a DB error.
    getDb().exec("DROP TABLE IF EXISTS request_log");
    bustStatsCache();

    expect(() => cachedRequestLogTotals()).toThrow();

    // Restore for subsequent tests (ensureRequestLogSchema is idempotent).
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS request_log (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, alias TEXT, tier TEXT, key_hash TEXT,
        model TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
        outcome TEXT NOT NULL, error_class TEXT, prompt_tokens INTEGER,
        completion_tokens INTEGER, total_tokens INTEGER, queue_wait_ms INTEGER,
        ttft_ms INTEGER, total_ms INTEGER NOT NULL, admission TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_ts    ON request_log(ts);
      CREATE INDEX IF NOT EXISTS idx_request_log_alias ON request_log(alias);
      CREATE INDEX IF NOT EXISTS idx_request_log_model ON request_log(model);
    `);
    bustStatsCache();
  });

  it("does NOT cache a failed call — next call after a throw re-queries DB", () => {
    // Drop the table → first call throws.
    getDb().exec("DROP TABLE IF EXISTS request_log");
    bustStatsCache();
    expect(() => cachedRequestLogTotals()).toThrow();

    // Restore the table — the throw must NOT have cached anything, so a fresh call succeeds.
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS request_log (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, alias TEXT, tier TEXT, key_hash TEXT,
        model TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
        outcome TEXT NOT NULL, error_class TEXT, prompt_tokens INTEGER,
        completion_tokens INTEGER, total_tokens INTEGER, queue_wait_ms INTEGER,
        ttft_ms INTEGER, total_ms INTEGER NOT NULL, admission TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_request_log_ts    ON request_log(ts);
      CREATE INDEX IF NOT EXISTS idx_request_log_alias ON request_log(alias);
      CREATE INDEX IF NOT EXISTS idx_request_log_model ON request_log(model);
    `);
    bustStatsCache();

    recordRequestLog(row({ requestId: "post-throw", totalTokens: 7 }));
    const t = cachedRequestLogTotals();
    expect(t.totalRequests).toBe(1);
    expect(t.totalTokens).toBe(7);
  });
});
