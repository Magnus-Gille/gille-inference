import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { classifyTask } from "../src/homeserver/taxonomy.js";
import { ensureLedgerSchema, getVerdict } from "../src/homeserver/ledger.js";
import { ensureDelegationCostSchema } from "../src/homeserver/delegation-cost.js";
import { DEFAULT_POLICY } from "../src/homeserver/config.js";
import {
  TASK_FINGERPRINT_VERSION,
  lookupTaskExposures,
  taskTextFingerprint,
} from "../src/homeserver/task-exposure.js";

/**
 * MCP Streamable-HTTP transport suite. Mirrors the portal-test harness: a controllable stub
 * upstream (so no real model is needed), keystore-only mode (a key is minted before
 * startGateway so the gateway does not bootstrap implicit-admin), and an ephemeral port.
 *
 * Covers: initialize / notifications/initialized / ping / tools/list / tools/call (both
 * tools), auth (401 with no key), method (405 on GET), allow-list enforcement, and that the
 * `ask` tool accrues credits through the same metered path as /v1/chat/completions.
 */

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let lastUpstreamBody = "";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamHits++;
      lastUpstreamBody = Buffer.concat(chunks).toString();
      // Test hook: the sentinel model id "boom-model" forces an upstream 5xx so the failure path
      // (outcome="error" + error_class="infra") can be exercised. Other model ids are unaffected.
      let reqModel = "";
      try {
        reqModel = (JSON.parse(Buffer.concat(chunks).toString()) as { model?: string }).model ?? "";
      } catch {
        reqModel = "";
      }
      if (reqModel === "boom-model") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "STUBBED COMPLETION" } }],
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
let reserveCredits: typeof import("../src/homeserver/keystore.js").reserveCredits;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

// Two keys: an open key (empty allow-list = all models visible) and a scoped key (one model).
let openKey = "";
let scopedKey = "";
let creditKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-mcp-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  process.env["HOMESERVER_DELEGATION_COST_LOG"] = "on";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  reserveCredits = ks.reserveCredits;

  openKey = mintKey({ alias: "mcp-open", tier: "owner" }, DEFAULTS).plaintextKey;
  scopedKey = mintKey({ alias: "mcp-scoped", tier: "guest", modelAllowList: ["only-this-model"] }, DEFAULTS).plaintextKey;
  creditKey = mintKey({ alias: "mcp-credit", tier: "guest", creditLimit: 100_000 }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function mcpUrl(): string {
  return `http://127.0.0.1:${gatewayPort}/mcp`;
}

async function rpc(body: unknown, key = openKey): Promise<Response> {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

// ─── initialize ─────────────────────────────────────────────────────────────────────

describe("MCP initialize", () => {
  it("returns protocolVersion + capabilities.tools + serverInfo and an Mcp-Session-Id header", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeTruthy();
    const j = (await res.json()) as {
      jsonrpc: string;
      id: number;
      result: { protocolVersion: string; capabilities: { tools: unknown }; serverInfo: { name: string; version: string } };
    };
    expect(j.jsonrpc).toBe("2.0");
    expect(j.id).toBe(1);
    expect(j.result.protocolVersion).toBe("2025-06-18");
    expect(j.result.capabilities.tools).toBeDefined();
    expect(j.result.serverInfo.name).toBe("m5-local-models");
    expect(j.result.serverInfo.version).toBe("1.0.0");
  });
});

// ─── notifications/initialized ────────────────────────────────────────────────────────

describe("MCP notifications/initialized", () => {
  it("returns 202 with an empty body (no id)", async () => {
    const res = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

// ─── ping ─────────────────────────────────────────────────────────────────────────────

describe("MCP ping", () => {
  it("returns an empty result object", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "ping" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { id: number; result: unknown };
    expect(j.id).toBe(7);
    expect(j.result).toEqual({});
  });
});

// ─── tools/list ──────────────────────────────────────────────────────────────────────

describe("MCP tools/list", () => {
  it("lists list_models and ask with inputSchemas", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { type: string; properties: Record<string, unknown> } }> } };
    const names = j.result.tools.map((t) => t.name);
    expect(names).toContain("list_models");
    expect(names).toContain("ask");
    const ask = j.result.tools.find((t) => t.name === "ask")!;
    expect(ask.inputSchema.type).toBe("object");
    expect(ask.inputSchema.properties).toHaveProperty("model");
    expect(ask.inputSchema.properties).toHaveProperty("prompt");
    expect(ask.inputSchema.properties).toHaveProperty("delegator_model_id");
    const list = j.result.tools.find((t) => t.name === "list_models")!;
    expect(list.inputSchema.type).toBe("object");
  });
});

