import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";

// Spy on the only helper that handles caller-supplied file paths (N3).
vi.mock("../src/homeserver/blind-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/homeserver/blind-context.js")>();
  return { ...actual, expandBlindContext: vi.fn(actual.expandBlindContext) };
});

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

beforeEach(() => {
  lastUpstreamBody = "";
});

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

async function rawRequest(key: string, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: gatewayPort, method, path, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
      }
    );
    req.on("error", reject);
    req.end(body);
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

// ─── Review findings (INFER-450) ───────────────────────────────────────────────────────

describe("ask scope: gate and router share one (method, pathname) view (N1)", () => {
  // gateway.ts: the ask gate and every route handler read the SAME `method` (lctx.method) and
  // `path` (URL pathname of req.url); a request is dispatched only if it is an exact member of
  // ASK_SCOPE_ROUTES, so any spelling the router would not match as /mcp etc. never gets past it.
  const rpcBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });

  it.each(["/mcp/", "/MCP", "/%6dcp", "//mcp", "/mcp%2f", "/mcp;x", "/v1/../v1/chat/completions"])(
    "POST %s fails closed before any handler",
    async (path) => {
      const before = upstreamHits;
      const res = await rawRequest(keys["ask"]!, "POST", path, rpcBody);
      expect([403, 404]).toContain(res.status);
      expect(res.body).not.toContain("tokenize");
      expect(upstreamHits).toBe(before);
    }
  );

  it.each([
    ["HEAD", "/healthz"], ["OPTIONS", "/healthz"], ["PUT", "/healthz"], ["DELETE", "/healthz"],
    ["HEAD", "/portal/me"], ["OPTIONS", "/portal/me"], ["PUT", "/portal/me"], ["DELETE", "/portal/me"],
    ["HEAD", "/v1/models"], ["OPTIONS", "/v1/models"], ["PUT", "/v1/models"], ["DELETE", "/v1/models"],
    ["GET", "/mcp"], ["HEAD", "/mcp"], ["OPTIONS", "/mcp"], ["PUT", "/mcp"], ["DELETE", "/mcp"],
    ["POST", "/portal/me"], ["POST", "/healthz"], ["POST", "/v1/models"],
  ])("%s %s is not an allowed method/path pair", async (method, path) => {
    const before = upstreamHits;
    const res = await rawRequest(keys["ask"]!, method, path, method === "GET" || method === "HEAD" ? undefined : rpcBody);
    expect([403, 404]).toContain(res.status);
    expect(upstreamHits).toBe(before);
  });

  it("query strings do not change the router's pathname, so they are the canonical route", async () => {
    // Same pathname the router matches: identical to the canonical request, not a bypass.
    expect((await rawRequest(keys["ask"]!, "POST", "/mcp?x=1", rpcBody)).status).toBe(200);
    expect((await rawRequest(keys["ask"]!, "GET", "/healthz?x")).status).toBe(200);
    // WHATWG URL parsing (used by gate and router alike) removes dot segments: /./mcp IS /mcp.
    expect((await rawRequest(keys["ask"]!, "POST", "/./mcp", rpcBody)).status).toBe(200);
    expect((await rawRequest(keys["ask"]!, "POST", "/v1/chat/completions?x=/mcp", "{}")).status).toBe(403);
  });
});

