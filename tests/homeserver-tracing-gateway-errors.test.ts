import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initDb } from "../src/db.js";

const recordMessageTaskExposuresBestEffortMock = vi.fn();

vi.mock("../src/homeserver/task-exposure.js", async () => {
  const actual = await vi.importActual<typeof import("../src/homeserver/task-exposure.js")>(
    "../src/homeserver/task-exposure.js",
  );
  return {
    ...actual,
    recordMessageTaskExposuresBestEffort: (...args: Parameters<typeof actual.recordMessageTaskExposuresBestEffort>) =>
      recordMessageTaskExposuresBestEffortMock(...args),
  };
});

let upstream: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let flushTracingForTests: typeof import("../src/homeserver/tracing.js").flushTracingForTests;
let setTracingTestHooks: typeof import("../src/homeserver/tracing.js").setTracingTestHooks;
let resetTracingTestHooks: typeof import("../src/homeserver/tracing.js").resetTracingTestHooks;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "GET" && (url.includes("/models") || url.includes("/running"))) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(url.includes("/running")
        ? { running: [{ model: "m1", state: "ready", cmd: "--model /srv/models/m1.gguf --ctx-size 32768" }] }
        : { data: [{ id: "m1", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && url.includes("/chat/completions")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
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
  const dir = mkdtempSync(join(tmpdir(), "hs-tracing-gateway-errors-"));
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
  process.env["HOMESERVER_TRACE_RELEASE"] = "git-ff797087";
  process.env["HOMESERVER_TRACE_INSTANCE_ID"] = "gateway-error-test";

  const ks = await import("../src/homeserver/keystore.js");
  const tracing = await import("../src/homeserver/tracing.js");
  const gw = await import("../src/homeserver/gateway.js");
  mintKey = ks.mintKey;
  flushTracingForTests = tracing.flushTracingForTests;
  setTracingTestHooks = tracing.setTracingTestHooks;
  resetTracingTestHooks = tracing.resetTracingTestHooks;
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
}, 20_000);

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  recordMessageTaskExposuresBestEffortMock.mockReset();
  resetTracingTestHooks();
});

afterEach(() => {
  resetTracingTestHooks();
  vi.restoreAllMocks();
});

describe("gateway tracing unexpected errors", () => {
  it("finishes response and inference spans on an unexpected throw without leaking the thrown detail", async () => {
    setTracingTestHooks({ captureExports: true });
    recordMessageTaskExposuresBestEffortMock.mockImplementation(() => {
      throw new Error("SECRET-PROMPT https://private.example/internal?token=secret");
    });
    const key = mintKey({ alias: "trace-owner-error", tier: "owner", modelAllowList: ["m1"] }, DEFAULTS);
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: `00-${traceId}-b9c7c989f97918e1-01`,
      },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "internal_error" } });

    const records = await flushTracingForTests();
    const spans = records.filter((record) =>
      (record as { kind?: string; trace_id?: string }).kind === "trace-span"
      && (record as { trace_id?: string }).trace_id === traceId
    ) as Array<{
      phase: string;
      span_id: string;
      parent_span_id?: string;
      outcome: string;
    }>;
    const joined = JSON.stringify(records);
    const gateway = spans.find((span) => span.phase === "gateway");
    const response = spans.find((span) => span.phase === "response");
    const inference = spans.find((span) => span.phase === "inference");
    expect(gateway).toBeDefined();
    expect(response).toMatchObject({ parent_span_id: gateway?.span_id, outcome: "error" });
    expect(inference).toMatchObject({ parent_span_id: gateway?.span_id, outcome: "error" });
    expect(joined).not.toContain("SECRET-PROMPT");
    expect(joined).not.toContain("private.example");
    expect(joined).not.toContain("token=secret");
  });
});