// ─── tools/call list_models ─────────────────────────────────────────────────────────

describe("MCP tools/call list_models", () => {
  it("a scoped key sees only its allow-listed model", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_models", arguments: {} } }, scopedKey);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(false);
    expect(j.result.content[0]!.text).toContain("only-this-model");
  });

  it("describes VibeThinker as a verifiable-reasoning specialist", async () => {
    const vibeKey = mintKey(
      { alias: "mcp-vibethinker", tier: "guest", modelAllowList: ["vibethinker-3b"] },
      DEFAULTS
    ).plaintextKey;
    const res = await rpc(
      { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "list_models", arguments: {} } },
      vibeKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    expect(j.result.content[0]!.text).toContain(
      "vibethinker-3b — verifiable math, code, and STEM reasoning"
    );
  });
});

// ─── tools/call ask (valid model) ────────────────────────────────────────────────────

describe("MCP tools/call ask", () => {
  it("forwards explicit sampler controls and the VibeThinker token allowance", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 40,
        method: "tools/call",
        params: {
          name: "ask",
          arguments: {
            model: "vibethinker-3b",
            prompt: "solve",
            max_tokens: 99999,
            temperature: 1,
            top_p: 0.95,
            top_k: 0,
            min_p: 0,
          },
        },
      },
      openKey
    );
    expect(res.status).toBe(200);
    const sent = JSON.parse(lastUpstreamBody) as Record<string, unknown>;
    expect(sent).toMatchObject({
      model: "vibethinker-3b",
      max_tokens: 32768,
      temperature: 1,
      top_p: 0.95,
      top_k: 0,
      min_p: 0,
    });
  });

  it("returns the stubbed completion text and accrues credits for a credit-limited key", async () => {
    const before = lookupKey(creditKey)!.creditsUsed;
    const res = await rpc(
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt: "hello" } } },
      creditKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(false);
    expect(j.result.content[0]!.text).toBe("STUBBED COMPLETION");
    // The stub reports total_tokens: 10 — credits must reflect real usage.
    const after = lookupKey(creditKey)!.creditsUsed;
    expect(after - before).toBe(10);
  });

  it("M3: an ask call feeds usage into /metrics (tokens + credits counters increment)", async () => {
    // Run an ask, then read /metrics through the same gateway and assert the token + credit
    // counters are present (the MCP path must call recordRequest, not silently skip it).
    await rpc(
      { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt: "hello" } } },
      creditKey
    );
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
      headers: { authorization: `Bearer ${openKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("homeserver_tokens_total");
    expect(body).toContain("homeserver_credits_consumed_total");
  });

  it("returns a clear tool error for malformed delegator_model_id", async () => {
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: { name: "ask", arguments: { model: "any-model", prompt: "hello", delegator_model_id: 123 } },
      },
      openKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toContain("delegator_model_id");
  });

  it("a model NOT in the key's allow-list returns isError with no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const res = await rpc(
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ask", arguments: { model: "forbidden-model", prompt: "hi" } } },
      scopedKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/not permitted/i);
    expect(upstreamHits).toBe(hitsBefore); // no inference ran
  });
});

// ─── blind-context (#128) default-disabled posture ────────────────────────────────────
// This suite's gateway never sets HOMESERVER_BLIND_CONTEXT_ROOTS, so it exercises the
// SHIPPED default: the feature is off. Full expansion / tier-enforcement / path-safety
// coverage (with a configured allowlist root) lives in homeserver-mcp-blind-context.test.ts —
// a dedicated gateway instance, since HOMESERVER_BLIND_CONTEXT_ROOTS is read once into the
// process-wide config singleton and must not be mutated out from under this file's other tests.

describe("MCP blind-context (#128): disabled by default", () => {
  it("an OWNER key supplying `files` on an unconfigured server gets an actionable 'disabled' error, no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 50,
        method: "tools/call",
        params: { name: "ask", arguments: { model: "any-model", prompt: "hi", files: ["/etc/hostname"] } },
      },
      openKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/HOMESERVER_BLIND_CONTEXT_ROOTS/);
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("a GUEST key supplying `files` is rejected on TIER before the disabled-roots check ever runs", async () => {
    const hitsBefore = upstreamHits;
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 51,
        method: "tools/call",
        params: { name: "ask", arguments: { model: "any-model", prompt: "hi", files: ["/etc/hostname"] } },
      },
      scopedKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/owner-tier/i);
    expect(upstreamHits).toBe(hitsBefore);
  });
});

// ─── auth + method ───────────────────────────────────────────────────────────────────

describe("MCP auth + method", () => {
  it("no bearer key → 401 enveloped", async () => {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "initialize" }),
    });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("GET /mcp → 405", async () => {
    const res = await fetch(mcpUrl(), { method: "GET", headers: { authorization: `Bearer ${openKey}` } });
    expect(res.status).toBe(405);
  });

  it("an unknown method returns a JSON-RPC -32601 error", async () => {
    const res = await rpc({ jsonrpc: "2.0", id: 11, method: "no/such/method" });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { error?: { code: number } };
    expect(j.error?.code).toBe(-32601);
  });

  it("malformed JSON returns a JSON-RPC -32700 parse error", async () => {
    const res = await fetch(mcpUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${openKey}` },
      body: "{not json",
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { error?: { code: number } };
    expect(j.error?.code).toBe(-32700);
  });
});

