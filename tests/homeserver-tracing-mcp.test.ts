import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initDb } from "../src/db.js";

let upstream: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

let releaseStall: (() => void) | null = null;
let mode: "ok" | "stall" | "reset" | "hang" | "http-5xx" = "ok";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.includes("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        if (mode === "reset") {
          req.socket.destroy();
          return;
        }
        if (mode === "hang") {
          await new Promise<void>(() => {});
          return;
        }
        if (mode === "http-5xx") {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "UPSTREAM_ONLY_BODY" } }));
          return;
        }
        if (mode === "stall") {
          await new Promise<void>((resolve) => {
            releaseStall = resolve;
          });
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        }));
      });
      return;
    }
    if (req.method === "GET" && (url.includes("/models") || url.includes("/running"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(url.includes("/running")
        ? { running: [{ model: "m1", state: "ready", cmd: "--model /srv/models/m1.gguf --ctx-size 32768" }] }
        : { data: [{ id: "m1", object: "model" }] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    }),
  );
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-tracing-mcp-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "1";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_TRACE_INSTRUMENTATION"] = "on";
  process.env["HOMESERVER_TRACE_EXPORT"] = "on";
  process.env["HOMESERVER_TRACE_RELEASE"] = "git-mcp-tracing-test";
  process.env["HOMESERVER_TRACE_INSTANCE_ID"] = "gateway-mcp-test";
  process.env["HOMESERVER_RECURRENT_MODEL_IDS"] = "m1";
  process.env["HOMESERVER_CALL_TIMEOUT_MS"] = "120";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  const quota = await import("../src/homeserver/quota.js");
  const tracing = await import("../src/homeserver/tracing.js");
  mintKey = ks.mintKey;
  resetQuotaWindows = quota.resetQuotaWindows;
  flushTracingForTests = tracing.flushTracingForTests;
  setTracingTestHooks = tracing.setTracingTestHooks;
  resetTracingTestHooks = tracing.resetTracingTestHooks;
  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
}, 20_000);

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  mode = "ok";
  releaseStall = null;
  resetQuotaWindows();
  resetTracingTestHooks();
});

afterEach(() => {
  releaseStall?.();
  releaseStall = null;
  resetTracingTestHooks();
});

function gatewayUrl(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

async function mcpAsk(
  token: string,
  args: Record<string, unknown>,
  traceId: string,
  id = 1,
): Promise<Response> {
  return fetch(gatewayUrl("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      traceparent: `00-${traceId}-b9c7c989f97918e1-01`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "ask", arguments: args },
    }),
  });
}

async function mcpRaw(token: string, rawBody: string, traceId: string): Promise<Response> {
  return fetch(gatewayUrl("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      traceparent: `00-${traceId}-b9c7c989f97918e1-01`,
    },
    body: rawBody,
  });
}

function traceSpans(records: readonly unknown[]): Array<{
  phase: string;
  trace_id: string;
  outcome: string;
  error_class?: string;
}> {
  return records.filter((record) => (record as { kind?: string }).kind === "trace-span") as Array<{
    phase: string;
    trace_id: string;
    outcome: string;
    error_class?: string;
  }>;
}

function gatewayReadiness(records: readonly unknown[]): Array<{
  trace?: { trace_id: string };
  outcome: string;
  error_class?: string;
}> {
  return records.filter((record) =>
    (record as { kind?: string; slot_id?: string }).kind === "service-observation"
    && (record as { slot_id?: string }).slot_id === "gateway-ready"
  ) as Array<{
    trace?: { trace_id: string };
    outcome: string;
    error_class?: string;
  }>;
}

async function askOutcomeForTrace(
  traceId: string,
): Promise<{
  gateway: { outcome: string; error_class?: string };
  readiness: { outcome: string; error_class?: string };
}> {
  const records = await flushTracingForTests();
  const gateway = traceSpans(records).find((span) => span.phase === "gateway" && span.trace_id === traceId);
  const readiness = gatewayReadiness(records).find((record) => record.trace?.trace_id === traceId);
  expect(gateway).toBeDefined();
  expect(readiness).toBeDefined();
  return {
    gateway: gateway!,
    readiness: readiness!,
  };
}

