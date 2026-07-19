import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * Integration test for the recurrent poison-clear wiring in the gateway.
 *
 * Proves end-to-end that an ABRUPT mid-stream client disconnect on a request to an allow-listed
 * recurrent model makes the gateway fire a fire-and-forget unload of THAT model (so the next
 * request loads a clean one), and that a disconnect on a NON-recurrent model does not. Uses the
 * llama-swap backend pointed at a single mock that answers both the slow SSE chat stream and the
 * llama-swap unload endpoint (POST /api/models/unload/:id), recording which ids were unloaded.
 *
 * See docs/m5-qwen3next-recurrent-degeneration-2026-06-24.md and the #22 disconnect test in
 * homeserver-gateway-degradation.test.ts (whence the mid-stream disconnect technique).
 */

let mock: Server;
let mockPort = 0;
// Records each model id the gateway asked us to unload (POST /api/models/unload/:id).
let unloadedIds: string[] = [];
// Records which chat behaviour branch the mock served (by sentinel) — lets a test PROVE it actually
// reached the intended gateway abort site (e.g. the non-streaming body-read path) and not another.
let mockServed: string[] = [];

function startMock(): Promise<void> {
  mock = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = req.url ?? "";
    // llama-swap unload endpoint — record the id and 200 OK.
    if (req.method === "POST" && u.startsWith("/api/models/unload/")) {
      const id = decodeURIComponent(u.slice("/api/models/unload/".length));
      unloadedIds.push(id);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("OK");
      return;
    }
    // Chat. Behaviour is selected by an exact sentinel in the (forwarded) first user message so a
    // single mock can drive each of the gateway's three abrupt-disconnect sites + the negative case.
    // Sentinels are matched by EXACT equality (not substring) so none can shadow another:
    //   "FETCH_HANG" → never respond (site 1: client aborts during the gateway's initial fetch)
    //   "BODY_HANG"  → send headers, withhold the body (site 3: abort during upstream.text())
    //   "TRUNCATE"   → one SSE chunk then destroy the socket (UPSTREAM truncation, NOT a client
    //                  disconnect → streamFailed && !clientAborted → must NOT poison-clear)
    //   anything else → slow SSE stream, a chunk every 25ms (site 2: abort mid-stream)
    if (req.method === "POST" && u.includes("/chat/completions")) {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        let content = "";
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            messages?: Array<{ content?: string }>;
          };
          content = String(body.messages?.[0]?.content ?? "");
        } catch {
          /* default behaviour */
        }
        mockServed.push(content);
        if (content === "FETCH_HANG") {
          return; // never respond
        }
        if (content === "BODY_HANG") {
          // Promise the gateway 100 bytes of body, then never send them → upstream.text() blocks.
          res.writeHead(200, { "content-type": "application/json", "content-length": "100" });
          return;
        }
        if (content === "TRUNCATE") {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"id":"t","choices":[{"delta":{"content":"partial"}}]}\n\n');
          setTimeout(() => req.socket.destroy(), 20);
          return;
        }
        if (content === "DEGENERATE") {
          // The SILENT case (Fix #2): a long single-token "?????" run, then a CLEAN finish — no
          // disconnect at all. The gateway's degeneracy watchdog (recurrent models only) must trip
          // mid-run, abort, emit a terminal retry frame, and force a poison-clear unload.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: {"id":"d","choices":[{"delta":{"content":"${"?".repeat(60)}"}}]}\n\n`);
          setTimeout(() => {
            if (res.writableEnded || res.destroyed) return; // gateway aborted us → stop
            res.write(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":60,"total_tokens":63}}\n\n'
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }, 30);
          return;
        }
        if (content === "DEGENERATE_SMALL") {
          // A SUB-threshold run (30 '?' < threshold 50) on the recurrent model: must NOT trip the
          // watchdog — the full content reaches the client, no unload, a clean finish.
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: {"id":"ds","choices":[{"delta":{"content":"${"?".repeat(30)}"}}]}\n\n`);
          setTimeout(() => {
            if (res.writableEnded || res.destroyed) return;
            res.write(
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":30,"total_tokens":33}}\n\n'
            );
            res.write("data: [DONE]\n\n");
            res.end();
          }, 30);
          return;
        }
        if (content === "DEGENERATE_NONSTREAM") {
          // The non-streaming arm of Fix #2: a 2xx JSON completion whose message.content is a
          // degenerate "?????" run. The body is already sent, but the gateway must still bill 0 and
          // force a poison-clear unload.
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "dn",
              choices: [{ message: { role: "assistant", content: "?".repeat(60) }, finish_reason: "stop" }],
              usage: { prompt_tokens: 3, completion_tokens: 60, total_tokens: 63 },
            })
          );
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        let i = 0;
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
          }
        }, 25);
      });
      return;
    }
    // Anything else (e.g. catalogue probes) — empty 200.
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [] }));
  });
  return new Promise((resolve) =>
    mock.listen(0, "127.0.0.1", () => {
      mockPort = (mock.address() as { port: number }).port;
      resolve();
    })
  );
}

let startGateway: typeof import("../src/homeserver/gateway.js").startGateway;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;
let resetPoisonClearState: typeof import("../src/homeserver/poison-clear.js").resetPoisonClearState;
let renderMetrics: typeof import("../src/homeserver/metrics.js").renderMetrics;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-poison-test-"));
  initDb(join(dir, "test.db"));
  await startMock();

  const origin = `http://127.0.0.1:${mockPort}`;
  process.env["LMSTUDIO_BASE_URL"] = `${origin}/v1`;
  process.env["LLAMASWAP_BASE_URL"] = origin;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_CALL_TIMEOUT_MS"] = "5000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";
  // The model under test ("m1") is the recurrent one; "mellum" is NOT in the list → never unloaded.
  process.env["HOMESERVER_RECURRENT_MODEL_IDS"] = "m1";
  process.env["HOMESERVER_POISON_CLEAR_COOLDOWN_MS"] = "100";
  // Low watchdog threshold so a small mock payload (60 '?') reproduces the degenerate run.
  process.env["HOMESERVER_DEGENERACY_RUN_THRESHOLD"] = "50";

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const q = await import("../src/homeserver/quota.js");
  const pc = await import("../src/homeserver/poison-clear.js");
  const m = await import("../src/homeserver/metrics.js");
  startGateway = gw.startGateway;
  mintKey = ks.mintKey;
  resetQuotaWindows = q.resetQuotaWindows;
  resetPoisonClearState = pc.resetPoisonClearState;
  renderMetrics = m.renderMetrics;

  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => mock.close(() => r()));
});

