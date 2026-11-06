import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";

/**
 * INFER-450: the `ask` route scope — a minted OWNER key that may use MCP `ask` (and the read-only
 * helpers it needs) and nothing else. Enforcement is server-side per route and per MCP tool; the
 * regression block pins that no existing scope gained or lost anything.
 */

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let lastUpstreamBody = "";

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const SECRET_FILE_TEXT = "ASK-SCOPE-BLIND-CONTEXT-CANARY";
const DAY = 24 * 60 * 60;

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let keystore: typeof import("../src/homeserver/keystore.js");
let cli: typeof import("../src/homeserver/cli.js");
let blindFile = "";
const keys: Record<string, string> = {};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-ask-scope-"));
  initDb(join(dir, "test.db"));
  const root = join(dir, "blind");
  mkdirSync(root);
  blindFile = join(root, "note.txt");
  writeFileSync(blindFile, SECRET_FILE_TEXT);
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
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      upstreamHits++;
      lastUpstreamBody = Buffer.concat(chunks).toString();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "STUBBED COMPLETION" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"] = root;
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];

  keystore = await import("../src/homeserver/keystore.js");
  cli = await import("../src/homeserver/cli.js");
  const mint = (alias: string, tier: "owner" | "guest", scope: string) =>
    keystore.mintKey({ alias, tier, scope: scope as never }, DEFAULTS).plaintextKey;
  try {
    keys["ask"] = mint("scope-ask", "owner", "ask");
  } catch {
    // Pre-INFER-450 builds cannot mint this scope; keep the rest of the suite runnable so the
    // regression block can prove the baseline while the ask block fails individually.
    keys["ask"] = "unmintable-ask-key";
  }
  keys["agent"] = mint("scope-agent", "owner", "agent");
  keys["admin"] = mint("scope-admin", "owner", "admin");
  keys["ownerInference"] = mint("scope-owner-inference", "owner", "inference");
  keys["guestInference"] = mint("scope-guest-inference", "guest", "inference");
  keys["monitor"] = mint("scope-monitor", "guest", "monitor");

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  delete process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"];
  delete process.env["HOMESERVER_REQUEST_LOG"];
});

function base(): string {
  return `http://127.0.0.1:${gatewayPort}`;
}

async function rpc(key: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${base()}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

const callTool = (key: string, name: string, args: Record<string, unknown> = {}) =>
  rpc(key, "tools/call", { name, arguments: args });

async function toolNames(key: string): Promise<string[]> {
  const body = await rpc(key, "tools/list");
  return body.result.tools.map((t: { name: string }) => t.name);
}

async function http(key: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base()}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("ask scope: MCP", () => {
  it("can call ask over MCP through the metered path", async () => {
    const before = upstreamHits;
    const body = await callTool(keys["ask"]!, "ask", { model: "mellum", prompt: "classify: hello" });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toContain("STUBBED COMPLETION");
    expect(upstreamHits).toBe(before + 1);
  });

  it("lists exactly the ask tool plus read-only helpers, and no file-reading input", async () => {
    const body = await rpc(keys["ask"]!, "tools/list");
    const tools = body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown> }; _meta?: Record<string, any> }>;
    expect(tools.map((t) => t.name).sort()).toEqual(["ask", "list_models", "model_status", "tokenize"]);
    const ask = tools.find((t) => t.name === "ask")!;
    expect(ask.inputSchema.properties).not.toHaveProperty("files");
    expect(ask._meta?.["gille-inference/ask_capabilities"]).toMatchObject({ files_enabled: false });
  });

  it("does not advertise code_loop instructions at initialize", async () => {
    const body = await rpc(keys["ask"]!, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(body.result.instructions).toBeUndefined();
  });

  it.each([
    ["code_loop_start", { instruction: "x", files: [{ path: "a.txt", content: "a" }], task_type: "code-edit" }],
    ["code_loop_status", { work_id: "w" }],
    ["code_loop_result", { work_id: "w" }],
    ["record_adoption_evidence", {}],
    ["delegate", { prompt: "x" }],
    ["no_such_tool", {}],
  ])("rejects %s as an unknown tool", async (name, args) => {
    const body = await callTool(keys["ask"]!, name, args as Record<string, unknown>);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(`Unknown tool '${name}'.`);
  });

  it("rejects ask.files without reading the file or reaching the model", async () => {
    const before = upstreamHits;
    const body = await callTool(keys["ask"]!, "ask", { model: "mellum", prompt: "summarize", files: [blindFile] });
    expect(body.result.isError).toBe(true);
    expect(upstreamHits).toBe(before);
    expect(lastUpstreamBody).not.toContain(SECRET_FILE_TEXT);
    expect(JSON.stringify(body)).not.toContain(SECRET_FILE_TEXT);
  });

  it("does not receive an execution-feedback handle", async () => {
    const body = await callTool(keys["ask"]!, "ask", { model: "mellum", prompt: "hi" });
    expect(body.result.structuredContent).not.toHaveProperty("feedback_handle");
  });
});

