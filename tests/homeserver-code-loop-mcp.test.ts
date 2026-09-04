import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";

/**
 * Owner-agent gating for the code_loop_* MCP tools (docs/agentic-code-tool-design.md §6, §11).
 *
 * The gate combines the owner-content guard with explicit agent/admin route scope.
 *   • A minted OWNER key sees the three tools in tools/list.
 *   • A minted owner-tier AGENT key sees them but cannot use operator routes.
 *   • A GUEST key never sees them, and calling one returns the BYTE-IDENTICAL unknown-tool
 *     error a genuinely unknown tool produces — invisible, not just forbidden.
 *   • A legacy static ADMIN key (tier owner but keyHash === null) is ALSO excluded.
 *
 * The feature flag is left OFF (default): visibility is gated by principal, and an owner call
 * with the flag off gets a structured `disabled` refusal — a deploy without provisioning is
 * inert but never invisible to the owner.
 */

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const STATIC_ADMIN_KEY = "legacy-static-admin-key-for-code-loop-gate-test";

let ownerKey = "";
let agentKey = "";
let inferenceOwnerKey = "";
let legacyNullScopeOwnerKey = "";
let guestKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-code-loop-mcp-"));
  initDb(join(dir, "test.db"));

  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9"; // never called in this suite
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  // Deliberately NOT set: HOMESERVER_CODE_LOOP (default off).
  delete process.env["HOMESERVER_CODE_LOOP"];
  delete process.env["HOMESERVER_API_KEYS"];
  // A legacy static admin: tier "owner" but keyHash === null → MUST be excluded by the gate.
  process.env["HOMESERVER_ADMIN_API_KEYS"] = STATIC_ADMIN_KEY;

  const { resetConfig } = await import("../src/homeserver/config.js");
  resetConfig();

  const ks = await import("../src/homeserver/keystore.js");
  ownerKey = ks.mintKey({ alias: "cl-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  agentKey = ks.mintKey(
    { alias: "cl-agent", tier: "owner", scope: "agent" },
    DEFAULTS
  ).plaintextKey;
  inferenceOwnerKey = ks.mintKey(
    { alias: "cl-owner-inference", tier: "owner", scope: "inference" },
    DEFAULTS
  ).plaintextKey;
  const legacyNullScopeOwner = ks.mintKey(
    { alias: "cl-owner-legacy-null", tier: "owner" },
    DEFAULTS
  );
  legacyNullScopeOwnerKey = legacyNullScopeOwner.plaintextKey;
  getDb()
    .prepare("UPDATE api_keys SET scope = NULL WHERE alias = ?")
    .run(legacyNullScopeOwner.record.alias);
  guestKey = ks.mintKey({ alias: "cl-guest", tier: "guest" }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
});

async function rpcRaw(body: unknown, key: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  return res.text();
}

function toolsListBody(id: number): unknown {
  return { jsonrpc: "2.0", id, method: "tools/list" };
}

