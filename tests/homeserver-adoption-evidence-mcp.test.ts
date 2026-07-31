import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getDb, initDb } from "../src/db.js";

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let agentKey = "";
let guestKey = "";

function callBody(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpc(body: unknown, key: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return response.text();
}

const report = {
  harness: "codex_cli",
  execution_mode: "code_loop",
  traffic_purpose: "organic",
  result: "not_attempted",
  deterministic_check: "not_run",
  reviewer_usefulness: "not_reported",
  fallback_reason: "m5_auth_unavailable",
  eligible_opportunities: 2,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-adoption-evidence-mcp-"));
  initDb(join(dir, "test.db"));
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9/v1";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  const { resetConfig } = await import("../src/homeserver/config.js");
  resetConfig();
  const { mintKey } = await import("../src/homeserver/keystore.js");
  agentKey = mintKey({ alias: "adoption-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
  guestKey = mintKey({ alias: "adoption-guest", tier: "guest" }, DEFAULTS).plaintextKey;
  const { startGateway } = await import("../src/homeserver/gateway.js");
  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
});

describe("record_adoption_evidence MCP tool (#136)", () => {
  it("allows a real owner-agent credential to submit a content-free observation", async () => {
    const raw = await rpc(callBody(1, "record_adoption_evidence", report), agentKey);
    expect(raw).not.toContain(agentKey);
    const parsed = JSON.parse(raw) as { result: { isError: boolean; structuredContent: unknown } };
    expect(parsed.result.isError).toBe(false);
    expect(parsed.result.structuredContent).toEqual({ accepted: true });
    expect(getDb().prepare("SELECT harness, execution_mode, traffic_purpose, fallback_reason, eligible_opportunities FROM adoption_evidence").get()).toEqual({
      harness: "codex_cli",
      execution_mode: "code_loop",
      traffic_purpose: "organic",
      fallback_reason: "m5_auth_unavailable",
      eligible_opportunities: 2,
    });
  });

  it("does not expose an identity, prompt, response, or path in the acceptance payload", async () => {
    const raw = await rpc(callBody(2, "record_adoption_evidence", report), agentKey);
    expect(raw).toContain("accepted");
    expect(raw).not.toMatch(/adoption-agent|prompt|response|path|repo|alias/i);
  });

  it("keeps the reporting tool invisible to guest credentials", async () => {
    const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, guestKey);
    const direct = await rpc(callBody(4, "record_adoption_evidence", report), guestKey);
    const unknown = await rpc(callBody(5, "unknown_tool", report), guestKey);
    expect(list).not.toContain("record_adoption_evidence");
    const directResult = JSON.parse(direct) as { result: unknown };
    const unknownResult = JSON.parse(unknown) as { result: unknown };
    expect(JSON.stringify(directResult.result).replace("record_adoption_evidence", "unknown_tool"))
      .toBe(JSON.stringify(unknownResult.result));
  });
});
