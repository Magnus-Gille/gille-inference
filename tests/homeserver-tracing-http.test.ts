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
let mode: "stream" | "slow-stream" | "abort-stream" | "degenerate-stream" = "stream";

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
        if (mode === "abort-stream") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`);
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        if (mode === "degenerate-stream") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "??????" } }] })}\n\n`);
          setTimeout(() => {
            if (res.destroyed || res.writableEnded) return;
            res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }, 100);
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
  process.env["HOMESERVER_RECURRENT_MODEL_IDS"] = "m1";
  process.env["HOMESERVER_POISON_CLEAR_COOLDOWN_MS"] = "50";
  process.env["HOMESERVER_DEGENERACY_RUN_THRESHOLD"] = "5";

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

function traceSpans(records: readonly unknown[]): Array<{
  phase: string;
  trace_id: string;
  span_id: string;
  parent_span_id?: string;
  outcome: string;
  error_class?: string;
  started_at?: string;
}> {
  return records.filter((record) => (record as { kind?: string }).kind === "trace-span") as Array<{
    phase: string;
    trace_id: string;
    span_id: string;
    parent_span_id?: string;
    outcome: string;
    error_class?: string;
    started_at?: string;
  }>;
}

function gatewayReadiness(records: readonly unknown[]): Array<{ outcome: string }> {
  return records.filter((record) =>
    (record as { kind?: string; slot_id?: string }).kind === "service-observation"
    && (record as { slot_id?: string }).slot_id === "gateway-ready"
  ) as Array<{ outcome: string }>;
}

