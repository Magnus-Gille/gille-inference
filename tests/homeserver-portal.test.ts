import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * Self-service portal suite: lifetime credit accounting, one-time invite lifecycle, and the
 * portal HTTP surface (redeem / me / credits_exhausted).
 *
 * Runs in keystore-only mode (no legacy static keys) with a controllable stub upstream so no
 * real model is needed. Env is set BEFORE importing config/gateway (config is cached at first
 * import), and a throwaway DB is isolated per the project convention.
 */

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      );
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    })
  );
}

// Bound after dynamic import in beforeAll.
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let recordCreditUsage: typeof import("../src/homeserver/keystore.js").recordUsage;
let isCreditExhausted: typeof import("../src/homeserver/keystore.js").isCreditExhausted;
let createInvite: typeof import("../src/homeserver/keystore.js").createInvite;
let redeemInvite: typeof import("../src/homeserver/keystore.js").redeemInvite;
let InviteInvalidError: typeof import("../src/homeserver/keystore.js").InviteInvalidError;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-portal-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  // High per-IP public throttle so this suite's many same-IP redeem/GET hits aren't throttled;
  // the throttle's 429 behaviour is exercised in its own isolated suite with a low limit.
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  // Keystore-only: no static keys. A store key is minted before startGateway so listKeys()
  // is non-empty at bind time (otherwise loopback bootstraps implicit-admin).
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  recordCreditUsage = ks.recordUsage;
  isCreditExhausted = ks.isCreditExhausted;
  createInvite = ks.createInvite;
  redeemInvite = ks.redeemInvite;
  InviteInvalidError = ks.InviteInvalidError;

  // Seed a key so the gateway does not fall into implicit-admin bootstrap.
  mintKey({ alias: "portal-seed-owner", tier: "owner" }, DEFAULTS);

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

let uid = 0;
function uniq(p: string): string {
  return `${p}-${uid++}`;
}

// ─── Credit accounting (unit) ───────────────────────────────────────────────────────

describe("credit accounting", () => {
  it("recordUsage accrues against the key's lifetime budget", () => {
    const { plaintextKey } = mintKey({ alias: uniq("cred"), tier: "guest", creditLimit: 1000 }, DEFAULTS);
    const rec0 = lookupKey(plaintextKey)!;
    expect(rec0.creditsUsed).toBe(0);

    recordCreditUsage(rec0.keyHash, 250);
    recordCreditUsage(rec0.keyHash, 100);
    const rec1 = lookupKey(plaintextKey)!;
    expect(rec1.creditsUsed).toBe(350);
  });

  it("a key at/over its creditLimit is exhausted; under is not", () => {
    expect(isCreditExhausted({ creditLimit: 1000, creditsUsed: 999 })).toBe(false);
    expect(isCreditExhausted({ creditLimit: 1000, creditsUsed: 1000 })).toBe(true);
    expect(isCreditExhausted({ creditLimit: 1000, creditsUsed: 1500 })).toBe(true);
  });

  it("creditLimit=0 is unlimited (never exhausted, accrual still tracked)", () => {
    const { plaintextKey } = mintKey({ alias: uniq("unl"), tier: "guest", creditLimit: 0 }, DEFAULTS);
    const rec = lookupKey(plaintextKey)!;
    recordCreditUsage(rec.keyHash, 10_000_000);
    const rec2 = lookupKey(plaintextKey)!;
    expect(rec2.creditsUsed).toBe(10_000_000);
    expect(isCreditExhausted(rec2)).toBe(false);
  });
});

// ─── Invite lifecycle (unit) ────────────────────────────────────────────────────────

