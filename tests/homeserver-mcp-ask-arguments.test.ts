import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initDb } from "../src/db.js";

/**
 * Public transport characterization for ask argument validation. The cases intentionally put
 * several invalid fields in one request so the externally visible validation priority is pinned
 * before the pure argument normalization is extracted from mcp.ts.
 */

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const MODEL = "mcp-ask-arguments-model";

let upstream: Server;
let upstreamPort = 0;
let upstreamHits = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
      return;
    }
    upstreamHits++;
    req.resume();
    req.once("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "mcp-ask-arguments-completion",
        choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
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
  const dir = mkdtempSync(join(tmpdir(), "hs-mcp-ask-arguments-"));
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
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_DELEGATION_COST_LOG"] = "off";
  process.env["HOMESERVER_API_KEYS"] = "test-mcp-ask-arguments-static-20261017";
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const { mintKey } = await import("../src/homeserver/keystore.js");
  ownerKey = mintKey({ alias: "mcp-ask-arguments-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "mcp-ask-arguments-guest", tier: "guest" }, DEFAULTS).plaintextKey;

  const gateway = await import("../src/homeserver/gateway.js");
  const handle = await gateway.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function ask(args: Record<string, unknown>, key = ownerKey): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "mcp-ask-arguments",
      method: "tools/call",
      params: { name: "ask", arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

describe("MCP ask argument validation priority", () => {
  it("keeps the public validation order before any upstream work", async () => {
    const cases = [
      {
        args: {
          model: "",
          prompt: "",
          output_profile: "verbose",
          delegator_model_id: 123,
          traffic_purpose: "organic-ish",
          temperature: -1,
          files: [],
        },
        message: "'output_profile' must be 'complete-within-budget' when supplied.",
      },
      {
        args: {
          model: "",
          prompt: "",
          delegator_model_id: "   ",
          traffic_purpose: "organic-ish",
          temperature: -1,
          files: [],
        },
        message: "'delegator_model_id' must be a non-empty string when supplied.",
      },
      {
        args: {
          model: "",
          prompt: "",
          delegator_model_id: "",
          delegatorModelId: "fallback-is-not-used",
        },
        message: "'delegator_model_id' must be a non-empty string when supplied.",
      },
      {
        args: { model: "", prompt: "", traffic_purpose: "organic-ish", temperature: -1, files: [] },
        message: "Invalid traffic_purpose.",
      },
      {
        args: { model: "", prompt: "", temperature: -1, files: [] },
        message: "Both 'model' and 'prompt' are required.",
      },
      {
        args: { model: MODEL, prompt: "priority", temperature: -1, top_p: 2, files: [] },
        message: "'temperature' must be a number in [0, 2].",
      },
      {
        args: { model: MODEL, prompt: "priority", files: [] },
        message: "'files' must be a non-empty array of absolute path strings.",
      },
    ] as const;

    const hitsBefore = upstreamHits;
    for (const testCase of cases) {
      const body = await ask(testCase.args);
      expect(body.result).toMatchObject({
        isError: true,
        content: [{ type: "text", text: testCase.message }],
      });
    }
    expect(upstreamHits).toBe(hitsBefore);
  });

  it("keeps owner reasoning authorization ahead of later syntax errors", async () => {
    const body = await ask({
      include_reasoning: true,
      model: "",
      prompt: "",
      output_profile: "verbose",
    }, guestKey);
    expect(body.result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "'include_reasoning' requires an owner-tier API key." }],
      _meta: { m5_code: "route_not_allowed", retryable: false },
    });
  });

  it("accepts the camelCase delegator alias and closed traffic purpose on the public path", async () => {
    const hitsBefore = upstreamHits;
    const body = await ask({
      model: MODEL,
      prompt: "valid alias",
      delegator_model_id: null,
      delegatorModelId: "frontier-model",
      traffic_purpose: "organic",
    });
    expect(body.result).toMatchObject({ isError: false, content: [{ type: "text", text: "OK" }] });
    expect(upstreamHits).toBe(hitsBefore + 1);
  });
});
