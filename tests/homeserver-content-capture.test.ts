import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { initDb, getDb } from "../src/db.js";
import { configureTaskExposureFingerprintKey } from "../src/homeserver/task-exposure.js";

const TEST_EXPOSURE_KEY = "test-only-exposure-fingerprint-key-0123456789abcdef";
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/**
 * #487 — per-call "do not log content" opt-out for owner routes.
 *
 * Every suppressed call carries a unique canary in its prompt; the stub upstream echoes the canary
 * back in its completion (and in its error bodies), so a canary anywhere in the DB or in captured
 * process output proves a content leak. Each suppression test is paired with an unsuppressed control
 * proving the scan would have found the canary (unsuppressed behaviour is unchanged).
 */

let upstream: Server;
let upstreamPort = 0;
let upstreamPosts = 0;

function lastUserContent(body: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const users = (body.messages ?? []).filter((m) => m.role === "user");
  const last = users[users.length - 1]?.content;
  return typeof last === "string" ? last : "";
}

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [], models: [], running: [] }));
      return;
    }
    upstreamPosts++;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as {
        stream?: boolean;
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const prompt = lastUserContent(body);
      if (prompt.includes("UPSTREAM_FAIL")) {
        // A hostile backend error body that echoes the prompt must never be persisted.
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `backend failed on: ${prompt}` } }));
        return;
      }
      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `stream-echo ${prompt}` } }] })}\n\n`);
        if (prompt.includes("STREAM_BREAK")) {
          // Abort mid-stream after content was already relayed (the stream_failed path).
          setTimeout(() => res.destroy(), 50);
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: `echo ${prompt}` }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      }));
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    })
  );
}

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let agentKey = "";
let adminKey = "";
let guestKey = "";

// Captured process output: console + raw stdout/stderr writes (access log, warnings).
const captured: string[] = [];
const restores: Array<() => void> = [];

function capture(): void {
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[method];
    console[method] = (...args: unknown[]) => {
      captured.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack ?? ""}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      original.apply(console, args as []);
    };
    restores.push(() => { console[method] = original; });
  }
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restores.push(() => { stream.write = original as typeof stream.write; });
  }
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-content-capture-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "on";
  process.env["HOMESERVER_EXPOSURE_FINGERPRINT_KEY"] = TEST_EXPOSURE_KEY;
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  const limits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
  ownerKey = ks.mintKey({ alias: "cc-owner", tier: "owner" }, limits).plaintextKey;
  agentKey = ks.mintKey({ alias: "cc-agent", tier: "owner", scope: "agent" }, limits).plaintextKey;
  adminKey = ks.mintKey({ alias: "cc-admin", tier: "owner", scope: "admin" }, limits).plaintextKey;
  guestKey = ks.mintKey({ alias: "cc-guest", tier: "guest" }, limits).plaintextKey;
  (await import("../src/homeserver/owner-log.js")).getOwnerLog(1);
  (await import("../src/homeserver/ledger.js")).ensureLedgerSchema();

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
  capture();
});

afterAll(async () => {
  for (const restore of restores.reverse()) restore();
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

afterEach(() => {
  // Keep the capture buffer bounded per test; each test asserts on its own canary.
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

let canarySeq = 0;
function canary(label: string): string {
  canarySeq++;
  return `CANARY_${label}_${canarySeq}_${Math.random().toString(36).slice(2, 10)}`;
}

/** Every text value of every row of every table, so a leak in any sink is found. */
function persistedText(): string {
  const db = getDb();
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name.replace(/"/g, '""')}"`).all();
    parts.push(JSON.stringify(rows));
  }
  return parts.join("\n");
}

async function settle(): Promise<void> {
  // Owner-log and ledger writes are best-effort and may land just after the response.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 10));
}

function expectAbsent(marker: string): void {
  const text = persistedText();
  expect(text).not.toContain(marker);
  // No unkeyed digest of the prompt either (a short Restricted prompt is brute-forceable from it).
  expect(text).not.toContain(sha256(marker));
  expect(captured.join("\n")).not.toContain(marker);
}

interface OwnerLogDbRow {
  id: number;
  alias: string;
  model: string | null;
  route: string;
  messages_json: string;
  completion: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  outcome: string;
  content_capture: string | null;
}

function lastOwnerRow(alias: string): OwnerLogDbRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM owner_request_log WHERE alias = @alias ORDER BY id DESC LIMIT 1`)
    .get({ alias }) as OwnerLogDbRow | undefined;
}

function ownerRowCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM owner_request_log`).get() as { n: number }).n;
}

