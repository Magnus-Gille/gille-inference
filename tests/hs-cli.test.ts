/**
 * Tests for client/hs.mjs — the friend-facing home-server CLI.
 *
 * Spins a lightweight mock HTTP server (node:http) for each test group,
 * injects a temp config dir, and uses the injectable `fetch` and `configDir`
 * parameters to keep the tests hermetic (no real network, no ~/.config/hs writes).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Import the CLI module under test ─────────────────────────────────────────
// Vitest/Vite resolves .mjs directly; the ?module suffix avoids caching issues.
import {
  redeem,
  listModels,
  ask,
  usage,
  loadConfig,
  saveConfig,
} from "../client/hs.mjs";

// ── Mock server helpers ───────────────────────────────────────────────────────

/** A tiny in-memory SSE payload for the ask tests. */
const SSE_HELLO_WORLD =
  'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
  "data: [DONE]\n\n";

/** Build a fetch() shim that talks to the given port on 127.0.0.1. */
function makeFetch(port: number): typeof globalThis.fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    // Replace any host in the URL with our mock server
    const rewritten = url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${port}`);
    return globalThis.fetch(rewritten, init);
  };
}

/**
 * Start a mock HTTP server handling the main API surface:
 *  POST /portal/redeem  → 200 with key/models/tier
 *  GET  /v1/models      → OpenAI-shaped models list
 *  POST /v1/chat/completions → SSE stream "Hello world"
 *  GET  /portal/me      → usage info
 *
 * Pass `variant: "credits_exhausted"` to make /v1/chat/completions return 402.
 * Pass `variant: "stream_error"` to begin a stream then emit a terminal upstream_error frame.
 * Pass `variant: "upstream_timeout"` to return a 504 with a Retry-After header.
 */
function startMockServer(
  variant?: "credits_exhausted" | "stream_error" | "upstream_timeout" | "upstream_unavailable"
): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const { method, url } = req;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        // ── POST /portal/redeem ──────────────────────────────────────────────
        if (method === "POST" && url === "/portal/redeem") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              key: "hs_test123456789",
              alias: "test-guest",
              tier: "guest",
              models: ["test-model"],
              creditLimit: 50000,
            })
          );
          return;
        }

        // ── GET /v1/models ───────────────────────────────────────────────────
        if (method === "GET" && url === "/v1/models") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: [{ id: "test-model" }] }));
          return;
        }

        // ── POST /v1/chat/completions ─────────────────────────────────────────
        if (method === "POST" && url === "/v1/chat/completions") {
          if (variant === "credits_exhausted") {
            res.writeHead(402, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "Your credit balance is exhausted.",
                  type: "insufficient_quota",
                  code: "credits_exhausted",
                },
              })
            );
            return;
          }
          if (variant === "upstream_timeout") {
            res.writeHead(504, { "content-type": "application/json", "retry-after": "5" });
            res.end(
              JSON.stringify({
                error: {
                  message:
                    "The model backend timed out (it may be loading a model) — please retry in a few seconds.",
                  type: "server_error",
                  code: "upstream_timeout",
                },
              })
            );
            return;
          }
          if (variant === "upstream_unavailable") {
            // 502 with NO Retry-After header — the L1 bug rendered "(retry in undefineds)"
            // when retryAfter was absent. The fix guards it so no suffix appears.
            res.writeHead(502, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  message: "The model backend is unavailable — please retry shortly.",
                  type: "server_error",
                  code: "upstream_unavailable",
                },
              })
            );
            return;
          }
          if (variant === "stream_error") {
            // Begin a valid stream, forward one content chunk, then a TERMINAL error frame
            // (mid-stream truncation) followed by [DONE] — exactly what the gateway emits.
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            res.write('data: {"choices":[{"delta":{"content":"par"}}]}\n\n');
            res.write(
              'data: {"error":{"message":"The model backend stream ended unexpectedly — the response was truncated. Please retry.","type":"server_error","code":"upstream_error"}}\n\n'
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          res.end(SSE_HELLO_WORLD);
          return;
        }

        // ── GET /portal/me ───────────────────────────────────────────────────
        if (method === "GET" && url === "/portal/me") {
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(
            JSON.stringify({
              tier: "guest",
              models: ["test-model"],
              creditsUsed: 100,
              creditLimit: 1000,
              rpm: 10,
              tpm: 50000,
            })
          );
          return;
        }

        // ── Fallback ─────────────────────────────────────────────────────────
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "not found", code: "not_found" } }));
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        port: addr.port,
        stop: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

// ── Test groups ───────────────────────────────────────────────────────────────

describe("hs-cli — redeem", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer());
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
  });

  afterAll(async () => { await stop(); });

  it("redeem stores the key in config", async () => {
    const result = await redeem({
      code: "inv_testcode",
      baseUrl: `http://127.0.0.1:${port}`,
      configDir,
      fetch: makeFetch(port),
    });

    expect(result.key).toBe("hs_test123456789");
    expect(result.tier).toBe("guest");
    expect(result.models).toEqual(["test-model"]);

    // Verify the key was persisted to disk
    const stored = loadConfig(configDir);
    expect(stored).not.toBeNull();
    expect(stored!.key).toBe("hs_test123456789");
    expect(stored!.baseUrl).toBe(`http://127.0.0.1:${port}`);
  });
});

describe("hs-cli — listModels", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer());
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    // Pre-seed config so listModels doesn't need redeem
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("listModels returns model ids", async () => {
    const ids = await listModels({ configDir, fetch: makeFetch(port) });
    expect(ids).toEqual(["test-model"]);
  });
});