describe("MCP ask tracing", () => {
  it("marks a parse error as a bad request while preserving the HTTP 200 JSON-RPC error", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-parse", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4742";

    const res = await mcpRaw(key.plaintextKey, "{malformed SECRET_PARSE https://private.example", traceId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });

    const { gateway, readiness } = await askOutcomeForTrace(traceId);
    expect(gateway).toMatchObject({ outcome: "bad_request", error_class: "invalid_request_error" });
    expect(readiness).toMatchObject({ outcome: "unknown", error_class: "invalid_request_error" });
  });

  it("marks an invalid JSON-RPC shape as a bad request while preserving its HTTP 200 body", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-shape", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4743";

    const res = await mcpRaw(key.plaintextKey, JSON.stringify({ jsonrpc: "2.0", id: 301 }), traceId);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });

    const { gateway, readiness } = await askOutcomeForTrace(traceId);
    expect(gateway).toMatchObject({ outcome: "bad_request", error_class: "invalid_request_error" });
    expect(readiness).toMatchObject({ outcome: "unknown", error_class: "invalid_request_error" });
  });

  it("marks an unknown request method as a bad request without changing its JSON-RPC body", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-method", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4744";

    const res = await mcpRaw(
      key.plaintextKey,
      JSON.stringify({ jsonrpc: "2.0", id: 302, method: "SECRET_UNKNOWN_METHOD" }),
      traceId,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      jsonrpc: "2.0",
      id: 302,
      error: { code: -32601, message: "Method not found" },
    });

    const records = await flushTracingForTests();
    expect(JSON.stringify(records)).not.toContain("SECRET_UNKNOWN_METHOD");
    const gateway = traceSpans(records).find((span) => span.phase === "gateway" && span.trace_id === traceId);
    const readiness = gatewayReadiness(records).find((record) => record.trace?.trace_id === traceId);
    expect(gateway).toMatchObject({ outcome: "bad_request", error_class: "invalid_request_error" });
    expect(readiness).toMatchObject({ outcome: "unknown", error_class: "invalid_request_error" });
  });

  it("does not classify a valid notification as a bad request", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-notification", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4745";

    const res = await mcpRaw(
      key.plaintextKey,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      traceId,
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");

    const { gateway, readiness } = await askOutcomeForTrace(traceId);
    expect(gateway.outcome).toBe("ok");
    expect(readiness.outcome).toBe("ok");
    expect(gateway.error_class).toBeUndefined();
    expect(readiness.error_class).toBeUndefined();
  });

  it("keeps a successful ask at ok for both the gateway span and readiness", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-ok", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4701";

    const res = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "hi" }, traceId, 201);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);

    const { gateway, readiness } = await askOutcomeForTrace(traceId);
    expect(gateway.outcome).toBe("ok");
    expect(readiness.outcome).toBe("ok");
  });

  it("maps ordinary client/policy tool errors to semantic spans and unknown readiness", async () => {
    setTracingTestHooks({ captureExports: true });

    const forbiddenKey = mintKey({ alias: "trace-mcp-forbidden", tier: "guest", modelAllowList: ["only-this-model"] }, DEFAULTS);
    const forbiddenTraceId = "4bf92f3577b34da6a3ce929d0e0e4702";
    const forbiddenRes = await mcpAsk(forbiddenKey.plaintextKey, { model: "m1", prompt: "hi" }, forbiddenTraceId, 202);
    expect(forbiddenRes.status).toBe(200);
    const forbiddenBody = await forbiddenRes.json() as { result: { isError: boolean } };
    expect(forbiddenBody.result.isError).toBe(true);

    const forbidden = await askOutcomeForTrace(forbiddenTraceId);
    expect(forbidden.gateway).toMatchObject({ outcome: "forbidden", error_class: "model_not_allowed" });
    expect(forbidden.readiness.outcome).toBe("unknown");

    setTracingTestHooks({ captureExports: true });
    const exhaustedKey = mintKey({ alias: "trace-mcp-exhausted", tier: "guest", modelAllowList: ["m1"], creditLimit: 1 }, DEFAULTS);
    const exhaustedTraceId = "4bf92f3577b34da6a3ce929d0e0e4703";
    const exhaustedRes = await mcpAsk(exhaustedKey.plaintextKey, { model: "m1", prompt: "hi" }, exhaustedTraceId, 203);
    expect(exhaustedRes.status).toBe(200);
    const exhaustedBody = await exhaustedRes.json() as { result: { isError: boolean } };
    expect(exhaustedBody.result.isError).toBe(true);

    const exhausted = await askOutcomeForTrace(exhaustedTraceId);
    expect(exhausted.gateway).toMatchObject({ outcome: "credits_exhausted", error_class: "credits_exhausted" });
    expect(exhausted.readiness.outcome).toBe("unknown");
  });

  it("keeps a generic upstream HTTP 5xx at transport 200 but marks semantic tracing failure", async () => {
    setTracingTestHooks({ captureExports: true });
    mode = "http-5xx";
    const key = mintKey({ alias: "trace-mcp-http-5xx", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4709";

    const res = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "hi" }, traceId, 209);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);

    const records = await flushTracingForTests();
    expect(JSON.stringify(records)).not.toContain("UPSTREAM_ONLY_BODY");
    const gateway = traceSpans(records).find((span) => span.phase === "gateway" && span.trace_id === traceId);
    const readiness = gatewayReadiness(records).find((record) => record.trace?.trace_id === traceId);
    expect(gateway).toMatchObject({ outcome: "error", error_class: "upstream_error" });
    expect(readiness).toMatchObject({ outcome: "failed", error_class: "upstream_error" });
  });

  it("maps a rate-limited ask tool error to degraded readiness and a rate_limited gateway span", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey(
      { alias: "trace-mcp-quota", tier: "guest", modelAllowList: ["m1"] },
      { ...DEFAULTS, dailyTokenBudget: 1 },
    );
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4704";

    const res = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "this exceeds the tiny daily budget" }, traceId, 204);
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { isError: boolean } };
    expect(body.result.isError).toBe(true);

    const { gateway, readiness } = await askOutcomeForTrace(traceId);
    expect(gateway).toMatchObject({ outcome: "rate_limited", error_class: "rate_limit_exceeded" });
    expect(readiness.outcome).toBe("degraded");
  });

  it("maps a busy ask tool error to degraded readiness and a busy gateway span", async () => {
    setTracingTestHooks({ captureExports: true });
    mode = "stall";
    const key = mintKey({ alias: "trace-mcp-busy", tier: "guest", modelAllowList: ["m1"] }, { ...DEFAULTS, maxParallel: 1 });

    const held = mcpAsk(key.plaintextKey, { model: "m1", prompt: "held" }, "4bf92f3577b34da6a3ce929d0e0e4705", 205);
    for (let attempt = 0; attempt < 20 && releaseStall === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releaseStall).not.toBeNull();

    const busyTraceId = "4bf92f3577b34da6a3ce929d0e0e4706";
    const rejected = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "busy" }, busyTraceId, 206);
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json() as { result: { isError: boolean } };
    expect(rejectedBody.result.isError).toBe(true);

    releaseStall?.();
    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    await heldRes.json();

    const { gateway, readiness } = await askOutcomeForTrace(busyTraceId);
    expect(gateway).toMatchObject({ outcome: "busy", error_class: "server_busy" });
    expect(readiness.outcome).toBe("degraded");
  });

  it("maps upstream-unavailable and upstream-timeout ask tool errors to failed readiness and semantic gateway spans", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-mcp-upstream", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);

    mode = "reset";
    const unavailableTraceId = "4bf92f3577b34da6a3ce929d0e0e4707";
    const unavailableRes = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "hi" }, unavailableTraceId, 207);
    expect(unavailableRes.status).toBe(200);
    const unavailableBody = await unavailableRes.json() as { result: { isError: boolean } };
    expect(unavailableBody.result.isError).toBe(true);

    const unavailable = await askOutcomeForTrace(unavailableTraceId);
    expect(unavailable.gateway).toMatchObject({ outcome: "upstream_unavailable", error_class: "upstream_unavailable" });
    expect(unavailable.readiness.outcome).toBe("failed");

    setTracingTestHooks({ captureExports: true });
    mode = "hang";
    const timeoutTraceId = "4bf92f3577b34da6a3ce929d0e0e4708";
    const timeoutRes = await mcpAsk(key.plaintextKey, { model: "m1", prompt: "hi" }, timeoutTraceId, 208);
    expect(timeoutRes.status).toBe(200);
    const timeoutBody = await timeoutRes.json() as { result: { isError: boolean } };
    expect(timeoutBody.result.isError).toBe(true);

    const timeout = await askOutcomeForTrace(timeoutTraceId);
    expect(timeout.gateway).toMatchObject({ outcome: "upstream_timeout", error_class: "upstream_timeout" });
    expect(timeout.readiness.outcome).toBe("failed");
  });
});
