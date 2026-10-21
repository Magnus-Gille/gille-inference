import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";

/**
 * Focused integration coverage for the owner-only MCP reasoning opt-in (#441).
 *
 * The fake backend is deliberately the only inference endpoint used here. Each test gets a
 * unique prompt, while the backend varies only the model id, so the assertions can distinguish
 * final answer text from backend reasoning metadata without touching a real M5 or credentials.
 */

const REASONING_SENTINEL = "REASONING_SENTINEL_441_OWNER_ONLY";
const MALFORMED_REASONING_SENTINEL = "MALFORMED_REASONING_SENTINEL_441";
const OWNER_ALIAS = "mcp-reasoning-owner-441";
const GUEST_ALIAS = "mcp-reasoning-guest-441";
const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let upstreamBodies: string[] = [];
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;

function backendResponse(model: string): Record<string, unknown> {
  if (model === "reasoning-nonstring-answer") {
    return { choices: [{ message: { content: { reasoning_content: MALFORMED_REASONING_SENTINEL } } }] };
  }
  if (model === "reasoning-json" || model === "reasoning-json-length") {
    return {
      choices: [{ message: { role: "assistant", content: '{"answer":"final"}', reasoning_content: REASONING_SENTINEL }, finish_reason: model.endsWith("-length") ? "length" : "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 7 },
    };
  }
  if (model === "reasoning-populated") {
    return {
      id: "reasoning-populated",
      choices: [{ message: { role: "assistant", content: "FINAL ANSWER", reasoning_content: REASONING_SENTINEL }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 7 },
    };
  }
  if (model === "reasoning-missing") {
    return {
      id: "reasoning-missing",
      choices: [{ message: { role: "assistant", content: "MISSING REASONING ANSWER" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 11 },
    };
  }
  if (model === "reasoning-nonstring") {
    return {
      id: "reasoning-nonstring",
      choices: [{ message: { role: "assistant", content: "NONSTRING REASONING ANSWER", reasoning_content: { hidden: true } }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, completion_tokens_details: { reasoning_tokens: 13 } },
    };
  }
  if (model === "reasoning-empty") {
    return {
      id: "reasoning-empty",
      choices: [{ message: { role: "assistant", content: "EMPTY REASONING ANSWER", reasoning_content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 0 },
    };
  }
  if (model === "reasoning-utf8-limit") {
    const reasoning = `${"A".repeat(16_380)}🙂🙂`;
    return {
      id: "reasoning-utf8-limit",
      choices: [{ message: { role: "assistant", content: "UTF8 LIMIT ANSWER", reasoning_content: reasoning }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 17 },
    };
  }
  if (model === "reasoning-budget-length") {
    return {
      id: "reasoning-budget-length",
      choices: [{ message: { role: "assistant", content: "PARTIAL FINAL ANSWER", reasoning_content: "short internal trace" }, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 64, total_tokens: 69, reasoning_tokens: 31 },
    };
  }
  return {
    id: "reasoning-default",
    choices: [{ message: { role: "assistant", content: "DEFAULT ANSWER", reasoning_content: REASONING_SENTINEL }, finish_reason: "stop" }],
    usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
  };
}

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "reasoning-default", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      upstreamHits++;
      const body = Buffer.concat(chunks).toString();
      upstreamBodies.push(body);
      let model = "";
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? "");
      } catch {
        // The gateway should send JSON, but returning a valid response keeps this fake bounded.
      }
      if (model === "reasoning-malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"choices":[{"message":{"content":"final","reasoning_content":"${MALFORMED_REASONING_SENTINEL}`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(backendResponse(model)));
    });
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    });
  });
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-mcp-reasoning-441-"));
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
  process.env["HOMESERVER_REQUEST_LOG"] = "on";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_DELEGATION_COST_LOG"] = "off";
  process.env["HOMESERVER_API_KEYS"] = "test-reasoning-static-441";
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  lookupKey = ks.lookupKey;
  ownerKey = ks.mintKey({ alias: OWNER_ALIAS, tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = ks.mintKey({ alias: GUEST_ALIAS, tier: "guest" }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

function mcpUrl(): string {
  return `http://127.0.0.1:${gatewayPort}/mcp`;
}

async function rpc(body: unknown, key = ownerKey): Promise<Record<string, any>> {
  const response = await fetch(mcpUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

function ask(model: string, prompt: string, args: Record<string, unknown> = {}, key = ownerKey): Promise<Record<string, any>> {
  return rpc(
    { jsonrpc: "2.0", id: `${model}-${prompt}`, method: "tools/call", params: { name: "ask", arguments: { model, prompt, ...args } } },
    key,
  );
}

function askTool(tools: Array<Record<string, any>>): Record<string, any> {
  return tools.find((tool) => tool.name === "ask")!;
}

describe("MCP ask reasoning opt-in (#441)", () => {
  it.each(["reasoning-json", "reasoning-json-length"])("keeps %s structured-output final text separate from native reasoning and preserves truncation", async (model) => {
    const beforeHits = upstreamHits;
    const body = await ask(model, `structured-${model}`, { response_format: { type: "json_object" }, include_reasoning: true });
    const truncated = model.endsWith("-length");
    expect(body.result.isError).toBe(truncated);
    expect(body.result.content[0].text).toContain('{"answer":"final"}');
    expect(body.result.content[0].text).not.toContain(REASONING_SENTINEL);
    expect(body.result.structuredContent).toMatchObject({
      text: '{"answer":"final"}',
      finish_reason: truncated ? "length" : "stop",
      truncated,
      metered: true,
      reasoning_content: REASONING_SENTINEL,
      reasoning_truncated: false,
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: 7 },
    });
    expect(JSON.parse(upstreamBodies.at(-1)!)).toHaveProperty("response_format", { type: "json_object" });
    expect(upstreamHits).toBe(beforeHits + 1);
  });

  it("advertises include_reasoning and owner-only output fields while hiding them from guests", async () => {
    const owner = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ownerKey);
    const guest = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, guestKey);
    const ownerAsk = askTool(owner.result.tools);
    const guestAsk = askTool(guest.result.tools);

    expect(ownerAsk.inputSchema.properties.include_reasoning).toMatchObject({ type: "boolean" });
    expect(ownerAsk.outputSchema.properties).toMatchObject({
      reasoning_content: { type: ["string", "null"] },
      reasoning_truncated: { type: ["boolean", "null"] },
    });
    expect(guestAsk.inputSchema.properties).not.toHaveProperty("include_reasoning");
    expect(guestAsk.outputSchema.properties).not.toHaveProperty("reasoning_content");
    expect(guestAsk.outputSchema.properties).not.toHaveProperty("reasoning_truncated");
  });

  it("keeps the default and explicit false response shape final-only and does not alter upstream payloads", async () => {
    const defaultBody = await ask("reasoning-default", "shape-default-441");
    const defaultPayload = upstreamBodies.at(-1);
    const falseBody = await ask("reasoning-default", "shape-false-441", { include_reasoning: false });
    const falsePayload = upstreamBodies.at(-1);

    for (const body of [defaultBody, falseBody]) {
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0].text).toBe("DEFAULT ANSWER");
      expect(JSON.stringify(body.result)).not.toContain(REASONING_SENTINEL);
      expect(body.result.structuredContent).not.toHaveProperty("reasoning_content");
      expect(body.result.structuredContent).not.toHaveProperty("reasoning_truncated");
    }
    expect(JSON.parse(defaultPayload!)).not.toHaveProperty("include_reasoning");
    expect(JSON.parse(falsePayload!)).not.toHaveProperty("include_reasoning");
    const defaultRequest = JSON.parse(defaultPayload!) as Record<string, unknown>;
    const falseRequest = JSON.parse(falsePayload!) as Record<string, unknown>;
    expect({ ...defaultRequest, messages: undefined }).toEqual({ ...falseRequest, messages: undefined });
    expect(lookupKey(ownerKey)!.creditsUsed).toBeGreaterThan(0);
  });

  it("returns populated owner reasoning separately, preserving final answer text and backend usage metadata", async () => {
    const body = await ask("reasoning-populated", "owner-populated-441", { include_reasoning: true });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toBe("FINAL ANSWER");
    expect(body.result.structuredContent).toMatchObject({
      text: "FINAL ANSWER",
      finish_reason: "stop",
      truncated: false,
      reasoning_content: REASONING_SENTINEL,
      reasoning_truncated: false,
      usage: { reasoning_tokens: 7 },
    });
    expect(body.result.content[0].text).not.toContain(REASONING_SENTINEL);
    expect(JSON.parse(upstreamBodies.at(-1)!)).not.toHaveProperty("include_reasoning");
  });

  it.each([
    ["reasoning-missing", null, null],
    ["reasoning-nonstring", null, null],
    ["reasoning-empty", "", false],
  ])("normalizes %s reasoning without inferring from usage tokens", async (model, expectedReasoning, expectedTruncated) => {
    const body = await ask(model, `normalize-${model}-441`, { include_reasoning: true });
    expect(body.result.isError).toBe(false);
    expect(body.result.content[0].text).toMatch(/REASONING ANSWER/);
    expect(body.result.structuredContent.reasoning_content).toBe(expectedReasoning);
    expect(body.result.structuredContent.reasoning_truncated).toBe(expectedTruncated);
    expect(body.result.structuredContent.usage.reasoning_tokens).toBeGreaterThanOrEqual(0);
  });

  it("clips reasoning at 16384 UTF-8 bytes on a whole codepoint and marks only reasoning truncation", async () => {
    const body = await ask("reasoning-utf8-limit", "utf8-limit-441", { include_reasoning: true });
    const expected = `${"A".repeat(16_380)}🙂`;
    expect(Buffer.byteLength(expected, "utf8")).toBe(16_384);
    expect(body.result.content[0].text).toBe("UTF8 LIMIT ANSWER");
    expect(body.result.structuredContent.reasoning_content).toBe(expected);
    expect(body.result.structuredContent.reasoning_truncated).toBe(true);
    expect(body.result.structuredContent.truncated).toBe(false);
    expect(body.result.structuredContent.reasoning_content).not.toContain("�");
  });

  it("distinguishes a token-budget finish from reasoning-content clipping", async () => {
    const body = await ask("reasoning-budget-length", "budget-length-441", { include_reasoning: true, max_tokens: 64 });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("PARTIAL FINAL ANSWER");
    expect(body.result.content[0].text).not.toContain("short internal trace");
    expect(body.result.structuredContent).toMatchObject({
      finish_reason: "length",
      truncated: true,
      reasoning_content: "short internal trace",
      reasoning_truncated: false,
      usage: { reasoning_tokens: 31 },
    });
    expect(body.result.content[0].text).not.toContain("short internal trace");
  });

  it("rejects guest opt-in before upstream, quota, or admission work while allowing guest false/default calls", async () => {
    const beforeHits = upstreamHits;
    const beforeAskRows = (getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE alias = ? AND route = '/mcp/ask'").get(GUEST_ALIAS) as { n: number }).n;
    const rejected = await ask("reasoning-default", "guest-true-441", { include_reasoning: true }, guestKey);
    expect(rejected.result.isError).toBe(true);
    expect(rejected.result.content[0].text).toMatch(/owner|reasoning/i);
    expect(upstreamHits).toBe(beforeHits);
    const afterAskRows = (getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE alias = ? AND route = '/mcp/ask'").get(GUEST_ALIAS) as { n: number }).n;
    expect(afterAskRows).toBe(beforeAskRows);

    const allowedFalse = await ask("reasoning-default", "guest-false-441", { include_reasoning: false }, guestKey);
    const allowedDefault = await ask("reasoning-default", "guest-default-441", {}, guestKey);
    expect(allowedFalse.result.isError).toBe(false);
    expect(allowedDefault.result.isError).toBe(false);
    expect(allowedFalse.result.structuredContent).not.toHaveProperty("reasoning_content");
    expect(allowedDefault.result.structuredContent).not.toHaveProperty("reasoning_truncated");
    expect(JSON.stringify([allowedFalse.result, allowedDefault.result])).not.toContain(REASONING_SENTINEL);
  });

  it("rejects a malformed nonboolean include_reasoning before upstream work", async () => {
    const beforeHits = upstreamHits;
    const beforeAskRows = (getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE alias = ? AND route = '/mcp/ask'").get(OWNER_ALIAS) as { n: number }).n;
    const body = await ask("reasoning-default", "invalid-441", { include_reasoning: "true" });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/include_reasoning|boolean/i);
    expect(upstreamHits).toBe(beforeHits);
    const afterAskRows = (getDb().prepare("SELECT COUNT(*) AS n FROM request_log WHERE alias = ? AND route = '/mcp/ask'").get(OWNER_ALIAS) as { n: number }).n;
    expect(afterAskRows).toBe(beforeAskRows);
  });

  it.each(["reasoning-malformed", "reasoning-nonstring-answer"])("fails closed on %s without leaking raw reasoning bytes", async (model) => {
    const ownerDefault = await ask(model, "malformed-owner-default-441");
    const ownerOptIn = await ask(model, "malformed-owner-optin-441", { include_reasoning: true });
    const guestDefault = await ask(model, "malformed-guest-default-441", {}, guestKey);
    for (const body of [ownerDefault, ownerOptIn, guestDefault]) {
      expect(body.result.isError).toBe(true);
      expect(JSON.stringify(body.result)).not.toContain(MALFORMED_REASONING_SENTINEL);
    }
    const ownerRows = getDb().prepare("SELECT completion, messages_json FROM owner_request_log WHERE alias = ?").all(OWNER_ALIAS) as Array<{ completion: string; messages_json: string }>;
    expect(JSON.stringify(ownerRows)).not.toContain(MALFORMED_REASONING_SENTINEL);
    const requestRows = getDb().prepare("SELECT * FROM request_log WHERE alias IN (?, ?) ").all(OWNER_ALIAS, GUEST_ALIAS) as Array<Record<string, unknown>>;
    expect(JSON.stringify(requestRows)).not.toContain(MALFORMED_REASONING_SENTINEL);
    const metrics = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, { headers: { authorization: `Bearer ${ownerKey}` } });
    expect(await metrics.text()).not.toContain(MALFORMED_REASONING_SENTINEL);
  });

  it("keeps reasoning token usage null when native text exists but the backend omits its count", async () => {
    const body = await ask("reasoning-default", "missing-reasoning-count-441", { include_reasoning: true });
    expect(body.result.structuredContent.reasoning_content).toBe(REASONING_SENTINEL);
    expect(body.result.structuredContent.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12, reasoning_tokens: null });
  });

  it("keeps the reasoning sentinel out of every log and metric while owner-logging the final answer", async () => {
    await ask("reasoning-populated", "logging-prompt-441", { include_reasoning: true });
    const ownerRows = getDb().prepare("SELECT completion, messages_json FROM owner_request_log WHERE alias = ? ORDER BY id DESC").all(OWNER_ALIAS) as Array<{ completion: string; messages_json: string }>;
    expect(ownerRows[0]?.completion).toBe("FINAL ANSWER");
    expect(ownerRows.some((row) => `${row.completion}\n${row.messages_json}`.includes(REASONING_SENTINEL))).toBe(false);

    const requestRows = getDb().prepare("SELECT * FROM request_log WHERE alias = ? ORDER BY ts DESC").all(OWNER_ALIAS) as Array<Record<string, unknown>>;
    expect(JSON.stringify(requestRows)).not.toContain(REASONING_SENTINEL);
    const metrics = await fetch(`http://127.0.0.1:${gatewayPort}/metrics`, { headers: { authorization: `Bearer ${ownerKey}` } });
    expect(await metrics.text()).not.toContain(REASONING_SENTINEL);
  });
});