async function chat(key: string, prompt: string, opts: { stream?: boolean; header?: string } = {}): Promise<Response> {
  return fetch(url("/v1/chat/completions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...(opts.header === undefined ? {} : { "x-content-capture": opts.header }),
    },
    body: JSON.stringify({ model: "m1", stream: opts.stream === true, messages: [{ role: "user", content: prompt }] }),
  });
}

async function mcp(key: string, method: string, params: unknown, header?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url("/mcp"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
      ...(header === undefined ? {} : { "x-content-capture": header }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

describe("unsuppressed owner traffic is unchanged (controls)", () => {
  it("an ordinary owner chat still logs the full prompt and completion", async () => {
    const marker = canary("CONTROL_CHAT");
    const res = await chat(ownerKey, marker);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-capture")).toBeNull();
    await settle();
    const row = lastOwnerRow("cc-owner")!;
    expect(row.messages_json).toContain(marker);
    expect(row.completion).toBe(`echo ${marker}`);
    expect(row.content_capture).toBeNull();
    expect(persistedText()).toContain(marker);
  });

  it("an ordinary owner MCP ask still logs content and a ledger prompt excerpt", async () => {
    const marker = canary("CONTROL_ASK");
    const out = await mcp(ownerKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker } });
    expect(out.body.result.isError).toBe(false);
    expect(out.body.result._meta?.content_capture).toBeUndefined();
    await settle();
    const excerpt = getDb().prepare(`SELECT prompt_excerpt, content_capture FROM delegations WHERE source = 'mcp-ask' ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as { prompt_excerpt: string | null; content_capture: string | null };
    expect(excerpt.prompt_excerpt).toContain(marker);
    expect(excerpt.content_capture).toBeNull();
    expect(persistedText()).toContain(marker);
  });
});

describe("X-Content-Capture: none on /v1/chat/completions", () => {
  it("non-streaming: metadata-only row, echo header, no canary anywhere", async () => {
    const marker = canary("CHAT_NONSTREAM");
    const before = ownerRowCount();
    const res = await chat(ownerKey, marker, { header: "none" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-capture")).toBe("suppressed");
    // The caller still receives the completion.
    const body = await res.json() as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe(`echo ${marker}`);
    await settle();
    expect(ownerRowCount()).toBe(before + 1);
    const row = lastOwnerRow("cc-owner")!;
    expect(row).toMatchObject({
      route: "chat", model: "m1", outcome: "ok", messages_json: "", completion: "",
      prompt_tokens: 7, completion_tokens: 3, content_capture: "suppressed",
    });
    expect(row.latency_ms).not.toBeNull();
    expectAbsent(marker);
  });

  it("accepts the header case-insensitively", async () => {
    const marker = canary("CHAT_CASE");
    const res = await chat(agentKey, marker, { header: " None " });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-capture")).toBe("suppressed");
    await res.text();
    await settle();
    expect(lastOwnerRow("cc-agent")!.content_capture).toBe("suppressed");
    expectAbsent(marker);
  });

  it("streaming: the assembled completion is never written", async () => {
    const marker = canary("CHAT_STREAM");
    const res = await chat(ownerKey, marker, { stream: true, header: "none" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-capture")).toBe("suppressed");
    expect(await res.text()).toContain(marker);
    await settle();
    const row = lastOwnerRow("cc-owner")!;
    expect(row).toMatchObject({ outcome: "ok", messages_json: "", completion: "", content_capture: "suppressed", completion_tokens: 3 });
    expectAbsent(marker);
  });

  it("streaming error path: a mid-stream failure records metadata only", async () => {
    const marker = canary("CHAT_STREAM_BREAK_STREAM_BREAK");
    const before = ownerRowCount();
    const res = await chat(ownerKey, marker, { stream: true, header: "none" });
    expect(res.status).toBe(200);
    expect(await res.text().catch(() => "")).toContain(marker);
    await settle();
    expect(ownerRowCount()).toBe(before + 1);
    const row = lastOwnerRow("cc-owner")!;
    expect(row.content_capture).toBe("suppressed");
    expect(row.outcome).toBe("stream_failed");
    expect(row.completion).toBe("");
    expectAbsent(marker);
  });

  it("upstream error path: no prompt or backend echo is persisted or echoed", async () => {
    const marker = canary("CHAT_UPSTREAM_FAIL");
    const res = await chat(ownerKey, marker, { header: "none" });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.headers.get("x-content-capture")).toBe("suppressed");
    expect(await res.text()).not.toContain(marker);
    await settle();
    expectAbsent(marker);
  });

  it("a guest request is honoured trivially and echoed (guests are content-blind already)", async () => {
    const marker = canary("CHAT_GUEST");
    const before = ownerRowCount();
    const res = await chat(guestKey, marker, { header: "none" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-content-capture")).toBe("suppressed");
    await res.text();
    await settle();
    expect(ownerRowCount()).toBe(before);
    expectAbsent(marker);
  });

  it("an invalid header value is refused before any upstream work and never echoed", async () => {
    const marker = canary("CHAT_BAD_HEADER");
    const posts = upstreamPosts;
    const before = ownerRowCount();
    const res = await chat(ownerKey, marker, { header: "metadata-only" });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("X-Content-Capture");
    expect(text).not.toContain("metadata-only");
    expect(text).not.toContain(marker);
    expect(upstreamPosts).toBe(posts);
    await settle();
    expect(ownerRowCount()).toBe(before);
    expectAbsent(marker);
  });
});

describe("malformed suppressed bodies are not echoed or logged", () => {
  for (const path of ["/v1/chat/completions", "/mcp"]) {
    it(`POST ${path} with a malformed JSON body`, async () => {
      const marker = canary("MALFORMED");
      const res = await fetch(url(path), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}`, "x-content-capture": "none" },
        body: `{"model":"m1","messages":[{"role":"user","content":"${marker}`,
      });
      expect(await res.text()).not.toContain(marker);
      await settle();
      expectAbsent(marker);
    });
  }
});

