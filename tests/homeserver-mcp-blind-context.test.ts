import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";

/**
 * End-to-end (real HTTP, real gateway) coverage for issue #128 — blind-context delegation.
 *
 * A DEDICATED gateway instance (separate from tests/homeserver-mcp.test.ts) so
 * HOMESERVER_BLIND_CONTEXT_ROOTS can be configured to a REAL temp directory tree here without
 * affecting the default-disabled posture asserted by the main MCP suite. Mirrors that suite's
 * harness: a stub upstream (captures the request body so we can assert the injected file content
 * actually reached the model), keystore-only auth, ephemeral port, real temp dirs.
 */

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let lastUpstreamBody: { model?: string; messages?: Array<{ role: string; content: string }> } | null = null;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    // The catalogue's background refresh (catalogue.ts) and the orchestrator's currentModel()
    // both hit the llama-swap admin endpoints (GET /v1/models, GET /running) independently of
    // any `ask` call, on the SAME base URL — they must be served (and NOT counted as a
    // chat-completion hit / capture lastUpstreamBody), or upstreamHits/lastUpstreamBody would
    // flake against an unrelated background fetch (#146 — llamaswap is now the default backend).
    if ((req.url ?? "").includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if ((req.url ?? "").includes("/running")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamHits++;
      try {
        lastUpstreamBody = JSON.parse(Buffer.concat(chunks).toString()) as typeof lastUpstreamBody;
      } catch {
        lastUpstreamBody = null;
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

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

let ownerKey = "";
let guestKey = "";
let allowedRoot = "";
let outsideDir = "";

beforeAll(async () => {
  const dbDir = mkdtempSync(join(tmpdir(), "hs-mcp-bc-db-"));
  initDb(join(dbDir, "test.db"));
  await startUpstream();

  const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-fs-"));
  allowedRoot = join(base, "allowed");
  outsideDir = join(base, "outside");
  mkdirSync(allowedRoot);
  mkdirSync(outsideDir);
  writeFileSync(join(allowedRoot, "notes.txt"), "the secret ingredient is basil");
  writeFileSync(join(outsideDir, "secret.txt"), "should never be reachable");

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"] = allowedRoot;
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;

  ownerKey = mintKey({ alias: "bc-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "bc-guest", tier: "guest" }, DEFAULTS).plaintextKey;

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

async function rpc(body: unknown, key: string): Promise<Response> {
  return fetch(mcpUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function askResult(id: number, args: Record<string, unknown>, key: string) {
  const res = await rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask", arguments: args } }, key);
  expect(res.status).toBe(200);
  return (await res.json()) as { result: { content: Array<{ type: string; text: string }>; isError: boolean } };
}

describe("MCP blind-context (#128) — tier enforcement", () => {
  it("owner + valid files → expansion reaches the upstream prompt", async () => {
    const hitsBefore = upstreamHits;
    const file = join(allowedRoot, "notes.txt");
    const j = await askResult(300, { model: "any-model", prompt: "What is the secret ingredient?", files: [file] }, ownerKey);
    expect(j.result.isError).toBe(false);
    expect(j.result.content[0]!.text).toBe("STUBBED COMPLETION");
    expect(upstreamHits).toBe(hitsBefore + 1);

    const sentUserContent = lastUpstreamBody?.messages?.find((m) => m.role === "user")?.content ?? "";
    expect(sentUserContent).toContain(`===== FILE: ${file} =====`);
    expect(sentUserContent).toContain("the secret ingredient is basil");
    expect(sentUserContent).toContain("===== END FILE =====");
    expect(sentUserContent).toContain("What is the secret ingredient?");
  });

  it("guest + files (even a VALID allow-listed path) → explicit owner-tier error, no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const file = join(allowedRoot, "notes.txt");
    const j = await askResult(301, { model: "any-model", prompt: "hi", files: [file] }, guestKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/owner-tier/i);
    expect(upstreamHits).toBe(hitsBefore); // rejected before any inference ran
  });

  it("guest + no files → ask still works normally (files is opt-in, not a blanket owner-only gate on the tool)", async () => {
    const j = await askResult(302, { model: "any-model", prompt: "hello with no files" }, guestKey);
    expect(j.result.isError).toBe(false);
    expect(j.result.content[0]!.text).toBe("STUBBED COMPLETION");
  });

  it("owner + a path OUTSIDE the allowed root → rejected, no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const file = join(outsideDir, "secret.txt");
    const j = await askResult(303, { model: "any-model", prompt: "hi", files: [file] }, ownerKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/HOMESERVER_BLIND_CONTEXT_ROOTS/);
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("owner + a path with '..' traversal escaping the root → rejected, no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const traversal = join(allowedRoot, "..", "outside", "secret.txt");
    const j = await askResult(304, { model: "any-model", prompt: "hi", files: [traversal] }, ownerKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/HOMESERVER_BLIND_CONTEXT_ROOTS/);
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("owner + malformed files (not an array of strings) → clear validation error", async () => {
    const j = await askResult(305, { model: "any-model", prompt: "hi", files: "not-an-array" }, ownerKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/array of absolute path strings/i);
  });

  it("owner + EMPTY files array → explicit validation error (matches the 'non-empty array' contract), no upstream call", async () => {
    const hitsBefore = upstreamHits;
    const j = await askResult(307, { model: "any-model", prompt: "hi", files: [] }, ownerKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/non-empty array/i);
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("guest + EMPTY files array → also an explicit error, never a silent no-op (the 'never silently ignored' invariant)", async () => {
    const hitsBefore = upstreamHits;
    const j = await askResult(308, { model: "any-model", prompt: "hi", files: [] }, guestKey);
    expect(j.result.isError).toBe(true);
    expect(j.result.content[0]!.text).toMatch(/non-empty array/i);
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("content-blind request_log never carries the attached file path", async () => {
    const file = join(allowedRoot, "notes.txt");
    await askResult(306, { model: "any-model", prompt: "log-check", files: [file] }, ownerKey);
    const rows = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = 'bc-owner' ORDER BY ts DESC LIMIT 1")
      .all() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain(file);
    expect(serialized).not.toContain("notes.txt");
  });
});