describe("HTTP tracing", () => {
  it("propagates W3C trace context through streaming chat and records TTFT/response spans", async () => {
    setTracingTestHooks({
      captureExports: true,
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("b9c7c989f97918e2")
        .mockReturnValueOnce("1111111111111111")
        .mockReturnValueOnce("2222222222222222")
        .mockReturnValueOnce("3333333333333333")
        .mockReturnValueOnce("4444444444444444"),
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
    expect(res.headers.get("tracestate")).toBe("hugin=owner");
    expect(await res.text()).toContain("[DONE]");
    expect(seenTracestates).toContain("hugin=owner");

    const records = await flushTracingForTests();
    const joined = JSON.stringify(records);
    const spans = traceSpans(records);
    const gateway = spans.find((span) => span.phase === "gateway");
    const admission = spans.find((span) => span.phase === "admission");
    const queue = spans.find((span) => span.phase === "queue");
    const inference = spans.find((span) => span.phase === "inference");
    const ttft = spans.find((span) => span.phase === "ttft");
    const response = spans.find((span) => span.phase === "response");
    expect(seenTraceparents[0]).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${inference?.span_id}-01`);
    expect(gateway).toBeDefined();
    expect(admission?.parent_span_id).toBe(gateway?.span_id);
    expect(queue?.parent_span_id).toBe(admission?.span_id);
    expect(inference).toBeDefined();
    expect(inference?.parent_span_id).toBe(gateway?.span_id);
    expect(ttft?.parent_span_id).toBe(inference?.span_id);
    expect(response?.parent_span_id).toBe(inference?.parent_span_id);
    expect(response?.parent_span_id).toBe(gateway?.span_id);
    expect(response?.parent_span_id).not.toBe(inference?.span_id);
    expect(response?.parent_span_id).not.toBe(admission?.span_id);
    expect(inference?.parent_span_id).not.toBe(admission?.span_id);
    expect(Date.parse(response?.started_at ?? "")).toBeLessThanOrEqual(Date.parse(inference?.started_at ?? ""));
    expect(joined).toContain("\"phase\":\"response\"");
    expect(joined).not.toContain("\"content\":\"hi\"");
    expect(gatewayReadiness(records).at(-1)?.outcome).toBe("ok");
  });

  it("propagates validated W3C trace context through non-streaming chat with an active inference child and no TTFT span", async () => {
    setTracingTestHooks({
      captureExports: true,
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("aaaaaaaaaaaaaaaa")
        .mockReturnValueOnce("bbbbbbbbbbbbbbbb")
        .mockReturnValueOnce("cccccccccccccccc")
        .mockReturnValueOnce("dddddddddddddddd"),
    });
    const key = mintKey({ alias: "trace-http-json", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        tracestate: "hugin=owner",
      },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(seenTracestates[0]).toBe("hugin=owner");

    const records = await flushTracingForTests();
    const spans = traceSpans(records);
    const gateway = spans.find((span) => span.phase === "gateway");
    const inference = spans.find((span) => span.phase === "inference");
    const response = spans.find((span) => span.phase === "response");
    expect(seenTraceparents[0]).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${inference?.span_id}-01`);
    expect(gateway).toBeDefined();
    expect(inference).toBeDefined();
    expect(response?.parent_span_id).toBe(inference?.parent_span_id);
    expect(response?.parent_span_id).not.toBe(inference?.span_id);
    expect(spans.some((span) => span.phase === "ttft")).toBe(false);
    expect(gatewayReadiness(records).at(-1)?.outcome).toBe("ok");
  });

  it("drops hostile inbound trace context and never echoes invalid tracestate", async () => {
    setTracingTestHooks({
      captureExports: true,
      nextTraceId: vi.fn<() => string>().mockReturnValue("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      nextSpanId: vi
        .fn<() => string>()
        .mockReturnValueOnce("bbbbbbbbbbbbbbbb")
        .mockReturnValueOnce("cccccccccccccccc")
        .mockReturnValueOnce("dddddddddddddddd")
        .mockReturnValueOnce("eeeeeeeeeeeeeeee"),
    });
    const key = mintKey({ alias: "trace-http-hostile", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    const hostileTracestate = "hugin=owner,evil =bad";
    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: "ff-4bf92f3577b34da6a3ce929d0e0e4736-b9c7c989f97918e1-01",
        tracestate: hostileTracestate,
      },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("traceparent")).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(res.headers.get("tracestate")).toBeNull();
    expect(seenTracestates[0]).toBe("");

    const records = await flushTracingForTests();
    const inference = traceSpans(records).find((span) => span.phase === "inference");
    expect(seenTraceparents[0]).toBe(`00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-${inference?.span_id}-01`);
    expect(JSON.stringify(records)).not.toContain(hostileTracestate);
  });

  it("records failed gateway readiness for a truncated 200 stream", async () => {
    setTracingTestHooks({ captureExports: true });
    mode = "abort-stream";
    const key = mintKey({ alias: "trace-http-abort", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("[DONE]");
    const records = await flushTracingForTests();
    expect(gatewayReadiness(records).at(-1)?.outcome).toBe("failed");
  });

  it("records failed gateway readiness for a degenerate 200 stream", async () => {
    setTracingTestHooks({ captureExports: true });
    mode = "degenerate-stream";
    const key = mintKey({ alias: "trace-http-degenerate", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);

    const res = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("degenerate response and was reset");
    const records = await flushTracingForTests();
    expect(gatewayReadiness(records).at(-1)?.outcome).toBe("failed");
  });

  it("records client cancellation and a queued admission span without changing the request outcome path", async () => {
    setTracingTestHooks({ captureExports: true });
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
    expect(gatewayReadiness(records).some((record) => record.outcome === "unknown")).toBe(true);
  });

  it("finishes a busy admission span without creating response or inference spans for the rejected request", async () => {
    setTracingTestHooks({ captureExports: true });
    const key = mintKey({ alias: "trace-busy", tier: "guest", modelAllowList: ["m1"] }, DEFAULTS);
    mode = "slow-stream";

    const held = fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "held" }] }),
    });

    for (let attempt = 0; attempt < 20 && releaseSlow === null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(releaseSlow).not.toBeNull();

    const busyTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const busy = await fetch(gatewayUrl("/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key.plaintextKey}`,
        traceparent: `00-${busyTraceId}-b9c7c989f97918e1-01`,
      },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "busy" }] }),
    });

    expect(busy.status).toBe(503);
    await busy.text();
    releaseSlow?.();
    const heldRes = await held;
    expect(heldRes.status).toBe(200);
    await heldRes.text();

    const records = await flushTracingForTests();
    const busySpans = traceSpans(records).filter((span) => span.trace_id === busyTraceId);
    const gateway = busySpans.find((span) => span.phase === "gateway");
    const admission = busySpans.find((span) => span.phase === "admission");
    const queue = busySpans.find((span) => span.phase === "queue");
    expect(gateway).toBeDefined();
    expect(admission).toMatchObject({
      parent_span_id: gateway?.span_id,
      outcome: "busy",
      error_class: "server_busy",
    });
    expect(queue?.parent_span_id).toBe(admission?.span_id);
    expect(busySpans.some((span) => span.phase === "response")).toBe(false);
    expect(busySpans.some((span) => span.phase === "inference")).toBe(false);
  });
});