describe("hs-cli — ask (streaming)", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer());
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("ask streams concatenated content 'Hello world'", async () => {
    const tokens: string[] = [];
    // Inject a no-op WriteStream-like sink to capture tokens
    const out = { write: (s: string) => { tokens.push(s); } };

    const result = await ask({
      prompt: "say hello",
      model: "test-model",
      configDir,
      fetch: makeFetch(port),
      out: out as any,
    });

    // The return value is the concatenated content (without the trailing newline from out.write)
    expect(result).toBe("Hello world");
    // Tokens should have been written incrementally
    expect(tokens.join("")).toContain("Hello");
    expect(tokens.join("")).toContain("world");
  });

  it("ask auto-selects first model when none specified", async () => {
    const out = { write: (_s: string) => {} };
    const result = await ask({
      prompt: "test",
      configDir,
      fetch: makeFetch(port),
      out: out as any,
    });
    expect(result).toBe("Hello world");
  });

  it("ask forwards explicit sampler and max-token controls", async () => {
    let sent: Record<string, unknown> | null = null;
    const baseFetch = makeFetch(port);
    const captureFetch: typeof globalThis.fetch = (input, init) => {
      if (init?.body && typeof init.body === "string") sent = JSON.parse(init.body) as Record<string, unknown>;
      return baseFetch(input, init);
    };
    await ask({
      prompt: "solve",
      model: "vibethinker-3b",
      maxTokens: 20_000,
      temperature: 1,
      topP: 0.95,
      topK: 0,
      minP: 0,
      configDir,
      fetch: captureFetch,
      out: { write: () => {} },
    });
    expect(sent).toMatchObject({
      model: "vibethinker-3b",
      max_tokens: 20_000,
      temperature: 1,
      top_p: 0.95,
      top_k: 0,
      min_p: 0,
    });
  });
});

describe("hs-cli — usage", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer());
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("usage returns credits info", async () => {
    const info = await usage({ configDir, fetch: makeFetch(port) });
    expect(info.tier).toBe("guest");
    expect(info.models).toEqual(["test-model"]);
    expect(info.creditsUsed).toBe(100);
    expect(info.creditLimit).toBe(1000);
  });
});

describe("hs-cli — 402 credits_exhausted", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer("credits_exhausted"));
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("ask surfaces 402 error with credits message", async () => {
    const out = { write: (_s: string) => {} };
    await expect(
      ask({
        prompt: "hello",
        model: "test-model",
        configDir,
        fetch: makeFetch(port),
        out: out as any,
      })
    ).rejects.toMatchObject({
      httpStatus: 402,
      message: expect.stringContaining("credit"),
    });
  });
});

describe("hs-cli — mid-stream upstream_error frame (R6)", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer("stream_error"));
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("ask forwards streamed tokens then THROWS a clear truncation error on a terminal error frame", async () => {
    const tokens: string[] = [];
    const out = { write: (s: string) => { tokens.push(s); } };
    await expect(
      ask({ prompt: "hello", model: "test-model", configDir, fetch: makeFetch(port), out: out as any })
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringMatching(/truncated|unexpectedly/i),
    });
    // The partial content that DID arrive was still streamed to the user before the error.
    expect(tokens.join("")).toContain("par");
  });
});

describe("hs-cli — 504 upstream_timeout with Retry-After (R6)", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer("upstream_timeout"));
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("ask surfaces a 504 upstream_timeout error carrying the Retry-After hint", async () => {
    const out = { write: (_s: string) => {} };
    await expect(
      ask({ prompt: "hello", model: "test-model", configDir, fetch: makeFetch(port), out: out as any })
    ).rejects.toMatchObject({
      httpStatus: 504,
      code: "upstream_timeout",
      retryAfter: "5",
    });
  });
});

describe("hs-cli — 502 upstream_unavailable with NO Retry-After (L1)", () => {
  let port = 0;
  let stop: () => Promise<void>;
  let configDir: string;

  beforeAll(async () => {
    ({ port, stop } = await startMockServer("upstream_unavailable"));
    configDir = mkdtempSync(join(tmpdir(), "hs-test-"));
    saveConfig({ baseUrl: `http://127.0.0.1:${port}`, key: "hs_test123456789" }, configDir);
  });

  afterAll(async () => { await stop(); });

  it("502 with no Retry-After header renders no 'retry in' suffix (L1 fix)", async () => {
    // L1: the 502 branch previously appended "(retry in ${err.retryAfter}s)" unconditionally,
    // producing "(retry in undefineds)" when retryAfter was absent. The fix guards it with
    // err.retryAfter ? ... so no suffix appears when the header is missing.
    const out = { write: (_s: string) => {} };
    const thrownErr = await ask({
      prompt: "hello",
      model: "test-model",
      configDir,
      fetch: makeFetch(port),
      out: out as any,
    }).catch((e: unknown) => e);

    // The error should be thrown (it's a 502)
    expect(thrownErr).toBeInstanceOf(Error);
    const err = thrownErr as Error & { httpStatus?: number; retryAfter?: string };
    expect(err.httpStatus).toBe(502);
    // The error message must NOT contain "retry in undefineds" (or any undefined suffix).
    expect(err.message).not.toContain("undefined");
    // retryAfter should be absent (no Retry-After header was sent)
    expect(err.retryAfter).toBeUndefined();
  });
});

describe("hs-cli — config loading", () => {
  it("loadConfig returns null when no config exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-test-empty-"));
    expect(loadConfig(dir)).toBeNull();
  });

  it("saveConfig + loadConfig round-trips correctly", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-test-roundtrip-"));
    saveConfig({ baseUrl: "https://example.com", key: "hs_mykey" }, dir);
    const cfg = loadConfig(dir);
    expect(cfg).toEqual({ baseUrl: "https://example.com", key: "hs_mykey" });
  });
});