// ─── M2a: model_not_allowed increments /metrics ───────────────────────────────────────
// Codex MEDIUM finding: a disallowed-model rejection was invisible in /metrics (only the
// outer transport /mcp row with model="none"/outcome="ok" reached Prometheus). After the
// fix, a model_not_allowed ask must emit a recordRequest with outcome="forbidden" so
// homeserver_requests_total carries the rejection.

/** Sum all homeserver_requests_total counter values whose labels include outcome="forbidden". */
function forbiddenRequestCount(metricsText: string): number {
  let total = 0;
  for (const line of metricsText.split("\n")) {
    if (line.startsWith("homeserver_requests_total") && line.includes('outcome="forbidden"')) {
      const m = /\}\s+([\d.e+]+)$/.exec(line.trimEnd());
      if (m) total += parseFloat(m[1]!);
    }
  }
  return total;
}

describe("MCP M2a: model_not_allowed increments /metrics", () => {
  it("a disallowed-model ask increments homeserver_requests_total{outcome=forbidden} and still returns isError", async () => {
    // Read metrics BEFORE the disallowed ask — capture current forbidden sum.
    const metricsBefore = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
      headers: { authorization: `Bearer ${openKey}` },
    }).then((r) => r.text());
    const forbiddenBefore = forbiddenRequestCount(metricsBefore);

    // Trigger a model_not_allowed rejection via the scopedKey (allow-list = ["only-this-model"]).
    const res = await rpc(
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "ask", arguments: { model: "banned-model", prompt: "hi" } } },
      scopedKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { isError: boolean; content: Array<{ type: string; text: string }> } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/not permitted/i);

    // Read metrics AFTER — the forbidden counter sum must have grown by exactly 1.
    const metricsAfter = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
      headers: { authorization: `Bearer ${openKey}` },
    }).then((r) => r.text());
    const forbiddenAfter = forbiddenRequestCount(metricsAfter);
    expect(forbiddenAfter).toBe(forbiddenBefore + 1);
  });
});

// ─── M2b: credits_exhausted uses status=402 / outcome="credits_exhausted" ─────────────
// Codex MEDIUM finding: the MCP path was logging status=429 / outcome="rate_limited" for
// lifetime-credit exhaustion. The HTTP path uses status=402 / outcome="credits_exhausted".
// After the fix, both the request_log row and the recordRequest outcome label must match.

