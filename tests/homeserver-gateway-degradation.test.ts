import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { getRequestLog } from "../src/homeserver/request-log.js";
import { runChatCompletion } from "../src/homeserver/mcp.js";
import { AdmissionController } from "../src/homeserver/admission.js";
import { loadConfig } from "../src/homeserver/config.js";

/**
 * R6 — graceful degradation: UPSTREAM + STREAMING failure cases.
 *
 * These exercise the paths the happy-path spine test does not: the model backend refusing the
 * connection (→ 502 upstream_unavailable), timing out (→ 504 upstream_timeout + Retry-After), and
 * a stream that aborts AFTER SSE has begun (→ terminal error frame). Each asserts the distinct
 * envelope/frame, the request_log outcome, and — for the credit-bearing cases — that the C2
 * reconcile-to-0 invariant still holds (a failed call is never billed).
 *
 * We use a controllable mock upstream and a SHORT call timeout so the timeout case is fast.
 */

let upstream: Server;
let upstreamPort = 0;
// "ok": normal JSON; "refuse": pre-closed port (set up separately); "hang": never responds
// (drives the AbortSignal timeout); "sse-abort": emit one SSE chunk then destroy the socket.
// "sse-complete": full SSE stream with usage frame + [DONE] (happy streaming path → M-e).
let mockMode:
  | "ok"
  | "hang"
  | "sse-abort"
  | "no-body"
  | "sse-complete"
  | "error-leak"
  | "sse-slow"
  | "ok-phrase" = "ok";

// #22: set true when the upstream's "sse-slow" stream was interrupted (its request socket closed)
// BEFORE it finished sending all chunks — i.e. the gateway aborted the upstream fetch because the
// client disconnected. Proves the GPU generation was cancelled, not left running to completion.
let sseSlowInterrupted = false;