describe("content_capture on MCP tools", () => {
  it("tools/list advertises the opt-out on ask", async () => {
    const out = await mcp(ownerKey, "tools/list", {});
    const ask = (out.body.result.tools as Array<{ name: string; inputSchema: any }>).find((t) => t.name === "ask")!;
    expect(ask.inputSchema.properties.content_capture).toMatchObject({ type: "string", enum: ["none"] });
  });

  it("ask with content_capture:'none' writes metadata only and echoes _meta.content_capture", async () => {
    const marker = canary("ASK_SUPPRESSED");
    const out = await mcp(ownerKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker, content_capture: "none" } });
    expect(out.body.result.isError).toBe(false);
    expect(out.body.result.content[0].text).toBe(`echo ${marker}`);
    expect(out.body.result._meta.content_capture).toBe("suppressed");
    await settle();
    const row = lastOwnerRow("cc-owner")!;
    expect(row).toMatchObject({ route: "mcp", outcome: "ok", messages_json: "", completion: "", content_capture: "suppressed" });
    const ledger = getDb().prepare(`SELECT prompt_excerpt, prompt_hash, content_capture, outcome FROM delegations WHERE source = 'mcp-ask' ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(ledger).toMatchObject({ prompt_excerpt: null, prompt_hash: "suppressed", content_capture: "suppressed", outcome: "unverified" });
    expectAbsent(marker);
  });

  it("the X-Content-Capture header on /mcp suppresses ask without the argument", async () => {
    const marker = canary("ASK_HEADER");
    const out = await mcp(agentKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker } }, "none");
    expect(out.body.result.isError).toBe(false);
    expect(out.body.result._meta.content_capture).toBe("suppressed");
    await settle();
    expect(lastOwnerRow("cc-agent")!.content_capture).toBe("suppressed");
    expectAbsent(marker);
  });

  it("ask upstream failure: the ledger error row carries no content and errors do not echo it", async () => {
    const marker = canary("ASK_UPSTREAM_FAIL");
    const out = await mcp(ownerKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker, content_capture: "none" } });
    expect(out.body.result.isError).toBe(true);
    expect(JSON.stringify(out.body)).not.toContain(marker);
    expect(out.body.result._meta.content_capture).toBe("suppressed");
    await settle();
    const ledger = getDb().prepare(`SELECT prompt_excerpt, content_capture, outcome FROM delegations WHERE source = 'mcp-ask' ORDER BY ts DESC, rowid DESC LIMIT 1`).get() as Record<string, unknown>;
    expect(ledger).toMatchObject({ prompt_excerpt: null, content_capture: "suppressed", outcome: "error" });
    expectAbsent(marker);
  });

  it("an invalid content_capture value is refused before inference", async () => {
    const marker = canary("ASK_BAD_VALUE");
    const posts = upstreamPosts;
    const out = await mcp(ownerKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker, content_capture: "metadata" } });
    expect(out.body.result.isError).toBe(true);
    expect(out.body.result.content[0].text).toContain("content_capture");
    expect(upstreamPosts).toBe(posts);
    await settle();
    expectAbsent(marker);
  });

  it("an invalid X-Content-Capture header on /mcp is refused", async () => {
    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}`, "x-content-capture": "off" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("surfaces that cannot honour the opt-out refuse it explicitly", () => {
  const routes: Array<{ path: string; key: () => string; body: string; contentType?: string }> = [
    { path: "/delegate", key: () => adminKey, body: JSON.stringify({ prompt: "REFUSE_DELEGATE" }) },
    { path: "/v1/embeddings", key: () => ownerKey, body: JSON.stringify({ model: "embeddinggemma-2", input: "REFUSE_EMBED" }) },
    { path: "/v1/systemone", key: () => ownerKey, body: JSON.stringify({ input: "REFUSE_SYSTEMONE" }) },
    { path: "/v1/images/generations", key: () => ownerKey, body: JSON.stringify({ model: "image-fast", prompt: "REFUSE_IMAGE" }) },
    { path: "/v1/audio/transcriptions", key: () => ownerKey, body: "--x--", contentType: "multipart/form-data; boundary=x" },
  ];
  for (const route of routes) {
    it(`POST ${route.path} with X-Content-Capture: none → 400, nothing reaches upstream`, async () => {
      const posts = upstreamPosts;
      const before = ownerRowCount();
      const res = await fetch(url(route.path), {
        method: "POST",
        headers: {
          "content-type": route.contentType ?? "application/json",
          authorization: `Bearer ${route.key()}`,
          "x-content-capture": "none",
        },
        body: route.body,
      });
      expect(res.status).toBe(400);
      const body = await res.json() as { error: { message: string; param: string | null } };
      expect(body.error.param).toBe("x-content-capture");
      expect(body.error.message).toMatch(/not supported/i);
      expect(upstreamPosts).toBe(posts);
      await settle();
      expect(ownerRowCount()).toBe(before);
    });
  }

  it("content-free GET routes tolerate the header", async () => {
    const res = await fetch(url("/models"), { headers: { authorization: `Bearer ${ownerKey}`, "x-content-capture": "none" } });
    expect(res.status).toBe(200);
  });
});

describe("preflight advertisement", () => {
  it("GET /portal/me advertises the opt-out contract for the caller", async () => {
    for (const key of [ownerKey, guestKey]) {
      const res = await fetch(url("/portal/me"), { headers: { authorization: `Bearer ${key}` } });
      const body = await res.json() as Record<string, unknown>;
      expect(body["contentCaptureOptOut"]).toBe("content-capture-none-v1");
    }
  });
});

describe("without a provisioned exposure fingerprint key the opt-out fails closed", () => {
  beforeAll(() => { configureTaskExposureFingerprintKey(""); });
  afterAll(() => { configureTaskExposureFingerprintKey(TEST_EXPOSURE_KEY); });

  it("refuses X-Content-Capture: none on chat before any upstream work", async () => {
    const marker = canary("NO_KEY_CHAT");
    const posts = upstreamPosts;
    const res = await chat(ownerKey, marker, { header: "none" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/not available on this gateway/);
    expect(upstreamPosts).toBe(posts);
    await settle();
    expectAbsent(marker);
  });

  it("refuses content_capture:'none' on ask and stops advertising it", async () => {
    const marker = canary("NO_KEY_ASK");
    const posts = upstreamPosts;
    const out = await mcp(ownerKey, "tools/call", { name: "ask", arguments: { model: "m1", prompt: marker, content_capture: "none" } });
    expect(out.body.result.isError).toBe(true);
    expect(out.body.result._meta.m5_code).toBe("content_capture_unavailable");
    expect(upstreamPosts).toBe(posts);
    const list = await mcp(ownerKey, "tools/list", {});
    const ask = (list.body.result.tools as Array<{ name: string; inputSchema: any }>).find((t) => t.name === "ask")!;
    expect(ask.inputSchema.properties.content_capture).toBeUndefined();
    const me = await (await fetch(url("/portal/me"), { headers: { authorization: `Bearer ${ownerKey}` } })).json() as Record<string, unknown>;
    expect(me["contentCaptureOptOut"]).toBeUndefined();
    await settle();
    expectAbsent(marker);
  });
});
