import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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

let seenTraceparents: string[] = [];
let seenTracestates: string[] = [];
let releaseSlow: (() => void) | null = null;
let mode: "stream" | "slow-stream" = "stream";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url.includes("/chat/completions")) {
      seenTraceparents.push(String(req.headers["traceparent"] ?? ""));
      seenTracestates.push(String(req.headers["tracestate"] ?? ""));
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean };
        if (body.stream !== true) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "cmpl-1",
            choices: [{ message: { role: "assistant", content: "ok" } }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          }));
          return;
        }
        if (mode === "slow-stream") {
          await new Promise<void>((resolve) => {
            releaseSlow = resolve;
          });
        }
        const gapMs = mode === "slow-stream" ? 200 : 15;
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`);
        await new Promise((resolve) => setTimeout(resolve, gapMs));
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
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
  const dir = mkdtempSync(join(tmpdir(), "hs-tracing-http-"));
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
  process.env["HOMESERVER_TRACE_INSTANCE_ID"] = "gateway-http-test";

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
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  seenTraceparents = [];
  seenTracestates = [];
  releaseSlow = null;
  mode = "stream";
  resetQuotaWindows();
  resetTracingTestHooks();
});

afterEach(() => {
  resetTracingTestHooks();
  vi.restoreAllMocks();
});

function gatewayUrl(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

describe("HTTP tracing", () => {
  it("propagates W3C trace context through streaming chat and records TTFT/response spans", async () => {
    setTracingTestHooks({
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("b9c7c989f97918e2")
        .mockReturnValueOnce("1111111111111111")
        .mockReturnValueOnce("2222222222222222")
        .mockReturnValueOnce("3333333333333333"),
    });
    const key = mintKey({ alias: "trace-http", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        tracestate: "hugin=owner",
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("traceparent")).toBe("00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e2-01");
    expect(await res.text()).toContain("[DONE]");
    expect(seenTracestates).toContain("hugin=owner");
    expect(seenTraceparents[0]).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[a-f0-9]{16}-01$/);

    const records = await flushTracingForTests();
    const joined = JSON.stringify(records);
    expect(joined).toContain("\"phase\":\"gateway\"");
    expect(joined).toContain("\"phase\":\"inference\"");
    expect(joined).toContain("\"phase\":\"ttft\"");
    expect(joined).toContain("\"phase\":\"response\"");
    expect(joined).not.toContain("\"content\":\"hi\"");
  });

  it("records client cancellation and a queued admission span without changing the request outcome path", async () => {
    const key = mintKey({ alias: "trace-cancel", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    mode = "slow-stream";

    const first = fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "first" }] }),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));

    const secondRes = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "second" }] }),
    });

    releaseSlow?.();
    const firstRes = await first;
    expect(firstRes.status).toBe(200);
    await firstRes.text();
    expect(secondRes.status).toBe(503);
    await secondRes.text();

    releaseSlow = null;
    mode = "slow-stream";
    const ac = new AbortController();
    const cancelPromise = fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "cancel" }] }),
      signal: ac.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseSlow?.();
    const cancelRes = await cancelPromise;
    expect(cancelRes.status).toBe(200);
    const reader = cancelRes.body!.getReader();
    await reader.read();
    ac.abort();
    try {
      await reader.read();
    } catch {
      // expected client abort
    }
    await new Promise((resolve) => setTimeout(resolve, 250));

    const records = await flushTracingForTests();
    const spans = records.filter((record) => (record as { kind?: string }).kind === "trace-span") as Array<{
      phase: string;
      outcome: string;
      duration_ms?: number;
    }>;
    expect(spans.some((span) => span.phase === "queue")).toBe(true);
    expect(spans.some((span) => span.outcome === "client_closed")).toBe(true);
  });
});