beforeEach(() => {
  unloadedIds = [];
  mockServed = [];
  resetQuotaWindows();
  resetPoisonClearState();
});

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

/** Open a streaming chat, read the first SSE chunk, then abort mid-stream and wait for cleanup. */
async function disconnectMidStream(token: string, model: string): Promise<void> {
  const ac = new AbortController();
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "hi" }] }),
    signal: ac.signal,
  });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  await reader.read(); // first chunk
  ac.abort();
  try {
    await reader.read();
  } catch {
    /* expected — client aborted */
  }
  // Give the gateway a beat to observe res 'close', abort the upstream, and fire the unload.
  await new Promise((r) => setTimeout(r, 350));
}

describe("gateway recurrent poison-clear on abrupt disconnect", () => {
  it("unloads the recurrent model after an abrupt mid-stream disconnect", async () => {
    const k = mintKey({ alias: "pc-recurrent", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    await disconnectMidStream(k.plaintextKey, "m1");
    expect(unloadedIds).toContain("m1");
  });

  it("does NOT unload a non-recurrent model on the same kind of disconnect", async () => {
    const k = mintKey({ alias: "pc-fullattn", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    await disconnectMidStream(k.plaintextKey, "mellum");
    expect(unloadedIds).toHaveLength(0);
  });

  it("unloads the recurrent model on an abrupt disconnect during the INITIAL upstream fetch (site 1)", async () => {
    const k = mintKey({ alias: "pc-site1", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      // "FETCH_HANG" → the mock never responds, so the gateway is still awaiting its initial upstream
      // fetch() when the client aborts → site 1 (the catch around the initial fetch).
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "FETCH_HANG" }] }),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    expect(mockServed).toContain("FETCH_HANG"); // the request reached the no-response branch
    expect(unloadedIds).toContain("m1");
  });

  it("unloads the recurrent model on an abrupt disconnect during a NON-STREAMING body read (site 3)", async () => {
    const k = mintKey({ alias: "pc-site3", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      // stream:false + "BODY_HANG" → headers arrive (fetch resolves) but the body never does, so the
      // gateway is blocked in `await upstream.text()` when the client aborts → site 3. The exact-match
      // sentinel (not a substring of FETCH_HANG) guarantees the mock takes the headers-then-withhold
      // branch — the mockServed assertion below proves this test genuinely exercises site 3, not site 1.
      body: JSON.stringify({ model: "m1", stream: false, messages: [{ role: "user", content: "BODY_HANG" }] }),
      signal: ac.signal,
    });
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    await p.catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
    expect(mockServed).toContain("BODY_HANG"); // proves the non-streaming body-read branch was hit (site 3)
    expect(unloadedIds).toContain("m1");
  });

  it("does NOT poison-clear on an UPSTREAM truncation that is not a client disconnect", async () => {
    // The critical negative case: streamFailed && !clientAborted. The client never disconnects; the
    // UPSTREAM destroys the socket mid-stream. The gateway emits a terminal error frame but must
    // leave the (recurrent) model loaded — unloading on every upstream blip would be wrong.
    const k = mintKey({ alias: "pc-truncate", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "TRUNCATE" }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("upstream_error"); // terminal truncation frame proves streamFailed fired
    await new Promise((r) => setTimeout(r, 200));
    expect(unloadedIds).toHaveLength(0);
  });

  it("forces a poison-clear when the watchdog detects a degenerate single-token run (silent backstop, Fix #2)", async () => {
    // The silent case: NO client disconnect — the upstream itself returns a "?????" run on a
    // recurrent model (a dirty buffer seeded by an earlier disconnect). The watchdog must trip,
    // abort the stream with a terminal retry frame, and unload so the NEXT request loads clean.
    const k = mintKey({ alias: "pc-degenerate", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "DEGENERATE" }] }),
    });
    expect(res.status).toBe(200); // headers already on the wire — cannot become a 5xx
    const text = await res.text();
    expect(text).toContain("upstream_error"); // terminal "degenerate response — please retry" frame
    expect(mockServed).toContain("DEGENERATE");
    await new Promise((r) => setTimeout(r, 200));
    expect(unloadedIds).toContain("m1");
    // The new counter incremented AND the request was classified "degenerate" (the handler-owned
    // outcome that the spine must preserve) — proves the metric/outcome wiring, not just the unload.
    const metrics = renderMetrics();
    expect(metrics).toContain("homeserver_degeneracy_detected_total");
    expect(metrics).toContain('outcome="degenerate"');
  });

  it("does NOT trip the watchdog on a SUB-threshold run from a recurrent model (no over-eager unload)", async () => {
    const k = mintKey({ alias: "pc-degenerate-small", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "m1", stream: true, messages: [{ role: "user", content: "DEGENERATE_SMALL" }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("?".repeat(30)); // the full sub-threshold run reached the client
    expect(text).toContain("[DONE]"); // a clean finish, not a terminal error frame
    expect(text).not.toContain("upstream_error");
    await new Promise((r) => setTimeout(r, 200));
    expect(unloadedIds).toHaveLength(0); // below threshold → no unload
  });

  it("forces a poison-clear on a NON-streaming degenerate completion (non-streaming arm of Fix #2)", async () => {
    const k = mintKey({ alias: "pc-degenerate-ns", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "m1", stream: false, messages: [{ role: "user", content: "DEGENERATE_NONSTREAM" }] }),
    });
    expect(res.status).toBe(200); // body already sent — cannot become a 5xx
    expect(mockServed).toContain("DEGENERATE_NONSTREAM");
    await new Promise((r) => setTimeout(r, 200));
    expect(unloadedIds).toContain("m1"); // self-healed despite no disconnect
  });

  it("does NOT run the watchdog for a NON-recurrent model — a degenerate-looking run streams through", async () => {
    // mellum is full-attention (immune) → never in the allow-list → no watchdog. Even an identical
    // long single-char run must stream through cleanly and never trigger an unload.
    const k = mintKey({ alias: "pc-degenerate-fullattn", tier: "guest", modelAllowList: ["m1", "mellum"] }, DEFAULTS);
    const res = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${k.plaintextKey}` },
      body: JSON.stringify({ model: "mellum", stream: true, messages: [{ role: "user", content: "DEGENERATE" }] }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("?".repeat(60)); // the content reached the client unaborted
    expect(text).toContain("[DONE]"); // a clean finish, not a terminal error frame
    expect(text).not.toContain("upstream_error");
    await new Promise((r) => setTimeout(r, 200));
    expect(unloadedIds).toHaveLength(0);
    // ...and it was BILLED as a normal completion (the doc's "streams through untouched and bills
    // it"): mellum has a non-zero completion-token counter.
    const metrics = renderMetrics();
    // Labels render in sorted key order (direction, model).
    expect(metrics).toMatch(/homeserver_tokens_total\{direction="completion",model="mellum"\} [1-9]/);
  });

  // The per-model cooldown that collapses a burst of disconnects into a single unload (the
  // gateway-wedge remedy) is covered deterministically in homeserver-poison-clear.test.ts — it is
  // pure logic and does not need a flaky concurrent HTTP test (admission/maxParallel limits would
  // confound it here anyway).
});
