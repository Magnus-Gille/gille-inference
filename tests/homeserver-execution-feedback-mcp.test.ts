import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";

/**
 * Real Streamable-HTTP MCP coverage for exact execution-feedback handles.
 * The local upstream is deliberately deterministic and never leaves the test process.
 */

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const STATIC_ADMIN_KEY = "execution-feedback-static-admin";

const TOUCHED_ENV = [
  "LMSTUDIO_BASE_URL",
  "HOMESERVER_BACKEND",
  "HOMESERVER_HOST",
  "HOMESERVER_PORT",
  "HOMESERVER_API_KEYS",
  "HOMESERVER_ADMIN_API_KEYS",
  "HOMESERVER_MONITOR_API_KEYS",
  "HOMESERVER_MAX_INFLIGHT",
  "HOMESERVER_PER_REQUEST_MAX_TOKENS",
  "HOMESERVER_KEY_DEFAULT_RPM",
  "HOMESERVER_KEY_DEFAULT_TPM",
  "HOMESERVER_REDEEM_RPM",
  "HOMESERVER_DELEGATION_COST_LOG",
  "HOMESERVER_REQUEST_LOG",
] as const;
const SAVED_ENV = new Map<string, string | undefined>();
for (const name of TOUCHED_ENV) SAVED_ENV.set(name, process.env[name]);

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let agentKey = "";
let adminKey = "";
let guestKey = "";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mellum", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamHits++;
      let model = "";
      try {
        model = (JSON.parse(Buffer.concat(chunks).toString()) as { model?: string }).model ?? "";
      } catch {
        // The gateway owns malformed-upstream handling; these tests send valid requests.
      }
      if (model === "boom-model") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "boom" } }));
        return;
      }
      const content = model === "empty-model" ? "" : model === "truncated-model" ? "F-2" : "STUBBED COMPLETION";
      const finishReason = model === "truncated-model" ? "length" : model === "unknown-finish-model" ? null : "stop";
      const completionTokens = model === "empty-model" ? 0 : model === "truncated-model" ? 64 : 5;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `cmpl-${model}`,
        choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }],
        usage: { prompt_tokens: 5, completion_tokens: completionTokens, total_tokens: 5 + completionTokens },
      }));
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    });
  });
}

type ToolResult = {
  result: {
    content: Array<{ type: string; text: string }>;
    isError: boolean;
    structuredContent?: Record<string, unknown>;
  };
};

async function rpc(body: unknown, key?: string): Promise<ToolResult> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ToolResult;
}

async function ask(key: string | undefined, model: string, prompt: string, extra: Record<string, unknown> = {}): Promise<ToolResult> {
  return rpc({
    jsonrpc: "2.0",
    id: `${model}-${prompt}`,
    method: "tools/call",
    params: { name: "ask", arguments: { model, prompt, ...extra } },
  }, key);
}

function latestFeedback(alias: string, model: string): {
  handle: string;
  trafficPurpose: string;
  ledgerId: string;
  source: string;
  outcome: string;
  keyAlias: string | null;
} | undefined {
  return getDb().prepare(`
    SELECT f.handle, f.traffic_purpose AS trafficPurpose, d.id AS ledgerId,
           d.source, d.outcome, d.key_alias AS keyAlias
      FROM execution_feedback f
      JOIN delegations d ON d.id = f.ledger_id
     WHERE d.key_alias = ? AND d.model_id = ?
     ORDER BY d.ts DESC
     LIMIT 1
  `).get(alias, model) as {
    handle: string;
    trafficPurpose: string;
    ledgerId: string;
    source: string;
    outcome: string;
    keyAlias: string | null;
  } | undefined;
}

