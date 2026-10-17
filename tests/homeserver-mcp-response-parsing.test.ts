import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../src/db.js";

/**
 * Characterization coverage for the MCP ask response envelope.
 *
 * These cases intentionally use the public MCP transport. They pin the parsing contract while
 * the response parsing is extracted from mcp.ts: permissive successful envelopes remain usable,
 * usage fields retain their exact fallback rules, and malformed envelopes fail closed without
 * charging the caller or reflecting backend bytes.
 */

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const INVALID_SENTINEL = "INVALID_RESPONSE_SECRET_20261017";

let upstream: Server;
let upstreamPort = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let creditKey = "";
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;

function responseForModel(model: string): unknown {
  if (model === "loose-envelope") {
    // The backend may omit optional response members; this remains a successful completion with
    // empty text and null response metadata. The gateway falls back to prompt-derived accounting.
    return {};
  }
  if (model === "usage-details") {
    return {
      id: "usage-details",
      choices: [{ message: { role: "assistant", content: "USAGE DETAIL" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        prompt_tokens_details: { cache_creation_input_tokens: 2, cached_tokens: 4 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    };
  }
  if (model === "invalid-choices") {
    return { choices: { message: { content: INVALID_SENTINEL } } };
  }
  if (model === "invalid-message") {
    return { choices: [{ message: INVALID_SENTINEL }] };
  }
  if (model === "invalid-content") {
    return { choices: [{ message: { content: 42, leaked: INVALID_SENTINEL } }] };
  }
  return { choices: [{ message: { content: INVALID_SENTINEL } }] };
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
      res.end(JSON.stringify({ object: "list", data: [{ id: "loose-envelope", object: "model" }] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let model = "";
      try {
        model = String((JSON.parse(Buffer.concat(chunks).toString()) as { model?: unknown }).model ?? "");
      } catch {
        // The gateway always sends JSON; keep the fake backend's fallback bounded if it does not.
      }
      res.writeHead(200, { "content-type": "application/json" });
      if (model === "invalid-json") {
        res.end(`{"choices":[{"message":{"content":"${INVALID_SENTINEL}`);
        return;
      }
      res.end(JSON.stringify(responseForModel(model)));
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
  const dir = mkdtempSync(join(tmpdir(), "hs-mcp-response-parsing-20261017-"));
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
  process.env["HOMESERVER_REQUEST_LOG"] = "on";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_DELEGATION_COST_LOG"] = "off";
  process.env["HOMESERVER_API_KEYS"] = "test-mcp-response-parsing-static-20261017";
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  lookupKey = ks.lookupKey;
  creditKey = ks.mintKey(
    { alias: "mcp-response-parsing-credit-20261017", tier: "guest", creditLimit: 100_000 },
    DEFAULTS,
  ).plaintextKey;

  const gateway = await import("../src/homeserver/gateway.js");
  const handle = await gateway.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function ask(model: string, prompt: string): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${creditKey}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${model}-${prompt}`,
      method: "tools/call",
      params: { name: "ask", arguments: { model, prompt } },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

describe("MCP ask response parsing", () => {
  it("keeps a loose success envelope valid and charges the prompt-derived fallback exactly", async () => {
    const before = lookupKey(creditKey)!.creditsUsed;
    const body = await ask("loose-envelope", "abcdefgh");

    expect(body.result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "" }],
      structuredContent: {
        model: "loose-envelope",
        text: "",
        finish_reason: null,
        truncated: null,
        metered: true,
        usage: {
          prompt_tokens: null,
          completion_tokens: null,
          total_tokens: null,
          reasoning_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      },
    });
    expect(lookupKey(creditKey)!.creditsUsed - before).toBe(2);
  });

  it("derives total usage while preserving nested reasoning and cache counters", async () => {
    const before = lookupKey(creditKey)!.creditsUsed;
    const body = await ask("usage-details", "usage");

    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent).toMatchObject({
      text: "USAGE DETAIL",
      finish_reason: "stop",
      truncated: false,
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        reasoning_tokens: 3,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 4,
      },
    });
    expect(lookupKey(creditKey)!.creditsUsed - before).toBe(12);
  });

  it.each(["invalid-json", "invalid-choices", "invalid-message", "invalid-content"])(
    "fails closed on %s without leaking backend bytes or charging credits",
    async (model) => {
      const before = lookupKey(creditKey)!.creditsUsed;
      const body = await ask(model, `invalid-${model}`);

      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toBe("The model backend returned an invalid chat response.");
      expect(body.result._meta).toMatchObject({ m5_code: "upstream_error" });
      expect(JSON.stringify(body.result)).not.toContain(INVALID_SENTINEL);
      expect(lookupKey(creditKey)!.creditsUsed).toBe(before);
    },
  );
});