describe("MCP M2b: credits_exhausted outcome alignment", () => {
  it("an ask on a fully-exhausted credit key records outcome=credits_exhausted in /metrics (not rate_limited)", async () => {
    // Mint a key with a tiny credit limit (10 tokens) and exhaust it via reserveCredits.
    const exhaustedKey = mintKey({ alias: "mcp-exhausted", tier: "guest", creditLimit: 10 }, DEFAULTS).plaintextKey;
    const exhaustedRecord = lookupKey(exhaustedKey)!;
    // Reserve 10 tokens (the full limit) — subsequent reserveCredits calls will fail.
    reserveCredits(exhaustedRecord.keyHash, 10);

    // Read metrics BEFORE the credits-exhausted ask.
    const metricsBefore = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
      headers: { authorization: `Bearer ${openKey}` },
    }).then((r) => r.text());
    const exhaustedBefore = (metricsBefore.match(/outcome="credits_exhausted"/g) ?? []).length;

    // Trigger the credits_exhausted path — any model is fine (open allow-list key).
    const res = await rpc(
      { jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt: "hello" } } },
      exhaustedKey
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as { result: { isError: boolean; content: Array<{ type: string; text: string }> } };
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/credit/i);

    // Read metrics AFTER — outcome="credits_exhausted" must have appeared (not "rate_limited").
    const metricsAfter = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, {
      headers: { authorization: `Bearer ${openKey}` },
    }).then((r) => r.text());
    const exhaustedAfter = (metricsAfter.match(/outcome="credits_exhausted"/g) ?? []).length;
    expect(exhaustedAfter).toBeGreaterThan(exhaustedBefore);

    // Strengthen (Codex M2b LOW): the durable request_log row must carry the aligned
    // 402/credits_exhausted tuple, and a lifetime-credit exhaustion must NOT be logged
    // or counted as rate_limited.
    const row = getDb()
      .prepare(
        "SELECT status, outcome, error_class FROM request_log WHERE alias = 'mcp-exhausted' AND route = '/mcp/ask' ORDER BY ts DESC LIMIT 1"
      )
      .get() as { status: number; outcome: string; error_class: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.status).toBe(402);
    expect(row!.outcome).toBe("credits_exhausted");
    expect(row!.error_class).toBe("credits_exhausted");

    const rateLimitedRows = (
      getDb()
        .prepare("SELECT COUNT(*) AS n FROM request_log WHERE alias = 'mcp-exhausted' AND outcome = 'rate_limited'")
        .get() as { n: number }
    ).n;
    expect(rateLimitedRows).toBe(0);

    const quotaRateLimited = (txt: string): number => {
      const m = txt.match(/^homeserver_rate_limited_total\{surface="quota"\}\s+([0-9.]+)/m);
      return m ? Number(m[1]) : 0;
    };
    expect(quotaRateLimited(metricsAfter)).toBe(quotaRateLimited(metricsBefore));
  });
});