// A marker string standing in for internal detail an upstream error body might carry
// (file/model paths, host:port, stack frames). #23: it must NEVER reach the client.
const UPSTREAM_LEAK_MARKER = "/etc/llama-swap/internal-path SECRET-HOSTPORT 127.0.0.1:9999";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (mockMode === "hang") {
        // Never respond — the gateway's AbortSignal.timeout fires → upstream_timeout.
        return;
      }
      if (mockMode === "sse-abort") {
        // Begin a valid SSE stream (status + first content chunk), then abruptly destroy the
        // socket so the gateway's stream pipe errors AFTER headers were already sent.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"x","choices":[{"delta":{"content":"par"}}]}\n\n');
        // Destroy on the next tick so the first chunk reaches the gateway/client first.
        setTimeout(() => req.socket.destroy(), 20);
        return;
      }
      if (mockMode === "sse-slow") {
        // A long-running SSE stream (chunk every 25ms). Lets the client disconnect mid-stream.
        // If the gateway aborts the upstream fetch on that disconnect, our request socket closes
        // before we finish → flag it (proves the generation was cancelled, not run to completion).
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
        let finished = false;
        req.on("close", () => {
          if (!finished) sseSlowInterrupted = true;
        });
        const timer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(timer);
            return;
          }
          res.write(`data: {"id":"s","choices":[{"delta":{"content":"chunk${i}"}}]}\n\n`);
          i++;
          if (i >= 40) {
            clearInterval(timer);
            res.write(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":40,"total_tokens":43}}\n\n'
            );
            res.write("data: [DONE]\n\n");
            res.end();
            finished = true;
          }
        }, 25);
        return;
      }
      if (mockMode === "ok-phrase") {
        // A SUCCESSFUL 200 completion whose content legitimately contains the words "model not
        // found". The non-streaming path must NOT scan a 2xx body for that phrase and 400 it.
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "cmpl-2",
            choices: [{ message: { role: "assistant", content: "The error 'model not found' means the id was wrong." } }],
            usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 },
          })
        );
        return;
      }
      if (mockMode === "error-leak") {
        // A non-404 upstream error whose body carries internal detail. The gateway must NOT
        // echo this body to the client (#23) — it should normalize to a static envelope.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: UPSTREAM_LEAK_MARKER }));
        return;
      }
      if (mockMode === "no-body") {
        // Return a 204 No Content — fetch() sets body:null for 204, triggering the !upstream.body
        // path in the gateway's streaming branch. Used to test the L2 billing fix.
        res.writeHead(204);
        res.end();
        return;
      }
      if (mockMode === "sse-complete") {
        // M-e: a well-formed SSE stream — one content chunk + terminal usage frame + [DONE].
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"id":"c1","choices":[{"delta":{"role":"assistant","content":"hello"}}]}\n\n');
        res.write(
          'data: {"id":"c1","choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n'
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
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

let startGateway: typeof import("../src/homeserver/gateway.js").startGateway;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

// A second, never-listening port for the connection-refused case: we bind a throwaway server,
// capture its port, then close it so nothing is listening there.
let deadPort = 0;
let refusedGatewayPort = 0;
let stopRefusedGateway: (() => Promise<void>) | null = null;

// M-b: a raw net server that returns complete HTTP 200 headers then destroys the socket, so
// fetch() resolves but upstream.text() throws. A third gateway instance points at it.
let bodyResetServer: NetServer;
let bodyResetPort = 0;
let bodyResetGatewayPort = 0;
let stopBodyResetGateway: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-degrade-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  // Find a dead port (bind then immediately close) for the connection-refused gateway.
  await new Promise<void>((resolve) => {
    const probe = createServer(() => {});
    probe.listen(0, "127.0.0.1", () => {
      deadPort = (probe.address() as { port: number }).port;
      probe.close(() => resolve());
    });
  });

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  // SHORT timeout so the "hang" case trips the upstream_timeout path quickly.
  process.env["HOMESERVER_CALL_TIMEOUT_MS"] = "300";
  process.env["HOMESERVER_BUSY_RETRY_AFTER_S"] = "2";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";
  process.env["HOMESERVER_API_KEYS"] = "legacy-user-key";

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const q = await import("../src/homeserver/quota.js");
  const cfgMod = await import("../src/homeserver/config.js");
  startGateway = gw.startGateway;
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  resetQuotaWindows = q.resetQuotaWindows;
  setConfig = cfgMod.setConfig;

  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;

  // A second gateway instance pointed at the dead port (connection refused on every upstream call).
  cfgMod.setConfig({ lmStudioBaseUrl: `http://127.0.0.1:${deadPort}/v1` });
  const refused = await startGateway();
  refusedGatewayPort = refused.port;
  stopRefusedGateway = refused.stop;

  // M-b: raw net server — sends complete HTTP 200 headers then destroys the socket.
  // fetch() resolves (headers received) but upstream.text() throws TypeError (UND_ERR_SOCKET).
  // This simulates a mid-body connection reset AFTER headers — the unguarded path pre-fix.
  bodyResetServer = createNetServer((socket) => {
    let buf = "";
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes("\r\n\r\n")) {
        // Full HTTP request headers received — send a complete 200 response header line
        // with content-length so the client knows to wait for a body that will never come.
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n");
        // Destroy on the next tick, after the response headers have been flushed to the
        // gateway's fetch() which will then resolve with status 200, but body read will fail.
        setTimeout(() => socket.destroy(), 10);
      }
    });
  });
  await new Promise<void>((resolve) =>
    bodyResetServer.listen(0, "127.0.0.1", () => {
      bodyResetPort = (bodyResetServer.address() as { port: number }).port;
      resolve();
    })
  );
  cfgMod.setConfig({ lmStudioBaseUrl: `http://127.0.0.1:${bodyResetPort}/v1` });
  const bodyReset = await startGateway();
  bodyResetGatewayPort = bodyReset.port;
  stopBodyResetGateway = bodyReset.stop;

  // Restore the live upstream for the primary gateway's subsequent requests.
  cfgMod.setConfig({ lmStudioBaseUrl: `http://127.0.0.1:${upstreamPort}/v1` });
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  if (stopRefusedGateway) await stopRefusedGateway();
  if (stopBodyResetGateway) await stopBodyResetGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  await new Promise<void>((r) => bodyResetServer.close(() => r()));
});