function feedbackCount(): number {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM execution_feedback").get() as { n: number }).n;
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-execution-feedback-mcp-"));
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
  process.env["HOMESERVER_ADMIN_API_KEYS"] = STATIC_ADMIN_KEY;
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  const { resetConfig } = await import("../src/homeserver/config.js");
  resetConfig();
  const { mintKey } = await import("../src/homeserver/keystore.js");
  agentKey = mintKey({ alias: "feedback-mcp-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
  adminKey = mintKey({ alias: "feedback-mcp-admin", tier: "owner", scope: "admin" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "feedback-mcp-guest", tier: "guest", scope: "inference" }, DEFAULTS).plaintextKey;

  const { startGateway } = await import("../src/homeserver/gateway.js");
  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway !== null) await stopGateway();
  if (upstream?.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const name of TOUCHED_ENV) {
    const value = SAVED_ENV.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("MCP ask exact execution feedback handles", () => {
  it("returns an opaque handle for an owner-agent ask and preserves organic purpose/result text", async () => {
    const model = "organic-agent-model";
    const result = await ask(agentKey, model, "organic owner agent prompt", { traffic_purpose: "organic" });
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0]?.text).toBe("STUBBED COMPLETION");
    const structured = result.result.structuredContent!;
    expect(structured.text).toBe("STUBBED COMPLETION");
    expect(structured.feedback_handle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const row = latestFeedback("feedback-mcp-agent", model)!;
    expect(row).toMatchObject({ trafficPurpose: "organic", source: "mcp-ask", outcome: "unverified", keyAlias: "feedback-mcp-agent" });
    expect(row.handle).toBe(structured.feedback_handle);
    expect(row.handle).not.toBe(row.ledgerId);
  });

  it("returns a handle for an owner-admin ask but defaults omitted purpose to unknown", async () => {
    const model = "unknown-admin-model";
    const result = await ask(adminKey, model, "owner admin prompt");
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent?.feedback_handle).toMatch(/^[0-9a-f-]{36}$/i);
    expect(latestFeedback("feedback-mcp-admin", model)).toMatchObject({
      trafficPurpose: "unknown",
      source: "mcp-ask",
      outcome: "unverified",
    });
  });

  it("rejects an invalid purpose before inference and creates no feedback row", async () => {
    const hitsBefore = upstreamHits;
    const rowsBefore = feedbackCount();
    const result = await ask(agentKey, "invalid-purpose-model", "must not run", { traffic_purpose: "organic-ish" });
    expect(result.result.isError).toBe(true);
    expect(upstreamHits).toBe(hitsBefore);
    expect(feedbackCount()).toBe(rowsBefore);
  });

  it.each([
    ["boom-model", "failed output"],
    ["truncated-model", "truncated output"],
    ["empty-model", "empty output"],
  ])("does not mint a handle for %s", async (model, prompt) => {
    const before = feedbackCount();
    const result = await ask(agentKey, model, prompt);
    expect(result.result.isError).toBe(model === "boom-model" || model === "truncated-model");
    expect(result.result.structuredContent?.feedback_handle).toBeUndefined();
    expect(feedbackCount()).toBe(before);
  });

  it("does not mint a handle for guest traffic", async () => {
    const result = await ask(guestKey, "excluded-guest", "guest prompt");
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent?.feedback_handle).toBeUndefined();
  });

  it("does not mint a handle for the legacy static admin", async () => {
    const result = await ask(STATIC_ADMIN_KEY, "excluded-legacy-static-admin", "legacy static admin prompt");
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent?.feedback_handle).toBeUndefined();
  });

  it("preserves nonempty output but does not bind when finish metadata is unknown", async () => {
    const before = feedbackCount();
    const result = await ask(agentKey, "unknown-finish-model", "unknown completion metadata");
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0]?.text).toBe("STUBBED COMPLETION");
    const structured = result.result.structuredContent!;
    expect(structured.text).toBe("STUBBED COMPLETION");
    expect(structured.feedback_handle).toBeUndefined();
    expect(feedbackCount()).toBe(before);
  });

  it("preserves completed output and the cost trace when feedback binding fails", async () => {
    const model = "feedback-binding-failure-model";
    const seed = await ask(agentKey, model, "seed feedback schema and cost trace");
    expect(seed.result.isError).toBe(false);

    getDb().exec(`
      CREATE TRIGGER feedback_binding_failure_mcp
      BEFORE INSERT ON execution_feedback
      BEGIN
        SELECT RAISE(ABORT, 'feedback-binding-failed-mcp');
      END;
    `);

    const result = await ask(agentKey, model, "completed output must survive feedback binding failure");
    expect(result.result.isError).toBe(false);
    expect(result.result.content[0]?.text).toBe("STUBBED COMPLETION");
    const structured = result.result.structuredContent!;
    expect(structured.text).toBe("STUBBED COMPLETION");
    expect(structured.feedback_handle).toBeUndefined();

    const delegation = getDb().prepare(`
      SELECT id, source, outcome
        FROM delegations
       WHERE key_alias = ? AND model_id = ? AND source = 'mcp-ask'
       ORDER BY rowid DESC
       LIMIT 1
    `).get("feedback-mcp-agent", model) as { id: string; source: string; outcome: string };
    expect(delegation).toMatchObject({ source: "mcp-ask", outcome: "unverified" });

    const cost = getDb().prepare(`
      SELECT delegation_id, source, cost_status, outcome
        FROM delegation_costs
       WHERE delegation_id = ?
    `).get(delegation.id) as {
      delegation_id: string;
      source: string;
      cost_status: string;
      outcome: string;
    };
    expect(cost).toMatchObject({
      delegation_id: delegation.id,
      source: "mcp-ask",
      cost_status: "unverified",
      outcome: "unverified",
    });
  });

  it("does not mint a handle for loopback implicit-admin", async () => {
    if (stopGateway !== null) await stopGateway();
    // Keep the existing connection: quota's process-local schema guard is intentionally
    // one-shot, while the gateway restart still exercises the frozen implicit-admin posture.
    const { revokeKey } = await import("../src/homeserver/keystore.js");
    revokeKey("feedback-mcp-agent");
    revokeKey("feedback-mcp-admin");
    revokeKey("feedback-mcp-guest");
    delete process.env["HOMESERVER_ADMIN_API_KEYS"];
    const { resetConfig } = await import("../src/homeserver/config.js");
    resetConfig();
    const { startGateway } = await import("../src/homeserver/gateway.js");
    const handle = await startGateway();
    gatewayPort = handle.port;
    stopGateway = handle.stop;

    const result = await ask(undefined, "implicit-model", "implicit prompt");
    expect(result.result.isError).toBe(false);
    expect(result.result.structuredContent?.feedback_handle).toBeUndefined();
  });
});