describe("ask scope: MCP bypass attempts (N2)", () => {
  const post = async (payload: unknown): Promise<string> =>
    (await rawRequest(keys["ask"]!, "POST", "/mcp", JSON.stringify(payload))).body;

  it("a JSON-RPC batch mixing ask and code_loop_start runs nothing", async () => {
    const before = upstreamHits;
    const body = await post([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { model: "mellum", prompt: "x" } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "code_loop_start", arguments: { instruction: "x", files: [{ path: "a", content: "a" }], task_type: "code-edit" } } },
    ]);
    expect(upstreamHits).toBe(before);
    expect(body).not.toContain("work_id");
    expect(body).not.toContain("STUBBED");
  });

  it.each(["Code_Loop_Start", "CODE_LOOP_STATUS", "ASK", "Ask", "ask ", "ask\u0000", "__proto__", "constructor", "toString", "hasOwnProperty", ""])(
    "tool name %j is unknown and has no effect",
    async (name) => {
      const before = upstreamHits;
      const parsed = JSON.parse(await post({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { model: "mellum", prompt: "x" } } }));
      expect(parsed.result.isError).toBe(true);
      expect(parsed.result.content[0].text).toBe(`Unknown tool '${name}'.`);
      expect(upstreamHits).toBe(before);
    }
  );

  it("tools/call without params.name, with non-string name, or with absent params is rejected", async () => {
    const before = upstreamHits;
    for (const params of [undefined, {}, { arguments: {} }, { name: 5 }, { name: ["ask"] }, { name: { toString: "ask" } }]) {
      const parsed = JSON.parse(await post({ jsonrpc: "2.0", id: 1, method: "tools/call", ...(params === undefined ? {} : { params }) }));
      expect(parsed.result.isError).toBe(true);
    }
    expect(upstreamHits).toBe(before);
  });

  it.each(["tools/Call", "TOOLS/LIST", "tools/call/", "resources/read", "prompts/list", "completion/complete", "__proto__", "sampling/createMessage"])(
    "unknown method %s is Method-not-found",
    async (method) => {
      const parsed = JSON.parse(await post({ jsonrpc: "2.0", id: 1, method }));
      expect(parsed.error?.code).toBe(-32601);
      expect(parsed.result).toBeUndefined();
    }
  );
});