describe("invite lifecycle", () => {
  it("createInvite → redeemInvite mints a key carrying the invite's limits", () => {
    const { code } = createInvite({
      label: uniq("inv"),
      tier: "guest",
      creditLimit: 12_345,
      modelAllowList: ["only-model"],
      aliasPrefix: "alice",
    });
    expect(code.startsWith("inv_")).toBe(true);

    const minted = redeemInvite(code, DEFAULTS);
    expect(minted.record.tier).toBe("guest");
    expect(minted.record.creditLimit).toBe(12_345);
    expect(minted.record.modelAllowList).toEqual(["only-model"]);
    expect(minted.record.alias.startsWith("alice-")).toBe(true);
    // The minted key actually authenticates.
    expect(lookupKey(minted.plaintextKey)?.alias).toBe(minted.record.alias);
  });

  it("a second redeem of the same code fails (strictly one-time)", () => {
    const { code } = createInvite({ label: uniq("inv"), tier: "guest", creditLimit: 100 });
    redeemInvite(code, DEFAULTS);
    expect(() => redeemInvite(code, DEFAULTS)).toThrow(InviteInvalidError);
  });

  it("an unknown code fails with the same uniform error", () => {
    expect(() => redeemInvite("inv_does-not-exist", DEFAULTS)).toThrow(InviteInvalidError);
  });

  // Fix #4 — mint + mark-redeemed are one transaction: a lost race leaves NO orphan key.
  it("a lost double-redeem leaves no orphan key (transactional, Fix #4)", () => {
    const { code } = createInvite({ label: uniq("inv"), tier: "guest", creditLimit: 100, aliasPrefix: "racer" });
    const keysBefore = getDb()
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE alias LIKE 'racer-%'")
      .get() as { n: number };
    expect(keysBefore.n).toBe(0);

    // First redeem wins and mints exactly one key.
    const minted = redeemInvite(code, DEFAULTS);
    // Second redeem of the same (now-redeemed) code loses → throws and mints NOTHING.
    expect(() => redeemInvite(code, DEFAULTS)).toThrow(InviteInvalidError);

    // Exactly one key carries the invite's prefix — the loser left no orphan, even partially.
    const keysAfter = getDb()
      .prepare("SELECT COUNT(*) AS n FROM api_keys WHERE alias LIKE 'racer-%'")
      .get() as { n: number };
    expect(keysAfter.n).toBe(1);
    expect(lookupKey(minted.plaintextKey)?.alias).toBe(minted.record.alias);
  });
});

// ─── POST /portal/redeem (HTTP) ─────────────────────────────────────────────────────

describe("POST /portal/redeem", () => {
  it("a valid code returns 200 + a usable key (unauthenticated)", async () => {
    const { code } = createInvite({ label: uniq("inv"), tier: "guest", creditLimit: 5000, modelAllowList: ["m1"] });
    const res = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(200);
    // Fix #7: the key-bearing redeem response must not be cached.
    expect(res.headers.get("cache-control")).toBe("no-store");
    const j = (await res.json()) as { key: string; alias: string; model: string | null; creditLimit: number };
    expect(typeof j.key).toBe("string");
    expect(j.key.startsWith("hs_guest_")).toBe(true);
    expect(j.creditLimit).toBe(5000);
    expect(j.model).toBe("m1");
    expect(lookupKey(j.key)?.alias).toBe(j.alias);
  });

  it("a used code returns an enveloped 4xx and never a second key", async () => {
    const { code } = createInvite({ label: uniq("inv"), tier: "guest", creditLimit: 5000 });
    const first = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(first.status).toBe(200);

    const second = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    expect(second.status).toBe(409);
    const j = (await second.json()) as { error: { code: string; message: string } };
    // Fix #6: a dedicated invite_invalid code (no longer reusing alias_exists).
    expect(j.error.code).toBe("invite_invalid");
    expect(j).not.toHaveProperty("key");
  });

  it("unknown and already-used codes return an IDENTICAL body (no enumeration oracle, Fix #6)", async () => {
    const { code } = createInvite({ label: uniq("inv"), tier: "guest", creditLimit: 1 });
    await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const usedRes = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const unknownRes = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "inv_totally-unknown" }),
    });
    expect(usedRes.status).toBe(unknownRes.status);
    expect(await usedRes.text()).toBe(await unknownRes.text());
  });

  it("a missing/empty code returns an enveloped 400", async () => {
    const res = await fetch(url("/portal/redeem"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "" }),
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_request_error");
  });
});