function callBody(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function learningTaskPreflight(key?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${gatewayPort}/v1/capabilities/learning-task`, {
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });
}

async function listedToolNames(key: string): Promise<string[]> {
  const raw = await rpcRaw(toolsListBody(1), key);
  const parsed = JSON.parse(raw) as { result: { tools: Array<{ name: string }> } };
  return parsed.result.tools.map((t) => t.name);
}

async function initialized(key: string): Promise<Record<string, unknown>> {
  return JSON.parse(await rpcRaw({ jsonrpc: "2.0", id: 99, method: "initialize" }, key)).result as Record<string, unknown>;
}

async function listedTools(key: string): Promise<Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> }; outputSchema?: Record<string, unknown> }>> {
  const raw = await rpcRaw(toolsListBody(2), key);
  const parsed = JSON.parse(raw) as { result: { tools: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> }; outputSchema?: Record<string, unknown> }> } };
  return parsed.result.tools;
}

const CODE_LOOP_TOOLS = ["code_loop_start", "code_loop_status", "code_loop_result"];
const TOOLS_WITH_OUTPUT_SCHEMAS = ["list_models", "ask", ...CODE_LOOP_TOOLS];

describe("LearningTaskContract authenticated preflight", () => {
  it("does not advertise the learning seam without authentication", async () => {
    const response = await learningTaskPreflight();
    expect(response.status).toBe(401);
  });

  it("advertises the exact accepted v1 contract to an authenticated Hugin-capable caller", async () => {
    const response = await learningTaskPreflight(ownerKey);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, max-age=900");
    expect(await response.json()).toMatchObject({
      endpoint: "/v1/capabilities/learning-task",
      protocol_version: "learning-task-preflight/v1",
      authenticated_principal_id: "service:gille-inference",
      authentication: "service-auth",
      capabilities: {
        contract_version: "grimnir.learning-task/v1",
        schema_revision: 1,
        features: [
          "hugin-request-stamp-v1",
          "gateway-echo-v1",
          "three-stage-prompt-provenance-v1",
          "reproducible-serving-digests-v1",
        ],
      },
    });
  });
});

describe("code_loop_* visibility in tools/list", () => {
  it("a minted OWNER key sees all three code_loop tools", async () => {
    const names = await listedToolNames(ownerKey);
    for (const t of CODE_LOOP_TOOLS) expect(names).toContain(t);
    // and still the baseline tools
    expect(names).toContain("list_models");
    expect(names).toContain("ask");
  });

  it("a least-privilege AGENT key sees ask and all three code_loop tools", async () => {
    const names = await listedToolNames(agentKey);
    expect(names).toContain("list_models");
    expect(names).toContain("ask");
    for (const t of CODE_LOOP_TOOLS) expect(names).toContain(t);
  });

  it("puts owner-only delegation instructions in initialize and never leaks them to guests", async () => {
    expect(String((await initialized(ownerKey))["instructions"])).toMatch(/self-contained.*seed-file/i);
    expect((await initialized(guestKey))["instructions"]).toBeUndefined();
  });

  it("keeps structuredContent scoped to code_loop tools", async () => {
    const raw = await rpcRaw(callBody(98, "ask", {}), ownerKey);
    const parsed = JSON.parse(raw) as { result: { content: Array<{ text: string }>; structuredContent?: unknown } };
    expect(parsed.result.content[0]?.text).toContain("required");
    expect(parsed.result.structuredContent).toBeUndefined();
  });

  it("advertises the versioned caller-idempotency input only on the owner start tool", async () => {
    const start = (await listedTools(ownerKey)).find((tool) => tool.name === "code_loop_start");
    expect(start?.inputSchema?.properties).toHaveProperty("client_run_id");
    expect(JSON.stringify(start?.inputSchema?.properties?.["client_run_id"])).toContain("client-run-id-v1");
    expect(start?.inputSchema?.properties).toHaveProperty("learning_task_stamp");
    expect(JSON.stringify(start?.inputSchema?.properties?.["learning_task_stamp"])).toContain(
      "LearningTaskContract v1",
    );
  });

  it("advertises the exact harness and evidence contract before a paid start", async () => {
    const start = (await listedTools(ownerKey)).find((tool) => tool.name === "code_loop_start");
    expect(start?.description).toContain(
      "contract[harness=code-loop-pi-2026-09-04-v8;agent_checks=pi-bash-events-v3;result_scope=writable-v1;completion_accounting=bounded-turns-v1;schema=3;max_attempts=1000]"
    );
    expect(start?.inputSchema?.properties).toHaveProperty("writable");
  });

  it("makes the delegate-or-not contract discoverable without starting a job", async () => {
    const start = (await listedTools(ownerKey)).find((tool) => tool.name === "code_loop_start");
    expect(start?.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["instruction", "files"],
    });
    const files = (start?.inputSchema?.properties?.["files"] ?? {}) as Record<string, unknown>;
    expect(files).toMatchObject({ type: "array", minItems: 1, maxItems: 64 });
    expect(start?.outputSchema).toBeDefined();
  });

  it("advertises a Claude-compatible object root for every output schema", async () => {
    const tools = await listedTools(ownerKey);
    const toolsWithOutputSchemas = tools.filter((tool) => tool.outputSchema !== undefined);

    expect(toolsWithOutputSchemas.map((tool) => tool.name)).toEqual(TOOLS_WITH_OUTPUT_SCHEMAS);
    for (const tool of toolsWithOutputSchemas) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
  });

  it("advertises a well-formed start lifecycle with closed state and refusal variants", async () => {
    const start = (await listedTools(ownerKey)).find((tool) => tool.name === "code_loop_start");
    const schemaText = JSON.stringify(start?.outputSchema);
    for (const value of ["running", "completed", "cap-exceeded", "degenerate", "arm-error", "orphaned"]) {
      expect(schemaText).toContain(value);
    }
    for (const refusal of ["disabled", "busy", "maintenance", "lease-unavailable", "cage-unavailable", "invalid-request", "conflict", "admission-recovery"]) {
      expect(schemaText).toContain(refusal);
    }
  });

  it("a GUEST key sees none of them", async () => {
    const names = await listedToolNames(guestKey);
    for (const t of CODE_LOOP_TOOLS) expect(names).not.toContain(t);
  });

  it("an owner-tier INFERENCE key sees none of them", async () => {
    const names = await listedToolNames(inferenceOwnerKey);
    for (const t of CODE_LOOP_TOOLS) expect(names).not.toContain(t);
  });

  it("a legacy owner key with a null stored scope keeps admin compatibility", async () => {
    const names = await listedToolNames(legacyNullScopeOwnerKey);
    for (const t of CODE_LOOP_TOOLS) expect(names).toContain(t);
  });

  it("a legacy static ADMIN (owner tier, keyHash null) sees none of them", async () => {
    const names = await listedToolNames(STATIC_ADMIN_KEY);
    for (const t of CODE_LOOP_TOOLS) expect(names).not.toContain(t);
  });
});

describe("agent scope cannot use operator routes", () => {
  it("reports owner privacy/admission tier separately from non-admin agent scope", async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/portal/me`, {
      headers: { authorization: `Bearer ${agentKey}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      alias: "cl-agent",
      tier: "owner",
      scope: "agent",
    });
  });

  it.each([
    ["GET", "/admin/keys", undefined],
    ["POST", "/admin/models/load", JSON.stringify({ modelKey: "never-load" })],
    ["POST", "/delegate", JSON.stringify({ prompt: "must not write ledger evidence" })],
    ["GET", "/ledger", undefined],
  ])("%s %s returns route_not_allowed", async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${agentKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "route_not_allowed" },
    });
  });

  it("is admitted as owner traffic while a guest is refused during maintenance", async () => {
    const maintenanceUrl = `http://127.0.0.1:${gatewayPort}/admin/maintenance`;
    const chatUrl = `http://127.0.0.1:${gatewayPort}/v1/chat/completions`;
    const chatBody = JSON.stringify({
      model: "m1",
      messages: [{ role: "user", content: "hello" }],
    });

    const enabled = await fetch(maintenanceUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STATIC_ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ on: true }),
    });
    expect(enabled.status).toBe(200);

    try {
      const guest = await fetch(chatUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${guestKey}`,
          "content-type": "application/json",
        },
        body: chatBody,
      });
      expect(guest.status).toBe(503);

      const agent = await fetch(chatUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${agentKey}`,
          "content-type": "application/json",
        },
        body: chatBody,
      });
      // Port 9 has no upstream. Reaching the upstream error proves the owner-tier
      // agent passed maintenance admission instead of being treated as a guest.
      expect(agent.status).toBe(502);
    } finally {
      const disabled = await fetch(maintenanceUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${STATIC_ADMIN_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ on: false }),
      });
      expect(disabled.status).toBe(200);
    }
  });

  it("allows an admin to mint an agent-scoped credential over HTTP", async () => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}/admin/keys`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${STATIC_ADMIN_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        alias: "cl-http-agent",
        tier: "owner",
        scope: "agent",
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      record: {
        alias: "cl-http-agent",
        tier: "owner",
        scope: "agent",
      },
    });
  });
});

describe("legacy null-scope owner compatibility", () => {
  it.each([
    ["GET", "/admin/keys"],
    ["GET", "/ledger"],
  ])("%s %s remains allowed", async (method, path) => {
    const response = await fetch(`http://127.0.0.1:${gatewayPort}${path}`, {
      method,
      headers: { authorization: `Bearer ${legacyNullScopeOwnerKey}` },
    });
    expect(response.status).toBe(200);
  });
});

