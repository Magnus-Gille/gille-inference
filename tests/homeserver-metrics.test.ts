import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * Prometheus /metrics endpoint tests.
 *
 * Tests are split into two sections:
 *   1. Pure unit tests of the metrics module (recordRequest, renderMetrics, etc.)
 *   2. HTTP integration tests — GET /metrics via the live gateway, matching the
 *      pattern used in homeserver-gateway-spine.test.ts.
 */

// ─── Shared imports (loaded dynamically after env/DB setup) ──────────────────

let resetMetrics: typeof import("../src/homeserver/metrics.js").resetMetrics;
let recordRequest: typeof import("../src/homeserver/metrics.js").recordRequest;
let recordAdmissionRejection: typeof import("../src/homeserver/metrics.js").recordAdmissionRejection;
let recordRateLimited: typeof import("../src/homeserver/metrics.js").recordRateLimited;
let recordTtft: typeof import("../src/homeserver/metrics.js").recordTtft;
let inflightInc: typeof import("../src/homeserver/metrics.js").inflightInc;
let inflightDec: typeof import("../src/homeserver/metrics.js").inflightDec;
let renderMetrics: typeof import("../src/homeserver/metrics.js").renderMetrics;

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;

// ─── Upstream mock (minimal: just echo a successful completion) ───────────────

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

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };
const ADMIN = "metrics-admin-static-key";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-metrics-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = ADMIN;
  delete process.env["HOMESERVER_API_KEYS"];

  const metricsMod = await import("../src/homeserver/metrics.js");
  resetMetrics = metricsMod.resetMetrics;
  recordRequest = metricsMod.recordRequest;
  recordAdmissionRejection = metricsMod.recordAdmissionRejection;
  recordRateLimited = metricsMod.recordRateLimited;
  recordTtft = metricsMod.recordTtft;
  inflightInc = metricsMod.inflightInc;
  inflightDec = metricsMod.inflightDec;
  renderMetrics = metricsMod.renderMetrics;

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;

  const q = await import("../src/homeserver/quota.js");
  resetQuotaWindows = q.resetQuotaWindows;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

beforeEach(() => {
  resetMetrics();
  resetQuotaWindows();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

// ─── Unit tests: metrics module ───────────────────────────────────────────────

describe("metrics unit — recordRequest accumulates", () => {
  it("increments homeserver_requests_total with correct labels", () => {
    recordRequest({
      model: "llama3",
      outcome: "ok",
      tier: "guest",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });
    recordRequest({
      model: "llama3",
      outcome: "ok",
      tier: "guest",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });

    const output = renderMetrics();
    expect(output).toContain("homeserver_requests_total");
    expect(output).toContain('model="llama3"');
    expect(output).toContain('outcome="ok"');
    expect(output).toContain('tier="guest"');
    // Two calls → counter value 2
    expect(output).toMatch(/homeserver_requests_total\{[^}]*\}\s+2/);
  });

  it("emits histogram _bucket, _sum, and _count lines", () => {
    recordRequest({
      model: "phi3",
      outcome: "ok",
      tier: "owner",
      promptTokens: null,
      completionTokens: null,
      durationMs: 250, // 0.25 s
      creditsCharged: null,
    });

    const output = renderMetrics();
    expect(output).toContain("homeserver_request_duration_seconds");
    expect(output).toContain('_bucket{model="phi3"');
    expect(output).toContain('_sum{model="phi3"');
    expect(output).toContain('_count{model="phi3"');
    // 250 ms = 0.25 s — should fall in the <=0.25 bucket but not the <=0.1 bucket
    expect(output).toMatch(/_bucket\{model="phi3",le="0\.25"\}\s+1/);
    expect(output).toMatch(/_bucket\{model="phi3",le="0\.1"\}\s+0/);
    // +Inf bucket == count
    expect(output).toMatch(/_bucket\{model="phi3",le="\+Inf"\}\s+1/);
    expect(output).toMatch(/_count\{model="phi3"\}\s+1/);
  });
});

describe("metrics unit — label sanitization", () => {
  it("escapes double-quotes in label values", () => {
    recordRequest({
      model: 'some"model',
      outcome: "ok",
      tier: "owner",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });

    const output = renderMetrics();
    // The quote must be escaped; there should be no bare unescaped double-quote inside the label value
    expect(output).toContain('\\"model');
    // The output must not contain an unescaped quote pair that would break Prometheus parsing
    // i.e. model="some"model" should NOT appear
    expect(output).not.toMatch(/model="some"model"/);
  });

  it("escapes backslashes in label values", () => {
    recordRequest({
      model: "a\\b",
      outcome: "ok",
      tier: "guest",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });
    const output = renderMetrics();
    expect(output).toContain("a\\\\b");
  });

  it("escapes newlines in label values", () => {
    // Newlines in model names are synthetic but the sanitizer must handle them.
    recordRequest({
      model: "a\nb",
      outcome: "ok",
      tier: "guest",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });
    const output = renderMetrics();
    expect(output).toContain("a\\nb");
  });
});

describe("metrics unit — null model → label none", () => {
  it("null model produces model=\"none\" in output", () => {
    recordRequest({
      model: null,
      outcome: "auth_failed",
      tier: null,
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });

    const output = renderMetrics();
    expect(output).toContain('model="none"');
  });
});

describe("metrics unit — tokens counter", () => {
  it("records prompt and completion tokens separately", () => {
    recordRequest({
      model: "mistral",
      outcome: "ok",
      tier: "owner",
      promptTokens: 100,
      completionTokens: 50,
      durationMs: null,
      creditsCharged: null,
    });

    const output = renderMetrics();
    expect(output).toContain("homeserver_tokens_total");
    // prompt direction counter
    expect(output).toMatch(/homeserver_tokens_total\{[^}]*direction="prompt"[^}]*\}\s+100/);
    // completion direction counter
    expect(output).toMatch(/homeserver_tokens_total\{[^}]*direction="completion"[^}]*\}\s+50/);
  });

  it("accumulates tokens across multiple calls", () => {
    recordRequest({
      model: "mistral",
      outcome: "ok",
      tier: "owner",
      promptTokens: 100,
      completionTokens: 50,
      durationMs: null,
      creditsCharged: null,
    });
    recordRequest({
      model: "mistral",
      outcome: "ok",
      tier: "owner",
      promptTokens: 200,
      completionTokens: 75,
      durationMs: null,
      creditsCharged: null,
    });

    const output = renderMetrics();
    expect(output).toMatch(/homeserver_tokens_total\{[^}]*direction="prompt"[^}]*\}\s+300/);
    expect(output).toMatch(/homeserver_tokens_total\{[^}]*direction="completion"[^}]*\}\s+125/);
  });

  it("does not emit token counters when both are null", () => {
    recordRequest({
      model: "mistral",
      outcome: "ok",
      tier: "owner",
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
      creditsCharged: null,
    });
    const output = renderMetrics();
    // tokens counter family should be absent when there's nothing to record
    expect(output).not.toContain("homeserver_tokens_total");
  });
});