// ─── GET /portal and GET / (HTML) ───────────────────────────────────────────────────

describe("portal page", () => {
  it("GET /portal serves HTML unauthenticated", async () => {
    const res = await fetch(url("/portal"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Inference Portal");
  });

  it("the portal HTML carries hardening headers (Fix #7)", async () => {
    const res = await fetch(url("/portal"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'unsafe-inline'");
    expect(csp).toContain("style-src 'unsafe-inline'");
  });

  it("GET / also serves the portal HTML", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
  });
});

// ─── GET /portal/stats (PUBLIC, content-blind grand aggregate) ──────────────────────

describe("GET /portal/stats", () => {
  it("is reachable UNAUTHENTICATED and returns only grand totals", async () => {
    // Seed the durable log directly so the aggregate is deterministic regardless of test order.
    const { ensureRequestLogSchema, recordRequestLog } = await import("../src/homeserver/request-log.js");
    ensureRequestLogSchema();
    getDb().exec("DELETE FROM request_log");
    recordRequestLog({
      requestId: "stats-1", alias: "alice", tier: "guest", keyHash: null, model: "m1",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 5, completionTokens: 7, totalTokens: 12, queueWaitMs: null, ttftMs: null,
      totalMs: 10, admission: "admitted",
    });
    recordRequestLog({
      requestId: "stats-2", alias: "bob", tier: "guest", keyHash: null, model: "m2",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 3, completionTokens: 5, totalTokens: 8, queueWaitMs: null, ttftMs: null,
      totalMs: 10, admission: "admitted",
    });

    const res = await fetch(url("/portal/stats")); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const j = (await res.json()) as Record<string, unknown>;

    // Grand totals only.
    expect(j["total_tokens"]).toBe(20);
    expect(j["total_requests"]).toBe(2);
    expect(typeof j["since"]).toBe("number");

    // Content-blind invariant: the public payload exposes NOTHING beyond the three grand totals.
    // No per-user / per-key / per-alias / per-model / content dimension may leak.
    expect(Object.keys(j).sort()).toEqual(["since", "total_requests", "total_tokens"]);
    const blob = JSON.stringify(j);
    for (const leak of ["alice", "bob", "m1", "m2", "alias", "key", "model"]) {
      expect(blob).not.toContain(leak);
    }
  });

  it("returns zeros / null `since` when the log is empty", async () => {
    const { ensureRequestLogSchema, bustStatsCache } = await import("../src/homeserver/request-log.js");
    ensureRequestLogSchema();
    bustStatsCache();
    getDb().exec("DELETE FROM request_log");
    const res = await fetch(url("/portal/stats"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j["total_tokens"]).toBe(0);
    expect(j["total_requests"]).toBe(0);
    expect(j["since"]).toBeNull();
  });

  // ─── Finding 1 — origin-side TTL cache (MEDIUM) ─────────────────────────────────────
  // Repeated /portal/stats calls within the TTL must NOT re-scan SQLite.

  it("within the TTL: a second request reads the cache, not the DB (Finding 1)", async () => {
    const { ensureRequestLogSchema, bustStatsCache, recordRequestLog, cachedRequestLogTotals } =
      await import("../src/homeserver/request-log.js");
    ensureRequestLogSchema();
    bustStatsCache();
    getDb().exec("DELETE FROM request_log");
    recordRequestLog({
      requestId: "cache-seed-1", alias: "x", tier: "guest", keyHash: null, model: "m1",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 10, queueWaitMs: null, ttftMs: null,
      totalMs: 5, admission: "admitted",
    });

    // First call — populates the cache.
    const first = cachedRequestLogTotals();
    expect(first.totalRequests).toBe(1);
    expect(first.totalTokens).toBe(10);

    // Now insert more rows WITHOUT busting the cache.
    recordRequestLog({
      requestId: "cache-seed-2", alias: "y", tier: "guest", keyHash: null, model: "m1",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 50, queueWaitMs: null, ttftMs: null,
      totalMs: 5, admission: "admitted",
    });

    // Second call within TTL — must return the CACHED value (not the freshly inserted row).
    const second = cachedRequestLogTotals();
    expect(second.totalRequests).toBe(1);   // stale: cache not updated
    expect(second.totalTokens).toBe(10);    // stale: same memo

    // Both calls returned the same object reference (same memo slot).
    expect(second).toBe(first);
  });

  it("after busting the cache: re-reads DB and picks up new rows (Finding 1)", async () => {
    const { ensureRequestLogSchema, bustStatsCache, recordRequestLog, cachedRequestLogTotals } =
      await import("../src/homeserver/request-log.js");
    ensureRequestLogSchema();
    bustStatsCache();
    getDb().exec("DELETE FROM request_log");
    recordRequestLog({
      requestId: "bust-seed-1", alias: "a", tier: "guest", keyHash: null, model: "m1",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 7, queueWaitMs: null, ttftMs: null,
      totalMs: 5, admission: "admitted",
    });

    const before = cachedRequestLogTotals();
    expect(before.totalRequests).toBe(1);

    // Insert a new row, then bust the cache to simulate TTL expiry.
    recordRequestLog({
      requestId: "bust-seed-2", alias: "b", tier: "guest", keyHash: null, model: "m1",
      route: "/v1/chat/completions", status: 200, outcome: "ok", errorClass: null,
      promptTokens: 1, completionTokens: 1, totalTokens: 3, queueWaitMs: null, ttftMs: null,
      totalMs: 5, admission: "admitted",
    });

    bustStatsCache();

    const after = cachedRequestLogTotals();
    // After cache eviction the fresh DB scan must include the new row.
    expect(after.totalRequests).toBe(2);
    expect(after.totalTokens).toBe(10);
    // After the bust the result is a new object.
    expect(after).not.toBe(before);
  });

  // ─── Finding 2 — 503 on DB failure (LOW) ────────────────────────────────────────────
  // A DB error must return 503 + Cache-Control: no-store, not a zeroed 200.

  it("503 + no-store when the DB query fails — never a zeroed 200 (Finding 2)", async () => {
    const { bustStatsCache } = await import("../src/homeserver/request-log.js");
    bustStatsCache();

    // Drop the request_log table to force the aggregate query to throw.
    getDb().exec("DROP TABLE IF EXISTS request_log");

    const res = await fetch(url("/portal/stats"));

    // Must NOT be a silent zeroed 200.
    expect(res.status).toBe(503);

    // Must carry no-store so the failure is not cached by intermediaries.
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("no-store");

    // The body must be a proper error envelope, not a zeroed totals object.
    const j = (await res.json()) as Record<string, unknown>;
    expect(j).not.toHaveProperty("total_tokens");
    expect(j).not.toHaveProperty("total_requests");
    expect(j).toHaveProperty("error");

    // Restore the table for subsequent tests.
    const { ensureRequestLogSchema } = await import("../src/homeserver/request-log.js");
    ensureRequestLogSchema();
    bustStatsCache();
  });
});

// ─── GET /portal/me (authenticated) ─────────────────────────────────────────────────

describe("GET /portal/me", () => {
  it("a valid key returns its limits + usage", async () => {
    const { plaintextKey } = mintKey(
      { alias: uniq("me"), tier: "guest", creditLimit: 9000, modelAllowList: ["m1"] },
      DEFAULTS
    );
    recordCreditUsage(lookupKey(plaintextKey)!.keyHash, 1234);

    const res = await fetch(url("/portal/me"), { headers: { authorization: `Bearer ${plaintextKey}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store"); // Fix #7
    const j = (await res.json()) as {
      alias: string;
      tier: string;
      models: string[];
      creditLimit: number;
      creditsUsed: number;
      rpm: number;
      tpm: number;
    };
    expect(j.tier).toBe("guest");
    expect(j.creditLimit).toBe(9000);
    expect(j.creditsUsed).toBe(1234);
    expect(j.models).toEqual(["m1"]);
    expect(typeof j.rpm).toBe("number");
  });

  it("no key → 401 enveloped", async () => {
    const res = await fetch(url("/portal/me"));
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("a bad key → 401 enveloped", async () => {
    const res = await fetch(url("/portal/me"), { headers: { authorization: "Bearer not-a-real-key" } });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });
});

// ─── credits_exhausted on inference (HTTP) ──────────────────────────────────────────

describe("credits_exhausted enforcement", () => {
  it("an exhausted key hitting /v1/chat/completions gets 402 before any inference", async () => {
    const { plaintextKey } = mintKey({ alias: uniq("spent"), tier: "guest", creditLimit: 100 }, DEFAULTS);
    // Drive usage to/over the cap directly.
    recordCreditUsage(lookupKey(plaintextKey)!.keyHash, 100);

    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintextKey}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(402);
    const j = (await res.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("credits_exhausted");
    expect(j.error.type).toBe("insufficient_quota");
  });

  it("a key with remaining credits is served (and accrues real usage)", async () => {
    const { plaintextKey } = mintKey({ alias: uniq("fresh"), tier: "guest", creditLimit: 100_000 }, DEFAULTS);
    const before = lookupKey(plaintextKey)!.creditsUsed;
    expect(before).toBe(0);

    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintextKey}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);
    // The stub upstream reports total_tokens: 10; the credit ledger must reflect real usage.
    const after = lookupKey(plaintextKey)!.creditsUsed;
    expect(after).toBe(10);
  });

  // ─── Fix #3 (MEDIUM-1/2) — atomic debit kills the check-then-accrue overspend race ────
  it("concurrent requests on a near-exhausted key cannot overspend the cap", async () => {
    // creditLimit 1: the first request's atomic reservation debits credits_used over the cap,
    // so EVERY concurrent racer after it sees credits_used >= limit and is rejected with 402
    // BEFORE running inference. The snapshot-gate bug would have let them all through.
    const { plaintextKey } = mintKey({ alias: uniq("race"), tier: "guest", creditLimit: 1 }, DEFAULTS);

    const fire = () =>
      fetch(url("/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${plaintextKey}` },
        body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
      });

    const results = await Promise.all(Array.from({ length: 8 }, fire));
    const statuses = results.map((r) => r.status);
    const ok = statuses.filter((s) => s === 200).length;
    const rejected = statuses.filter((s) => s === 402).length;

    // At most one in-flight request's worth gets through; the rest are 402 (or 503 if the GPU
    // lane was momentarily contended — never another 200 over budget).
    expect(ok).toBeLessThanOrEqual(1);
    expect(ok + rejected).toBeGreaterThanOrEqual(1);

    // Final ledger must reflect real usage of the one served request (10), not 8×.
    const used = lookupKey(plaintextKey)!.creditsUsed;
    expect(used).toBeLessThanOrEqual(1 + 256); // ≤ creditLimit + perRequestMaxTokens
    expect(used).toBe(ok === 1 ? 10 : 0); // exactly one request's real usage, or none
  });
});

// ─── Portal page content (R1 intro, R7 priority blurb, R2 docs) ────────────────────────

describe("portal page content", () => {
  it("GET /portal contains the intro / hero text", async () => {
    const res = await fetch(url("/portal"));
    expect(res.status).toBe(200);
    const body = await res.text();
    // R1: friendly intro blurb present
    expect(body).toContain("friend");
    expect(body).toContain("local AI models");
    expect(body).toContain("invite");
  });

  it("GET /portal contains the priority blurb with 503 mentioned", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    // R7: priority / 503 blurb
    expect(body).toContain("503");
    expect(body).toContain("retry");
    expect(body).toContain("owner");
  });

  it("GET /portal contains the docs section with all three surfaces", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    // R2: HTTP API surface
    expect(body).toContain("inference.example.com/v1");
    expect(body).toContain("/v1/models");
    // R2: MCP surface
    expect(body).toContain("/mcp");
    // R2: CLI surface — now served from the gateway at /hs, not raw.githubusercontent
    expect(body).toContain("inference.example.com/hs");
  });

  it("GET /portal docs section contains the error table with all key codes", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    expect(body).toContain("invalid_api_key");
    expect(body).toContain("credits_exhausted");
    expect(body).toContain("model_not_allowed");
    expect(body).toContain("rate_limit_exceeded");
    expect(body).toContain("server_busy");
    expect(body).toContain("upstream_unavailable");
    expect(body).toContain("upstream_timeout");
  });

  it("GET / also contains the intro and docs content (root alias)", async () => {
    const res = await fetch(url("/"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("inference.example.com/v1");
    // CLI install URL now points to the gateway, not raw.githubusercontent
    expect(body).toContain("inference.example.com/hs");
    expect(body).toContain("503");
  });

  it("GET /portal contains the 'What's running' section with hardware and model specs", async () => {
    const res = await fetch(url("/portal"));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Section heading
    expect(body).toContain("What&#8217;s running");
    // Hardware facts
    expect(body).toContain("Strix Halo");
    expect(body).toContain("128");
    // All seven publicly advertised chat-model IDs
    expect(body).toContain("mellum");
    expect(body).toContain("gemma4");
    expect(body).toContain("qwen36-a3b");
    expect(body).toContain("qwen3-30b-instruct");
    expect(body).toContain("vibethinker-3b");
    expect(body).toContain("qwen3-coder-next-80b");
    expect(body).toContain("gpt-oss-120b");
    // Quant and context facts
    expect(body).toContain("Q4_K_M");
    expect(body).toContain("Q8_0");
    expect(body).toContain("MXFP4");
    expect(body).toContain("40&#8211;60s");
    expect(body).toContain("131,072");
    expect(body).toContain("65,536");
    // External-user examples document VibeThinker's full sampler profile and higher explicit cap.
    expect(body).toContain('extra_body={"top_k": 0, "min_p": 0}');
    expect(body).toContain("Ordinary models cap");
    expect(body).toContain("may use up to 32,768");
    // Concurrency / sharing note
    expect(body).toContain("Sharing the box");
    expect(body).toContain("one at a time");
  });

  it("key warning is inside the redeem card, not in a standalone footer", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    const warningText = "Keys are shown once and stored only in this browser";
    // Warning text must be present somewhere in the page.
    expect(body).toContain(warningText);
    // It must appear inside the redeem-view section (before the closing </section>).
    const redeemSection = body.match(/<section id="redeem-view"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(redeemSection).toContain(warningText);
    // It must NOT appear in a standalone footer paragraph outside the redeem section.
    // The old placement was: <p class="footer">Keys are shown once…
    expect(body).not.toContain('<p class="footer">Keys are shown once');
  });
});

// ─── GET /hs and GET /client/hs.mjs — unauthenticated CLI download ─────────────────────

describe("hs CLI download routes", () => {
  it("GET /hs returns 200, text/javascript, unauthenticated (no Authorization header)", async () => {
    const res = await fetch(url("/hs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
  });

  it("GET /hs body contains a known hs.mjs string ('hs redeem')", async () => {
    const res = await fetch(url("/hs"));
    const body = await res.text();
    expect(body).toContain("hs redeem");
  });

  it("GET /client/hs.mjs returns 200, text/javascript, unauthenticated", async () => {
    const res = await fetch(url("/client/hs.mjs"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/javascript/);
  });

  it("GET /client/hs.mjs body contains a known hs.mjs string ('hs redeem')", async () => {
    const res = await fetch(url("/client/hs.mjs"));
    const body = await res.text();
    expect(body).toContain("hs redeem");
  });

  it("GET /hs and GET /client/hs.mjs return identical bodies", async () => {
    const [r1, r2] = await Promise.all([fetch(url("/hs")), fetch(url("/client/hs.mjs"))]);
    expect(await r1.text()).toBe(await r2.text());
  });
});

// ─── Portal HTML install URL references ──────────────────────────────────────────────────

describe("portal HTML hs install URL", () => {
  it("portal HTML references inference.example.com/hs (gateway URL), not raw.githubusercontent", async () => {
    const res = await fetch(url("/portal"));
    const body = await res.text();
    expect(body).toContain("inference.example.com/hs");
    expect(body).not.toContain("raw.githubusercontent.com");
  });
});

// ─── hs.mjs User-Agent constant ──────────────────────────────────────────────────────────

describe("hs.mjs User-Agent constant", () => {
  it("hs.mjs source defines HS_UA with 'hs-cli/' prefix", async () => {
    const res = await fetch(url("/hs"));
    const body = await res.text();
    // The source must declare the User-Agent constant used by all fetch calls.
    expect(body).toContain("hs-cli/");
    expect(body).toContain("HS_UA");
  });
});

// ─── GET /portal/model-evals.json (PUBLIC, content-blind model-scout feed) ──────────

describe("GET /portal/model-evals.json", () => {
  it("is reachable UNAUTHENTICATED and returns only content-blind eval fields", async () => {
    const { writeFileSync, mkdtempSync: mkd } = await import("node:fs");
    const dir = mkd(join(tmpdir(), "scout-reg-"));
    const regPath = join(dir, "registry.jsonl");
    // Two evals for one model (latest wins) + a prompt-like field that must NEVER surface.
    writeFileSync(
      regPath,
      [
        JSON.stringify({ id: "org/Cand-A", quant: "Q4_K_M", sizeGB: 12, evaluatedAt: "2026-06-20T00:00:00Z", verdict: "skip", passRate: 0.2, avgTokPerSec: 40, scoresByTaskType: {}, served: false, notes: "SECRETPROMPT" }),
        JSON.stringify({ id: "org/Cand-A", quant: "Q4_K_M", sizeGB: 12, evaluatedAt: "2026-06-29T00:00:00Z", verdict: "winner", passRate: 0.9, avgTokPerSec: 55, scoresByTaskType: { code: 0.9 }, served: true, ggufPath: "/srv/models/x/secret.gguf", notes: "SECRETPROMPT" }),
      ].join("\n") + "\n"
    );
    process.env["SCOUT_REGISTRY"] = regPath;

    const res = await fetch(url("/portal/model-evals.json")); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const j = (await res.json()) as { count: number; models: Array<Record<string, unknown>> };
    expect(j.count).toBe(1); // deduped to latest
    expect(j.models[0]!["verdict"]).toBe("winner");
    expect(j.models[0]!["served"]).toBe(true);
    // Content-blind: only the declared keys, and no notes/ggufPath leakage.
    expect(Object.keys(j.models[0]!).sort()).toEqual(
      ["evaluatedAt", "id", "passRate", "quant", "served", "sizeGB", "tokPerSec", "verdict"].sort()
    );
    const blob = JSON.stringify(j);
    for (const leak of ["SECRETPROMPT", "secret.gguf", "ggufPath", "notes"]) expect(blob).not.toContain(leak);

    delete process.env["SCOUT_REGISTRY"];
  });

  it("returns an empty payload (not an error) when no registry exists", async () => {
    process.env["SCOUT_REGISTRY"] = join(tmpdir(), "definitely-absent-scout-registry.jsonl");
    const res = await fetch(url("/portal/model-evals.json"));
    expect(res.status).toBe(200);
    const j = (await res.json()) as { count: number; models: unknown[] };
    expect(j.count).toBe(0);
    expect(j.models).toEqual([]);
    delete process.env["SCOUT_REGISTRY"];
  });
});

// keep getDb referenced (parity with sibling suites that probe the schema directly)
void getDb;