// ─── tools/call ask → delegations ledger (owner usage telemetry, RQ6/RQ7) ────────────
//
// Every owner `ask` should self-record to the capability ledger with a classified task_type,
// so the real Claude→local offload channel becomes a task-typed usage dataset. Owner-tier +
// minted-key ONLY (mirrors owner-log) so no GUEST content is ever excerpted. These rows are
// usage-only — outcome "unverified" — so they never affect capability VERDICT math.
describe("MCP ask → delegations ledger (owner usage telemetry)", () => {
  beforeAll(() => {
    ensureLedgerSchema();
    ensureDelegationCostSchema();
  });
  const mcpAskDelegations = (): number =>
    (getDb().prepare("SELECT COUNT(*) AS n FROM delegations WHERE source = 'mcp-ask'").get() as { n: number }).n;

  it("records an owner ask in the content-blind cross-client exposure registry", async () => {
    const prompt = "MCP_EXPOSURE_RAW_MARKER_257";
    const res = await rpc(
      { jsonrpc: "2.0", id: 205, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt } } },
      openKey
    );
    expect(res.status).toBe(200);

    const fingerprint = taskTextFingerprint(prompt).sha256;
    const exposure = lookupTaskExposures({
      fingerprint_version: TASK_FINGERPRINT_VERSION,
      fingerprints: [fingerprint],
    });
    expect(exposure.results[0]).toMatchObject({
      seen: true,
      lanes: ["mcp-ask"],
      harness_ids: ["mcp-ask"],
    });
    // The test upstream has no trusted /models catalogue, so the gateway intentionally omits an
    // unverified caller label instead of publishing it as canonical model metadata.
    expect(exposure.results[0]?.model_ids).toEqual([]);
    const stored = getDb().prepare(
      `SELECT * FROM task_exposure_events WHERE fingerprint_sha256 = ?`
    ).get(fingerprint) as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(prompt);
  });

  it("records an owner ask as an unverified mcp-ask delegation tagged with the classified task_type", async () => {
    const prompt = "Summarize the following text in one sentence: the quick brown fox jumps over the lazy dog.";
    const before = mcpAskDelegations();
    const res = await rpc(
      { jsonrpc: "2.0", id: 200, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt } } },
      openKey
    );
    expect(res.status).toBe(200);
    expect(mcpAskDelegations()).toBe(before + 1);

    const row = getDb()
      .prepare("SELECT task_type, model_id, outcome, source, completion_tokens FROM delegations WHERE source = 'mcp-ask' ORDER BY ts DESC LIMIT 1")
      .get() as { task_type: string; model_id: string; outcome: string; source: string; completion_tokens: number | null };
    expect(row.source).toBe("mcp-ask");
    expect(row.outcome).toBe("unverified");
    expect(row.model_id).toBe("any-model");
    // Wired through the REAL classifier (not hardcoded): equals classifyTask(prompt).
    expect(row.task_type).toBe(classifyTask(prompt).taskType);
    expect(row.task_type.length).toBeGreaterThan(0);
    expect(row.completion_tokens).toBe(5); // from the stub upstream usage
  });

  it("uses the per-call delegator_model_id for owner ask savings accounting", async () => {
    const prompt = "Classify this one word as positive or negative: excellent.";
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 204,
        method: "tools/call",
        params: {
          name: "ask",
          arguments: {
            model: "any-model",
            prompt,
            delegator_model_id: "openai/gpt-5.5",
          },
        },
      },
      openKey
    );
    expect(res.status).toBe(200);

    const row = getDb()
      .prepare(
        "SELECT source, delegator_model, cost_status, potential_savings_actual_usd, delegate_policy_mode, delegate_policy_action FROM delegation_costs WHERE source = 'mcp-ask' ORDER BY ts DESC LIMIT 1"
      )
      .get() as {
        source: string;
        delegator_model: string | null;
        cost_status: string;
        potential_savings_actual_usd: number;
        delegate_policy_mode: string | null;
        delegate_policy_action: string | null;
      };
    expect(row.source).toBe("mcp-ask");
    expect(row.delegator_model).toBe("openai/gpt-5.5");
    expect(row.cost_status).toBe("unverified");
    expect(row.potential_savings_actual_usd).toBeGreaterThan(0);
    // #202: the primary real offload channel is policy-evaluated for evidence, but this trace
    // remains annotation-only and never changes the already-served MCP response.
    expect(row.delegate_policy_mode).toBe("shadow");
    expect(row.delegate_policy_action).toBe("shadow");
  });

  it("does NOT record a delegation for a GUEST ask (guest content is never excerpted)", async () => {
    const before = mcpAskDelegations();
    const res = await rpc(
      { jsonrpc: "2.0", id: 201, method: "tools/call", params: { name: "ask", arguments: { model: "any-model", prompt: "guest private prompt" } } },
      creditKey
    );
    expect(res.status).toBe(200);
    expect(mcpAskDelegations()).toBe(before); // unchanged — no guest row
  });

  it("records an owner upstream FAILURE as outcome='error' + error_class='infra' (kept out of verdict math)", async () => {
    const before = mcpAskDelegations();
    const res = await rpc(
      { jsonrpc: "2.0", id: 202, method: "tools/call", params: { name: "ask", arguments: { model: "boom-model", prompt: "Translate to Swedish: good morning." } } },
      openKey
    );
    expect(res.status).toBe(200); // MCP transport is 200; the tool result carries the upstream error
    expect(mcpAskDelegations()).toBe(before + 1);

    const row = getDb()
      .prepare("SELECT task_type, model_id, outcome, error_class FROM delegations WHERE source = 'mcp-ask' ORDER BY ts DESC LIMIT 1")
      .get() as { task_type: string; model_id: string; outcome: string; error_class: string | null };
    expect(row.model_id).toBe("boom-model");
    expect(row.outcome).toBe("error");
    expect(row.error_class).toBe("infra");
    // Invariant: usage-telemetry rows (unverified successes AND infra errors) never feed verdicts.
    expect(getVerdict(row.task_type, "boom-model", DEFAULT_POLICY).attempts).toBe(0);
  });

  it("does NOT record a delegation for a pre-admission rejected owner ask (admitted-only contract)", async () => {
    // Owner key restricted to one model → asking a different model is rejected BEFORE admission,
    // so no inference ran and nothing is recorded to the ledger (it lives in request_log instead).
    const restrictedOwner = mintKey(
      { alias: "mcp-owner-restricted", tier: "owner", modelAllowList: ["only-allowed"] },
      DEFAULTS
    ).plaintextKey;
    const before = mcpAskDelegations();
    const res = await rpc(
      { jsonrpc: "2.0", id: 203, method: "tools/call", params: { name: "ask", arguments: { model: "some-other-model", prompt: "hi" } } },
      restrictedOwner
    );
    expect(res.status).toBe(200);
    expect(mcpAskDelegations()).toBe(before); // unchanged — pre-admission reject is not a delegation
  });
});