describe("code_loop_* calls by non-owners — byte-identical unknown-tool error", () => {
  // The response to a guest calling code_loop_start must be indistinguishable — byte for
  // byte, modulo the tool name itself — from calling a tool that has never existed. A
  // "forbidden" (or any distinct) response would leak the tool's existence.
  const UNKNOWN = "zz_no_such_tool";

  async function assertByteIdentical(key: string, tool: string): Promise<void> {
    const forGated = await rpcRaw(callBody(7, tool, {}), key);
    const forUnknown = await rpcRaw(callBody(7, UNKNOWN, {}), key);
    expect(forGated.split(tool).join("§")).toBe(forUnknown.split(UNKNOWN).join("§"));
    // and it really is the unknown-tool shape (isError, not a JSON-RPC -32601)
    expect(forGated).toContain("Unknown tool");
  }

  it("guest calling code_loop_start", async () => {
    await assertByteIdentical(guestKey, "code_loop_start");
  });

  it("guest calling code_loop_status", async () => {
    await assertByteIdentical(guestKey, "code_loop_status");
  });

  it("guest calling code_loop_result", async () => {
    await assertByteIdentical(guestKey, "code_loop_result");
  });

  it("owner-tier inference key calling code_loop_start", async () => {
    await assertByteIdentical(inferenceOwnerKey, "code_loop_start");
  });

  it("legacy static admin (keyHash null) calling code_loop_start", async () => {
    await assertByteIdentical(STATIC_ADMIN_KEY, "code_loop_start");
  });
});