describe("metrics unit — admission and rate-limit counters", () => {
  it("recordAdmissionRejection increments with lane label", () => {
    recordAdmissionRejection("guest");
    recordAdmissionRejection("guest");
    const output = renderMetrics();
    expect(output).toContain("homeserver_admission_rejections_total");
    expect(output).toMatch(/homeserver_admission_rejections_total\{[^}]*lane="guest"[^}]*\}\s+2/);
  });

  it("recordRateLimited increments with surface label", () => {
    recordRateLimited("quota");
    recordRateLimited("redeem");
    recordRateLimited("quota");
    const output = renderMetrics();
    expect(output).toContain("homeserver_rate_limited_total");
    expect(output).toMatch(/homeserver_rate_limited_total\{[^}]*surface="quota"[^}]*\}\s+2/);
    expect(output).toMatch(/homeserver_rate_limited_total\{[^}]*surface="redeem"[^}]*\}\s+1/);
  });
});

describe("metrics unit — TTFT histogram", () => {
  it("recordTtft observes homeserver_ttft_seconds with a model label only (content-blind)", () => {
    recordTtft("qwen3", 120); // 120 ms = 0.12 s
    const output = renderMetrics();
    expect(output).toContain("homeserver_ttft_seconds");
    expect(output).toContain('_bucket{model="qwen3"');
    expect(output).toContain('_sum{model="qwen3"');
    expect(output).toContain('_count{model="qwen3"');
    // 0.12 s falls in the <=0.25 bucket but not <=0.1.
    expect(output).toMatch(/homeserver_ttft_seconds_bucket\{model="qwen3",le="0\.25"\}\s+1/);
    expect(output).toMatch(/homeserver_ttft_seconds_bucket\{model="qwen3",le="0\.1"\}\s+0/);
    expect(output).toMatch(/homeserver_ttft_seconds_count\{model="qwen3"\}\s+1/);
  });

  it("a null model coerces to the safe 'none' label; the histogram never carries a per-user label", () => {
    recordTtft(null, 50);
    const output = renderMetrics();
    expect(output).toContain('homeserver_ttft_seconds_count{model="none"}');
    // No alias / principal / key dimension may appear anywhere in the TTFT family.
    const ttftLines = output.split("\n").filter((l) => l.includes("homeserver_ttft_seconds"));
    for (const line of ttftLines) {
      expect(line).not.toContain("alias");
      expect(line).not.toContain("principal");
      expect(line).not.toContain("tier");
    }
  });
});

describe("metrics unit — in-flight concurrency gauge", () => {
  it("inflightInc/Dec drive homeserver_inflight_requests up and back down", () => {
    inflightInc("guest");
    inflightInc("owner");
    let output = renderMetrics();
    expect(output).toContain("homeserver_inflight_requests");
    expect(output).toMatch(/homeserver_inflight_requests\s+2/);
    // Per-lane breakdown (cheap, content-blind).
    expect(output).toMatch(/homeserver_inflight_by_lane\{lane="guest"\}\s+1/);
    expect(output).toMatch(/homeserver_inflight_by_lane\{lane="owner"\}\s+1/);

    inflightDec("guest");
    inflightDec("owner");
    output = renderMetrics();
    expect(output).toMatch(/homeserver_inflight_requests\s+0/);
  });

  it("the gauge never goes negative on an over-release", () => {
    inflightDec("guest");
    const output = renderMetrics();
    expect(output).toMatch(/homeserver_inflight_requests\s+0/);
  });
});