describe("ask scope: HTTP routes are a closed allow-list", () => {
  it.each([
    ["POST", "/v1/chat/completions", { model: "mellum", messages: [{ role: "user", content: "x" }] }],
    ["POST", "/v1/embeddings", { model: "m", input: "x" }],
    ["POST", "/delegate", { prompt: "x" }],
    ["GET", "/admin/keys", undefined],
    ["POST", "/admin/keys", { alias: "evil", tier: "owner", scope: "admin" }],
    ["GET", "/ledger", undefined],
    ["GET", "/models/residency", undefined],
    ["POST", "/models/residency", {}],
    ["GET", "/ops/summary", undefined],
    ["GET", "/metrics", undefined],
    ["POST", "/v1/code-loop", {}],
  ])("%s %s is refused with route_not_allowed", async (method, path, body) => {
    const before = upstreamHits;
    const res = await http(keys["ask"]!, method, path, body);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error.code).toBe("route_not_allowed");
    expect(upstreamHits).toBe(before);
  });

  it.each(["/portal/me", "/v1/models", "/healthz"])("GET %s stays reachable for preflight", async (path) => {
    const res = await http(keys["ask"]!, "GET", path);
    expect(res.status).toBe(200);
  });

  it("GET /portal/me reports scope ask and no gateway/inference observation extras", async () => {
    const me = await (await http(keys["ask"]!, "GET", "/portal/me")).json() as any;
    expect(me.scope).toBe("ask");
    expect(me.tier).toBe("owner");
    expect(me).not.toHaveProperty("inferenceObservation");
    expect(me).not.toHaveProperty("gateway");
  });
});

describe("ask scope: keystore, mint, CLI, inventory", () => {
  it("is owner-only and caps lifetime at 90 days by default", () => {
    expect(keystore.MAX_KEY_LIFETIME_SECONDS["ask"]).toBe(90 * DAY);
    const minted = keystore.mintKey({ alias: "ttl-ask", tier: "owner", scope: "ask" }, DEFAULTS);
    expect(minted.record.scope).toBe("ask");
    const ttl = (Date.parse(minted.record.expiresAt!) - Date.parse(minted.record.createdAt)) / 1000;
    expect(ttl).toBeLessThanOrEqual(90 * DAY + 5);
    expect(ttl).toBeGreaterThan(90 * DAY - 5);
    expect(() => keystore.mintKey({ alias: "ttl-ask-long", tier: "owner", scope: "ask", ttlSeconds: 90 * DAY + 1 }, DEFAULTS))
      .toThrow(keystore.KeyLifetimePolicyError);
    expect(() => keystore.mintKey({ alias: "guest-ask", tier: "guest", scope: "ask" }, DEFAULTS))
      .toThrow(keystore.InvalidScopeError);
    expect(keystore.lookupKey(keys["ask"]!)!.scope).toBe("ask");
  });

  it("a tampered guest row with scope ask resolves to plain inference, never ask or agent", () => {
    const raw = keystore.mintKey({ alias: "tamper", tier: "guest", scope: "inference" }, DEFAULTS).plaintextKey;
    getDb().prepare("UPDATE api_keys SET scope = 'ask' WHERE alias = 'tamper'").run();
    expect(keystore.lookupKey(raw)!.scope).toBe("inference");
  });

  it("CLI scope flag accepts ask and still rejects unknown values", () => {
    expect(cli.strictScopeFlag({ scope: "ask" })).toBe("ask");
    expect(() => cli.strictScopeFlag({ scope: "asky" })).toThrow(/ask/);
    expect(() => cli.strictScopeFlag({ scope: true })).toThrow();
  });

  it("POST /admin/keys mints an ask key (admin only) and rejects an unknown scope", async () => {
    const ok = await http(keys["admin"]!, "POST", "/admin/keys", { alias: "via-http-ask", tier: "owner", scope: "ask" });
    expect(ok.status).toBe(201);
    expect((await ok.json() as any).record.scope).toBe("ask");
    const bad = await http(keys["admin"]!, "POST", "/admin/keys", { alias: "via-http-bogus", tier: "owner", scope: "asky" });
    expect(bad.status).toBe(400);
    const guest = await http(keys["admin"]!, "POST", "/admin/keys", { alias: "via-http-guest-ask", tier: "guest", scope: "ask" });
    expect(guest.status).toBe(400);
  });

  it("inventory shows the ask scope without flagging it as over-scoped", () => {
    const report = keystore.credentialInventory();
    const entry = report.keys.find((k) => k.alias === "scope-ask")!;
    expect(entry.scope).toBe("ask");
    expect(entry.status).toBe("active");
    expect(entry.findings).not.toContain("over_scoped");
    expect(entry.findings).not.toContain("no_expiry");
    expect(report.keys.find((k) => k.alias === "scope-admin")!.findings).toContain("over_scoped");
  });
});