describe("ask scope: ask.files is rejected before any path handling (N3)", () => {
  it.each(["existing", "nonexistent", "traversal"])(
    "never calls the file expander for a %s path and answers identically",
    async (kind) => {
      const files = kind === "existing" ? [blindFile]
        : kind === "nonexistent" ? ["/definitely/not/there/nonexistent.txt"] : ["../../etc/passwd"];
      const { expandBlindContext } = await import("../src/homeserver/blind-context.js");
      const spy = vi.mocked(expandBlindContext);
      spy.mockClear();
      const before = upstreamHits;
      const body = await callTool(keys["ask"]!, "ask", { model: "mellum", prompt: "s", files });
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toBe("File attachments ('files') are not available to an ask-scope key.");
      expect(spy).not.toHaveBeenCalled();
      expect(upstreamHits).toBe(before);
    }
  );
  it("positive control: an owner inference key does reach the expander", async () => {
    const { expandBlindContext } = await import("../src/homeserver/blind-context.js");
    const spy = vi.mocked(expandBlindContext);
    spy.mockClear();
    await callTool(keys["ownerInference"]!, "ask", { model: "mellum", prompt: "s", files: [blindFile] });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("ask scope: negatives have positive controls (N4)", () => {
  it("an agent key gets code_loop instructions at initialize and a feedback_handle on ask", async () => {
    const init = await rpc(keys["agent"]!, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(typeof init.result.instructions).toBe("string");
    expect(init.result.instructions).toContain("code_loop");
    const ask = await callTool(keys["agent"]!, "ask", { model: "mellum", prompt: "hi" });
    expect(ask.result.isError).toBe(false);
    expect(ask.result.structuredContent).toHaveProperty("feedback_handle");
    expect(typeof ask.result.structuredContent.feedback_handle).toBe("string");
  });
});

describe("ask scope: rotate and stage inherit and cap (N6)", () => {
  it("rotate inherits ask scope; guest override fails with InvalidScopeError", () => {
    keystore.mintKey({ alias: "rot-ask", tier: "owner", scope: "ask" }, DEFAULTS);
    const rotated = keystore.rotateKey("rot-ask", {}, DEFAULTS);
    expect(rotated.record.scope).toBe("ask");
    expect(rotated.record.tier).toBe("owner");
    expect(() => keystore.rotateKey("rot-ask", { tier: "guest" }, DEFAULTS)).toThrow(keystore.InvalidScopeError);
  });

  it("stage inherits ask scope, is capped at 90 days, and rejects guest tier", () => {
    keystore.mintKey({ alias: "stage-ask", tier: "owner", scope: "ask" }, DEFAULTS);
    expect(() => keystore.stageKeyRotation("stage-ask", { ttlSeconds: 90 * DAY + 1 }, DEFAULTS)).toThrow(keystore.KeyLifetimePolicyError);
    expect(() => keystore.stageKeyRotation("stage-ask", { tier: "guest" }, DEFAULTS)).toThrow(keystore.InvalidScopeError);
    const staged = keystore.stageKeyRotation("stage-ask", {}, DEFAULTS, { overlapSeconds: 3_600 });
    expect(staged.record.scope).toBe("ask");
    const ttl = (Date.parse(staged.record.expiresAt!) - Date.parse(staged.record.createdAt)) / 1000;
    expect(ttl).toBeLessThanOrEqual(90 * DAY + 5);
  });
});

describe("ask scope: rollback hazard guard (B1)", () => {
  // Inline copy of the PRE-INFER-450 storedScope (keystore.ts). It documents why `ask` keys must
  // be revoked before rolling back: the old build maps an owner `ask` row to owner `inference`.
  function preChangeStoredScope(tier: "owner" | "guest", value: string | null): string {
    if (value === null) return tier === "owner" ? "admin" : "inference";
    if (value === "inference" || value === "monitor") return value;
    if (tier === "owner" && (value === "admin" || value === "agent")) return value;
    return "inference";
  }

  it("documents the hazard: the old mapping widens an owner ask row to inference", () => {
    expect(preChangeStoredScope("owner", "ask")).toBe("inference");
  });

  it("pins the current mapping: owner+ask stays ask, guest+ask and unknown values fall to inference", () => {
    const raw = keystore.mintKey({ alias: "pin-ask", tier: "owner", scope: "ask" }, DEFAULTS).plaintextKey;
    expect(keystore.lookupKey(raw)!.scope).toBe("ask");
    getDb().prepare("UPDATE api_keys SET tier = 'guest' WHERE alias = 'pin-ask'").run();
    expect(keystore.lookupKey(raw)!.scope).toBe("inference");
    getDb().prepare("UPDATE api_keys SET tier = 'owner', scope = 'Ask' WHERE alias = 'pin-ask'").run();
    expect(keystore.lookupKey(raw)!.scope).toBe("inference");
    getDb().prepare("DELETE FROM api_keys WHERE alias = 'pin-ask'").run();
  });

  it("inventory can be filtered by scope", () => {
    const only = keystore.credentialInventory({ scope: "ask" });
    expect(only.keys.length).toBeGreaterThan(0);
    expect(only.keys.every((k) => k.scope === "ask")).toBe(true);
    expect(only.summary.total).toBe(only.keys.length);
    expect(keystore.credentialInventory().keys.length).toBeGreaterThan(only.keys.length);
  });

  it("keys revoke --scope ask is a dry run by default, then revokes only ask keys with --confirm", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { lines.push(a.join(" ")); });
    try {
      const activeAsk = () => keystore.credentialInventory({ scope: "ask" }).keys.map((k) => k.alias).sort();
      const before = activeAsk();
      expect(before).toContain("scope-ask");

      cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask" } });
      expect(activeAsk()).toEqual(before);
      expect(lines.join("\n")).toContain(`dry-run: would revoke ${before.length} active 'ask' key(s)`);

      cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask", "dry-run": true } });
      expect(activeAsk()).toEqual(before);

      expect(() => cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask", confirm: true, "dry-run": true } })).toThrow(/mutually exclusive/);
      cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask", confirm: "yes" } });
      expect(activeAsk()).toEqual(before); // only a bare --confirm applies
      expect(() => cli.cmdKeys({ positional: ["revoke", "someone"], flags: { scope: "ask", confirm: true } })).toThrow();
      expect(() => cli.cmdKeys({ positional: ["revoke"], flags: { scope: true } })).toThrow();
      expect(() => cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask", alias: "x" } })).toThrow(/unknown flag/);
      expect(activeAsk()).toEqual(before);

      const agentBefore = keystore.credentialInventory({ scope: "agent" }).keys.length;
      cli.cmdKeys({ positional: ["revoke"], flags: { scope: "ask", confirm: true } });
      expect(activeAsk()).toEqual([]);
      expect(keystore.credentialInventory({ scope: "agent" }).keys.length).toBe(agentBefore);
      expect(lines.join("\n")).not.toContain(keys["ask"]!);
      // The revoked key no longer authenticates at all.
      const res = await fetch(`${base()}/mcp`, { method: "POST", headers: { authorization: `Bearer ${keys["ask"]}`, "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
      // Idempotent.
      expect(keystore.revokeKeysByScope("ask", { dryRun: false }).aliases).toEqual([]);
    } finally {
      log.mockRestore();
    }
  });
});