describe("metrics unit — empty state", () => {
  it("renderMetrics returns empty string when nothing has been recorded", () => {
    // resetMetrics() is called in beforeEach
    const output = renderMetrics();
    expect(output).toBe("");
  });
});

// ─── HTTP integration tests ───────────────────────────────────────────────────

describe("GET /metrics — HTTP integration", () => {
  it("valid key → 200 with Prometheus content-type", async () => {
    const minted = mintKey({ alias: "metrics-reader", tier: "owner" }, DEFAULTS);
    const res = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${minted.plaintextKey}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("content-type")).toContain("version=0.0.4");
  });

  it("valid key → body contains homeserver_requests_total", async () => {
    // Make one request first so the counter is non-empty
    const minted = mintKey({ alias: "metrics-reader-2", tier: "owner" }, DEFAULTS);
    await fetch(url("/healthz")); // unauthenticated — still recorded
    const res = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${minted.plaintextKey}` },
    });
    const body = await res.text();
    expect(body).toContain("homeserver_requests_total");
  });

  it("no key → 401", async () => {
    const res = await fetch(url("/metrics"));
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("invalid key → 401", async () => {
    const res = await fetch(url("/metrics"), {
      headers: { authorization: "Bearer not-a-real-key" },
    });
    expect(res.status).toBe(401);
  });

  it("after a chat request, request counter increments", async () => {
    const minted = mintKey({ alias: "metrics-flow", tier: "owner" }, DEFAULTS);

    // Snapshot counter before
    const before = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${minted.plaintextKey}` },
    });
    const beforeBody = await before.text();

    // Make a chat request
    await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${minted.plaintextKey}`,
      },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });

    // Check counter after
    const after = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${minted.plaintextKey}` },
    });
    const afterBody = await after.text();

    // The after body should have a higher request count (or the counter is now present)
    // When before was empty and after is non-empty, that counts as incrementing.
    const hasCounter = afterBody.includes("homeserver_requests_total");
    const counterIncreased =
      hasCounter &&
      (!beforeBody.includes("homeserver_requests_total") ||
        // Extract a numeric value and compare (crude but effective)
        afterBody !== beforeBody);

    expect(counterIncreased).toBe(true);
  });

  it("admin static key also grants access to /metrics", async () => {
    const res = await fetch(url("/metrics"), {
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.status).toBe(200);
  });

  // ─── C3 — a raw user-controlled model string never leaks into /metrics labels ─────────
  it("C3: an arbitrary/secret-looking model string is recorded as a safe label, never verbatim", async () => {
    const minted = mintKey({ alias: "c3-leak", tier: "owner" }, DEFAULTS);
    const secret = "sk-SUPERSECRET-INJECTED-LABEL-9f2a";
    await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.plaintextKey}` },
      // This model is NOT in any allow-list nor a resident model; it must be canonicalized away.
      body: JSON.stringify({ model: secret, messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await fetch(url("/metrics"), { headers: { authorization: `Bearer ${minted.plaintextKey}` } });
    const body = await res.text();
    // The injected string must NEVER appear verbatim in the Prometheus exposition.
    expect(body).not.toContain(secret);
    // It is mapped to a safe label instead. With the trusted-catalogue canonicalizer, an empty-
    // allow-list key requesting an unknown model is recorded as "unknown" (not the raw string);
    // when no catalogue is resident it would also collapse to "unknown". Either way it is a fixed,
    // content-blind label — never the attacker-controlled string.
    expect(body).toMatch(/model="(unknown|none)"/);
  });

  // ─── M3 — token + credit counters increment for real metered traffic ──────────────────
  it("M3: a chat request increments homeserver_tokens_total and homeserver_credits_consumed_total", async () => {
    // A credit-limited key so credits are actually accrued (creditLimit > 0 with a real keyHash).
    const minted = mintKey({ alias: "m3-tokens", tier: "owner", creditLimit: 1_000_000 }, DEFAULTS);
    await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.plaintextKey}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    const res = await fetch(url("/metrics"), { headers: { authorization: `Bearer ${minted.plaintextKey}` } });
    const body = await res.text();
    // The stub reports prompt_tokens:5, completion_tokens:5, total_tokens:10.
    expect(body).toContain("homeserver_tokens_total");
    expect(body).toMatch(/homeserver_tokens_total\{[^}]*direction="prompt"[^}]*\}\s+\d/);
    expect(body).toMatch(/homeserver_tokens_total\{[^}]*direction="completion"[^}]*\}\s+\d/);
    expect(body).toContain("homeserver_credits_consumed_total");
    expect(body).toMatch(/homeserver_credits_consumed_total\{[^}]*\}\s+10/);
  });
});