beforeEach(() => {
  mockMode = "ok";
  sseSlowInterrupted = false;
  resetQuotaWindows();
});

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function chat(port: number, token: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url(port, "/v1/chat/completions"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }], ...body }),
  });
}

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

/** Find the most recent request_log row for an alias (newest first). */
function lastLog(alias: string): { outcome: string; status: number; errorClass: string | null } | null {
  const row = getRequestLog(200).find((r) => r.alias === alias);
  return row ? { outcome: row.outcome, status: row.status, errorClass: row.errorClass } : null;
}

describe("R6 graceful degradation — upstream + streaming failures", () => {
  it("happy path still works (non-streaming 200 from a live upstream)", async () => {
    const k = mintKey({ alias: "deg-ok", tier: "guest" }, DEFAULTS);
    const res = await chat(gatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(200);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toBe("ok");
    expect(lastLog("deg-ok")?.outcome).toBe("ok");
  });

  it("connection refused → 502 upstream_unavailable envelope, outcome recorded, credits reconciled to 0", async () => {
    const k = mintKey({ alias: "deg-refused", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(refusedGatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(j.error.code).toBe("upstream_unavailable");
    expect(j.error.type).toBe("server_error");
    expect(j.error.message).toMatch(/backend.*unavailable/i);

    // C2: a failed call is never billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const log = lastLog("deg-refused");
    expect(log?.outcome).toBe("upstream_unavailable");
    expect(log?.status).toBe(502);
    expect(log?.errorClass).toBe("upstream_unavailable");
  });

  it("upstream timeout → 504 upstream_timeout + Retry-After, outcome recorded, credits reconciled to 0", async () => {
    mockMode = "hang";
    const k = mintKey({ alias: "deg-timeout", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(gatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(504);
    expect(res.headers.get("retry-after")).toBeTruthy();
    const j = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(j.error.code).toBe("upstream_timeout");
    expect(j.error.type).toBe("server_error");
    expect(j.error.message).toMatch(/timed out/i);

    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const log = lastLog("deg-timeout");
    expect(log?.outcome).toBe("upstream_timeout");
    expect(log?.status).toBe(504);
    expect(log?.errorClass).toBe("upstream_timeout");
  });

  it("L2: streaming request with no upstream body charges 0 credits (billing invariant C2)", async () => {
    // L2: when the upstream returns a 200 with body:null (e.g. a 204 No Content), the old code
    // returned totalTokens:effectiveMax, effectively billing a full request even though NO
    // completion was produced. The fix returns ZERO_RESULT so credits stay 0.
    mockMode = "no-body";
    const k = mintKey({ alias: "deg-nobody", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    // stream:true triggers the streaming path in the gateway.
    const res = await chat(gatewayPort, k.plaintextKey, { stream: true });
    // The gateway writes back whatever status the upstream sent (204 in this mode).
    expect(res.status).toBeLessThan(300);

    // C2: no body → no completion → 0 credits charged.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("mid-stream abort → client gets a terminal error frame + [DONE], outcome stream_failed, no crash", async () => {
    mockMode = "sse-abort";
    const k = mintKey({ alias: "deg-stream", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);

    const res = await chat(gatewayPort, k.plaintextKey, { stream: true });
    // Headers were sent as 200 (SSE already began) — the status CANNOT change mid-stream.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    // The first content chunk was forwarded …
    expect(text).toContain('"par"');
    // … then a TERMINAL error frame signals truncation, NOT a clean finish.
    expect(text).toContain('"code":"upstream_error"');
    expect(text).toMatch(/"type":"server_error"/);
    expect(text).toContain("[DONE]");

    // The outcome is recorded as a stream failure (best-effort; the gateway did not crash —
    // proven by the next request succeeding).
    const log = lastLog("deg-stream");
    expect(log?.outcome).toBe("stream_failed");

    // M-c: billing invariant C2 — a truncated stream is not a successful completion → 0 credits.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    // The gateway is still alive and serving after a mid-stream abort.
    mockMode = "ok";
    const after = await chat(gatewayPort, mintKey({ alias: "deg-after", tier: "guest" }, DEFAULTS).plaintextKey, {});
    expect(after.status).toBe(200);
  });

  it("M-b: non-streaming upstream body-reset after headers → 502 upstream_unavailable, creditsUsed===0", async () => {
    // M-b: the upstream sends complete HTTP 200 headers then destroys the socket before the
    // response body. fetch() resolves with status 200, but upstream.text() throws a TypeError
    // (UND_ERR_SOCKET). Before the fix the catch block was outside the upstream.text() call, so
    // the TypeError bubbled to the top-level handler as a generic 500. The fix wraps the body
    // read in the same guard so it is classified via classifyUpstreamError → upstream_unavailable
    // → 502, and C2 is preserved (ZERO_RESULT → 0 credits).
    // Uses a dedicated bodyResetGatewayPort whose upstream is a raw net server (not the shared
    // mockMode mock-HTTP server) because we need complete HTTP headers before socket destroy.
    const k = mintKey({ alias: "deg-body-reset", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(bodyResetGatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("upstream_unavailable");
    expect(j.error.type).toBe("server_error");

    // C2: a mid-body connection reset is not a successful completion → 0 credits.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const log = lastLog("deg-body-reset");
    expect(log?.outcome).toBe("upstream_unavailable");
    expect(log?.status).toBe(502);
    expect(log?.errorClass).toBe("upstream_unavailable");
  });

  it("M-d: mid-stream abort with OWNER key → records stream_failed without crash, bills 0", async () => {
    // M-d: the owner-recording branch in the streamFailed path
    // (recordOwnerChat(...,'stream_failed') when assembled!==null) requires an owner key.
    // The guest key test (above) leaves the assembled===null path; this covers assembled!==null.
    mockMode = "sse-abort";
    // owner tier + creditLimit so the gateway activates the ownerLog path.
    const k = mintKey({ alias: "deg-stream-owner", tier: "owner", creditLimit: 1_000_000 }, DEFAULTS);

    const res = await chat(gatewayPort, k.plaintextKey, { stream: true });
    expect(res.status).toBe(200);

    const text = await res.text();
    // Terminal error frame was written (owner path did not crash before it).
    expect(text).toContain('"code":"upstream_error"');
    expect(text).toContain("[DONE]");

    // Outcome recorded correctly.
    const log = lastLog("deg-stream-owner");
    expect(log?.outcome).toBe("stream_failed");

    // C2: owner keys are not exempt — a truncated stream is not billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("M-e: clean streaming completion → client receives full SSE body, happy-path billing (real tokens)", async () => {
    // M-e: after the pipe-finalization refactor (pipe(res,{end:false}) + manual res.end() +
    // streamFailed try/catch), a normal successful stream must: (a) deliver all SSE frames to the
    // client, (b) end cleanly with [DONE], (c) bill real tokens from the usage frame (not 0 and
    // not effectiveMax), and (d) record outcome "ok".
    mockMode = "sse-complete";
    const k = mintKey({ alias: "deg-stream-ok", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);

    const res = await chat(gatewayPort, k.plaintextKey, { stream: true });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    // Both content deltas forwarded.
    expect(body).toContain('"hello"');
    expect(body).toContain('" world"');
    // Stream ended cleanly with [DONE].
    expect(body).toContain("[DONE]");
    // No truncation error frame was injected.
    expect(body).not.toContain('"upstream_error"');

    // Outcome logged as ok.
    const log = lastLog("deg-stream-ok");
    expect(log?.outcome).toBe("ok");

    // Happy-path billing: real tokens from the usage frame (total_tokens=5), NOT 0 and NOT
    // effectiveMax (256 — HOMESERVER_PER_REQUEST_MAX_TOKENS). creditsUsed reflects real usage.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(5);
  });

  // ─── #23: non-404 upstream error bodies are NOT forwarded verbatim ───────────────────
  it("#23 non-streaming: upstream 500 leaky body → 502 upstream_unavailable, body sanitized, 0 credits", async () => {
    mockMode = "error-leak";
    const k = mintKey({ alias: "leak-nostream", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(gatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(UPSTREAM_LEAK_MARKER);
    const j = JSON.parse(bodyText) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("upstream_unavailable");
    expect(j.error.type).toBe("server_error");
    // Billing invariant: an upstream error is never charged.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    expect(lastLog("leak-nostream")?.status).toBe(502);
  });

  it("#23 streaming: upstream 500 leaky body → 502 upstream_unavailable, body sanitized", async () => {
    mockMode = "error-leak";
    const k = mintKey({ alias: "leak-stream", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(gatewayPort, k.plaintextKey, { stream: true });
    expect(res.status).toBe(502);
    const bodyText = await res.text();
    expect(bodyText).not.toContain(UPSTREAM_LEAK_MARKER);
    const j = JSON.parse(bodyText) as { error: { code: string } };
    expect(j.error.code).toBe("upstream_unavailable");
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  // ─── Codex finding 1: a 2xx body containing "model not found" must NOT be 400'd ──────
  it("a 200 completion whose content says 'model not found' is forwarded, not 400'd", async () => {
    mockMode = "ok-phrase";
    const k = mintKey({ alias: "okphrase", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const res = await chat(gatewayPort, k.plaintextKey, {});
    expect(res.status).toBe(200);
    const j = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(j.choices[0]!.message.content).toContain("model not found");
    // A successful completion IS billed (this is not an error).
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(14);
  });

  // ─── #15: every error path returns the OpenAI-shaped envelope ────────────────────────
  it("#15 invalid JSON body → 400 invalid_request_error envelope (not a 500)", async () => {
    const k = mintKey({ alias: "badjson", tier: "guest" }, DEFAULTS);
    const res = await fetch(url(gatewayPort, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: "{ this is not json",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("#15 (Codex finding 2) oversized body → 413 payload_too_large envelope is actually delivered", async () => {
    // The /portal/feedback route caps the body at 16 KB. An over-cap body must yield a real 413
    // envelope — not a connection reset (the old readBody req.destroy() raced the response write).
    const big = "x".repeat(20 * 1024);
    const res = await fetch(url(gatewayPort, "/portal/feedback"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: big }),
    });
    expect(res.status).toBe(413);
    const j = (await res.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("payload_too_large");
    expect(j.error.type).toBe("invalid_request_error");
  });

  it("#15 unknown route → 404 not_found envelope (not a bare { error } body)", async () => {
    const k = mintKey({ alias: "noroute", tier: "guest" }, DEFAULTS);
    const res = await fetch(url(gatewayPort, "/no/such/path"), {
      method: "GET",
      headers: { authorization: `Bearer ${k.plaintextKey}` },
    });
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: { code: string; type: string; message: string } };
    expect(j.error.code).toBe("not_found");
    expect(j.error.type).toBe("invalid_request_error");
    expect(typeof j.error.message).toBe("string");
  });

  // ─── #14: /delegate validates modelId / frontierModelId / verifier and envelopes errors ──
  async function delegateReq(token: string, body: Record<string, unknown>): Promise<Response> {
    return fetch(url(gatewayPort, "/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  it("#14 /delegate missing prompt → 400 invalid_request_error param=prompt", async () => {
    const k = mintKey({ alias: "del-noprompt", tier: "owner" }, DEFAULTS);
    const res = await delegateReq(k.plaintextKey, {});
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("prompt");
  });

  it("#14 /delegate non-string modelId → 400 param=modelId", async () => {
    const k = mintKey({ alias: "del-badmodel", tier: "owner" }, DEFAULTS);
    const res = await delegateReq(k.plaintextKey, { prompt: "hi", modelId: 123 });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { param: string } };
    expect(j.error.param).toBe("modelId");
  });

  it("#14 /delegate invalid verifier spec → 400 param=verifier", async () => {
    const k = mintKey({ alias: "del-badverifier", tier: "owner" }, DEFAULTS);
    // answerIs requires a string 'expected' — omitting it is a build error → 400.
    const res = await delegateReq(k.plaintextKey, { prompt: "hi", verifier: { type: "answerIs" } });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("verifier");
  });

  it("#14 /delegate stays owner-only (guest key → 403 route_not_allowed)", async () => {
    const k = mintKey({ alias: "del-guest", tier: "guest" }, DEFAULTS);
    const res = await delegateReq(k.plaintextKey, { prompt: "hi" });
    expect(res.status).toBe(403);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("route_not_allowed");
  });

  it("#14 /delegate malformed JSON → 400 bad_request (validated before admission)", async () => {
    const k = mintKey({ alias: "del-badjson", tier: "owner" }, DEFAULTS);
    const res = await fetch(url(gatewayPort, "/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(lastLog("del-badjson")?.outcome).toBe("bad_request");
  });

  it("#14 (Codex finding 3) a bad /delegate body 400s even when the key is credit-exhausted", async () => {
    // creditLimit:1 means any real request 402s at the credit reserve (estTokens > 1). With
    // validation moved BEFORE admission, a missing-prompt request must still return 400 — not 402.
    const k = mintKey({ alias: "del-broke", tier: "owner", creditLimit: 1 }, DEFAULTS);
    const res = await delegateReq(k.plaintextKey, { taskType: "summarize" }); // no prompt
    expect(res.status).toBe(400);
    const j = (await res.json()) as { error: { code: string; param: string } };
    expect(j.error.code).toBe("invalid_request_error");
    expect(j.error.param).toBe("prompt");
  });

  // ─── #22: client disconnect mid-stream is billed 0 + cancels the upstream generation ──
  it("#22 client disconnect mid-stream → billed 0, outcome client_closed, upstream cancelled", async () => {
    mockMode = "sse-slow";
    const k = mintKey({ alias: "client-close", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const ac = new AbortController();
    const res = await fetch(url(gatewayPort, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: ac.signal,
    });
    expect(res.status).toBe(200);
    // Read the first SSE chunk, THEN disconnect mid-stream (the upstream keeps sending for ~1s).
    const reader = res.body!.getReader();
    await reader.read();
    ac.abort();
    try {
      await reader.read();
    } catch {
      /* expected — the client aborted */
    }
    // Give the gateway a beat to observe res 'close', abort the upstream, and record the log row.
    await new Promise((r) => setTimeout(r, 250));

    // Billing invariant (#22): a response the client never fully received is NOT billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
    // Distinct outcome (not stream_failed, not a backend timeout).
    expect(lastLog("client-close")?.outcome).toBe("client_closed");
    // The upstream generation was cancelled (its socket closed before it finished its 40 chunks),
    // rather than left running to completion and wasting the GPU.
    expect(sseSlowInterrupted).toBe(true);
  });
});

describe("R6 graceful degradation — MCP runChatCompletion upstream failures", () => {
  // The MCP `ask` path runs through runChatCompletion, NOT the HTTP spine. It must map an
  // upstream connection/timeout failure to a structured { ok:false, code:"upstream_error" }
  // result (so the tool reports a clean tool-error, not an unhandled throw → gateway 500) and
  // STILL reconcile credits to 0 (C2). We exercise it directly with a config pointing at the
  // dead port (every fetch → ECONNREFUSED).
  const noopInflight = { inc: () => {}, dec: () => {}, current: () => 0 };

  function makePrincipal(rec: ReturnType<typeof lookupKey>) {
    return {
      alias: rec!.alias,
      tier: rec!.tier,
      modelAllowList: rec!.modelAllowList,
      limits: { rpm: rec!.rpm, tpm: rec!.tpm, dailyTokenBudget: rec!.dailyTokenBudget },
      maxParallel: rec!.maxParallel,
      keyHash: rec!.keyHash,
      creditLimit: rec!.creditLimit,
    };
  }

  it("connection refused → ok:false upstream_error, credits reconciled to 0", async () => {
    const k = mintKey({ alias: "mcp-deg-refused", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;
    expect(rec.creditsUsed).toBe(0);

    const cfg = { ...loadConfig(), lmStudioBaseUrl: `http://127.0.0.1:${deadPort}/v1` };
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
    const principal = makePrincipal(rec);

    const r = await runChatCompletion(principal, cfg, controller, noopInflight, {
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("upstream_error");
    // C2: a failed upstream call is never billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("M2: connection refused → request_log row records outcome=upstream_unavailable / status=502 / 0 credits (M2 fix)", async () => {
    // M2: the MCP path's finally block must thread the classified kind through to the request_log
    // row so the distinct outcome/status labels are preserved (mirrors the HTTP path).
    const k = mintKey({ alias: "mcp-deg-refused-log", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;

    const cfg = { ...loadConfig(), lmStudioBaseUrl: `http://127.0.0.1:${deadPort}/v1`, requestLog: "on" as const };
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
    const principal = makePrincipal(rec);

    await runChatCompletion(principal, cfg, controller, noopInflight, {
      model: "m1",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 16,
    });

    // The request_log row must carry the distinct upstream_unavailable label — not the generic "error".
    const log = getRequestLog(200).find((r) => r.alias === "mcp-deg-refused-log");
    expect(log).toBeDefined();
    expect(log?.outcome).toBe("upstream_unavailable");
    expect(log?.status).toBe(502);
    // C2: a failed call is never billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });

  it("M2: timeout → request_log row records outcome=upstream_timeout / status=504 / 0 credits (M2 fix)", async () => {
    // M2: a timeout classified as upstream_timeout must also produce a distinct 504 row in request_log.
    // We spin up an inline hang server (never responds) and use a 200ms callTimeoutMs so the
    // AbortSignal.timeout fires reliably → TimeoutError → upstream_timeout.
    const hangServer = createServer(() => { /* never respond */ });
    const hangPort = await new Promise<number>((resolve) =>
      hangServer.listen(0, "127.0.0.1", () => resolve((hangServer.address() as { port: number }).port))
    );

    const k = mintKey({ alias: "mcp-deg-timeout-log", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const rec = lookupKey(k.plaintextKey)!;

    const cfg = { ...loadConfig(), lmStudioBaseUrl: `http://127.0.0.1:${hangPort}/v1`, callTimeoutMs: 200, requestLog: "on" as const };
    const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
    const principal = makePrincipal(rec);

    try {
      await runChatCompletion(principal, cfg, controller, noopInflight, {
        model: "m1",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
      });
    } finally {
      await new Promise<void>((r) => hangServer.close(() => r()));
    }

    const log = getRequestLog(200).find((r) => r.alias === "mcp-deg-timeout-log");
    expect(log).toBeDefined();
    expect(log?.outcome).toBe("upstream_timeout");
    expect(log?.status).toBe(504);
    // C2: a failed call is never billed.
    expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
  });
});