describe("regression: existing scopes are unchanged", () => {
  const CODE_LOOP = ["code_loop_start", "code_loop_status", "code_loop_result"];

  it("agent and admin keep code_loop and adoption evidence in tools/list", async () => {
    for (const k of ["agent", "admin"]) {
      const names = await toolNames(keys[k]!);
      for (const t of [...CODE_LOOP, "record_adoption_evidence", "ask"]) expect(names).toContain(t);
    }
  });

  it("owner inference and guest inference never see code_loop and keep their ask schema", async () => {
    for (const k of ["ownerInference", "guestInference"]) {
      const names = await toolNames(keys[k]!);
      expect(names.sort()).toEqual(["ask", "list_models", "model_status", "tokenize"]);
    }
    const owner = (await rpc(keys["ownerInference"]!, "tools/list")).result.tools.find((t: any) => t.name === "ask");
    expect(owner.inputSchema.properties).toHaveProperty("files");
    const guest = (await rpc(keys["guestInference"]!, "tools/list")).result.tools.find((t: any) => t.name === "ask");
    expect(guest.inputSchema.properties).toHaveProperty("files");
  });

  it("owner inference may still use ask.files; guest inference may not", async () => {
    const owner = await callTool(keys["ownerInference"]!, "ask", { model: "mellum", prompt: "s", files: [blindFile] });
    expect(owner.result.isError).toBe(false);
    expect(lastUpstreamBody).toContain(SECRET_FILE_TEXT);
    const guest = await callTool(keys["guestInference"]!, "ask", { model: "mellum", prompt: "s", files: [blindFile] });
    expect(guest.result.isError).toBe(true);
  });

  it("ordinary inference and admin/ledger routes keep their existing scope behaviour", async () => {
    const chat = { model: "mellum", messages: [{ role: "user", content: "x" }] };
    expect((await http(keys["ownerInference"]!, "POST", "/v1/chat/completions", chat)).status).toBe(200);
    expect((await http(keys["guestInference"]!, "POST", "/v1/chat/completions", chat)).status).toBe(200);
    expect((await http(keys["agent"]!, "POST", "/v1/chat/completions", chat)).status).toBe(200);
    expect((await http(keys["agent"]!, "GET", "/admin/keys")).status).toBe(403);
    expect((await http(keys["admin"]!, "GET", "/admin/keys")).status).toBe(200);
    expect((await http(keys["monitor"]!, "GET", "/ledger")).status).toBe(200);
    expect((await http(keys["monitor"]!, "POST", "/v1/chat/completions", chat)).status).toBe(403);
    expect((await http(keys["ownerInference"]!, "GET", "/admin/keys")).status).toBe(403);
  });

  it("an unchanged lifetime table for the other scopes", () => {
    const t = keystore.MAX_KEY_LIFETIME_SECONDS;
    expect([t.admin, t.agent, t.inference, t.monitor]).toEqual([30 * DAY, 90 * DAY, 365 * DAY, 365 * DAY]);
  });
});