describe("owner call with the feature flag OFF", () => {
  it("rejects a malformed learning_task_stamp instead of silently entering the legacy path", async () => {
    const raw = await rpcRaw(
      callBody(7, "code_loop_start", {
        learning_task_stamp: { contract_version: "grimnir.learning-task/v0" },
        instruction: "x",
        files: [{ path: "a.ts", content: "y" }],
      }),
      ownerKey,
    );
    const parsed = JSON.parse(raw) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(parsed.result.isError).toBe(true);
    expect(JSON.parse(parsed.result.content[0]!.text)).toMatchObject({ refusal: "invalid-request" });
  });

  it("rejects a supplied non-string client_run_id instead of silently entering legacy mode", async () => {
    const raw = await rpcRaw(
      callBody(8, "code_loop_start", {
        client_run_id: 123,
        instruction: "x",
        files: [{ path: "a.ts", content: "y" }],
      }),
      ownerKey
    );
    const parsed = JSON.parse(raw) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(parsed.result.isError).toBe(true);
    expect(JSON.parse(parsed.result.content[0]!.text)).toMatchObject({ refusal: "invalid-request" });
  });

  it("returns a structured `disabled` refusal (inert deploy, but never invisible to the owner)", async () => {
    const raw = await rpcRaw(
      callBody(9, "code_loop_start", { instruction: "x", files: [{ path: "a.ts", content: "y" }] }),
      ownerKey
    );
    const parsed = JSON.parse(raw) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(parsed.result.isError).toBe(true);
    const payload = JSON.parse(parsed.result.content[0]!.text) as { refusal: string };
    expect(payload.refusal).toBe("disabled");
    expect(parsed.result.structuredContent).toEqual(payload);
  });

  it("code_loop_status for an unknown work_id is a tool error, not a crash", async () => {
    const raw = await rpcRaw(callBody(10, "code_loop_status", { work_id: "cl-nope" }), ownerKey);
    const parsed = JSON.parse(raw) as { result: { isError: boolean } };
    expect(parsed.result.isError).toBe(true);
    expect(JSON.parse(raw).result.structuredContent).toEqual({ error: "unknown work_id", work_id: "cl-nope" });
  });
});
