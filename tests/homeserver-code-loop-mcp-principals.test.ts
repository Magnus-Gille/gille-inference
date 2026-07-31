import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { TASK_FINGERPRINT_VERSION, taskTextFingerprint } from "../src/homeserver/task-exposure.js";

/**
 * #137's real MCP-principal coverage: an agent credential must traverse the actual code_loop
 * transport and preserve its authenticated alias in content-blind task-exposure/ledger evidence.
 * A tiny local pi fixture is used only to make the async job terminal; it receives no secret and
 * never contacts an upstream model.
 */

const DEFAULTS = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const MONITOR_KEY = "monitor-key-code-loop-principal-test";

let root = "";
let agentKey = "";
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

function callBody(id: number, name: string, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function rpcRaw(port: number, body: unknown, key?: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === undefined ? {} : { authorization: `Bearer ${key}` }),
    },
    body: JSON.stringify(body),
  });
  return response.text();
}

async function waitForTerminal(workId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const raw = await rpcRaw(gatewayPort, callBody(20 + attempt, "code_loop_status", { work_id: workId }), agentKey);
    const parsed = JSON.parse(raw) as { result?: { content?: Array<{ text?: string }> } };
    const text = parsed.result?.content?.[0]?.text;
    if (text !== undefined) {
      const status = JSON.parse(text) as { status?: string };
      if (["completed", "cap-exceeded", "degenerate", "arm-error", "orphaned"].includes(status.status ?? "")) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`code_loop run ${workId} did not become terminal`);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hs-code-loop-mcp-principal-"));
  const workroot = join(root, "work");
  const leaseDir = join(root, "leases");
  const agentDir = join(root, "agent");
  const fakePi = join(root, "fake-pi.sh");
  mkdirSync(workroot);
  mkdirSync(leaseDir);
  mkdirSync(agentDir);
  writeFileSync(
    fakePi,
    "#!/bin/sh\n" +
      "printf '%s\\n' '{\"type\":\"turn_start\"}'\n" +
      "printf '%s\\n' '{\"type\":\"turn_end\",\"message\":{\"usage\":{\"input\":7,\"output\":3}}}'\n" +
      "printf '%s\\n' '{\"type\":\"message_end\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}]}}'\n",
    "utf8",
  );
  chmodSync(fakePi, 0o755);
  initDb(join(root, "test.db"));

  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9/v1";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_CODE_LOOP"] = "on";
  process.env["HOMESERVER_CODE_LOOP_CONFINEMENT"] = "off";
  process.env["HOMESERVER_CODE_LOOP_WORKROOT"] = workroot;
  process.env["HOMESERVER_CODE_LOOP_PI_BIN"] = fakePi;
  process.env["HOMESERVER_CODE_LOOP_PI_AGENT_DIR"] = agentDir;
  process.env["HOMESERVER_CODE_LOOP_API_KEY"] = "test-only-not-a-production-key";
  process.env["HOMESERVER_GPU_LEASE_DIR"] = leaseDir;
  process.env["HOMESERVER_MONITOR_API_KEYS"] = MONITOR_KEY;
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const { resetConfig } = await import("../src/homeserver/config.js");
  resetConfig();
  const { mintKey } = await import("../src/homeserver/keystore.js");
  agentKey = mintKey({ alias: "mcp-principal-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
  const { startGateway } = await import("../src/homeserver/gateway.js");
  const handle = await startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway !== null) await stopGateway();
  delete process.env["HOMESERVER_CODE_LOOP"];
  delete process.env["HOMESERVER_CODE_LOOP_CONFINEMENT"];
  delete process.env["HOMESERVER_CODE_LOOP_WORKROOT"];
  delete process.env["HOMESERVER_CODE_LOOP_PI_BIN"];
  delete process.env["HOMESERVER_CODE_LOOP_PI_AGENT_DIR"];
  delete process.env["HOMESERVER_CODE_LOOP_API_KEY"];
  delete process.env["HOMESERVER_GPU_LEASE_DIR"];
  delete process.env["HOMESERVER_MONITOR_API_KEYS"];
  delete process.env["HOMESERVER_REQUEST_LOG"];
});

describe("code_loop MCP principal boundaries (#137)", () => {
  it("lets an agent-scope key directly start a run and records only content-blind exposure plus its ledger alias", async () => {
    const instruction = `agent MCP principal fixture ${randomUUID()}`;
    const raw = await rpcRaw(
      gatewayPort,
      callBody(1, "code_loop_start", {
        instruction,
        files: [{ path: "seed.txt", content: "fixture\n" }],
        task_type: "code-edit",
      }),
      agentKey,
    );
    expect(raw).not.toContain(agentKey);
    const parsed = JSON.parse(raw) as { result: { isError: boolean; structuredContent: { work_id: string; status: string } } };
    expect(parsed.result.isError).toBe(false);
    expect(parsed.result.structuredContent.status).toBe("running");
    await waitForTerminal(parsed.result.structuredContent.work_id);

    const exposure = getDb().prepare(
      "SELECT lane, fingerprint_sha256 AS fingerprint, model_id AS modelId FROM task_exposure_events WHERE event_key = ?",
    ).get(`code-loop:${parsed.result.structuredContent.work_id}:${TASK_FINGERPRINT_VERSION}#rendered-prompt`) as {
      lane: string;
      fingerprint: string;
      modelId: string | null;
    };
    expect(exposure).toEqual({
      lane: "code-loop",
      fingerprint: taskTextFingerprint(instruction).sha256,
      modelId: "qwen3-coder-next-80b",
    });

    const promptHash = createHash("sha256").update(instruction).digest("hex").slice(0, 16);
    const ledger = getDb().prepare(
      "SELECT key_alias AS keyAlias, evidence_identity_hash AS identity FROM delegations WHERE source = 'code-loop' AND prompt_hash = ? ORDER BY ts DESC LIMIT 1",
    ).get(promptHash) as { keyAlias: string | null; identity: string | null };
    expect(ledger).toEqual({ keyAlias: "mcp-principal-agent", identity: null });
    // The database stores fingerprints/aliases only; neither raw task text nor the credential is persisted.
    expect(JSON.stringify({ exposure, ledger })).not.toContain(instruction);
    expect(JSON.stringify({ exposure, ledger })).not.toContain(agentKey);
  });

  it("keeps monitor credentials outside MCP visibility and direct code_loop calls", async () => {
    const list = await rpcRaw(gatewayPort, { jsonrpc: "2.0", id: 2, method: "tools/list" }, MONITOR_KEY);
    const direct = await rpcRaw(gatewayPort, callBody(3, "code_loop_start"), MONITOR_KEY);
    expect(list).not.toContain("code_loop");
    expect(direct).toBe(list);
  });

  it("keeps loopback implicit-admin outside MCP visibility and direct code_loop calls", async () => {
    // A separate zero-credential loopback startup is the only posture where implicit admin exists.
    if (stopGateway !== null) await stopGateway();
    initDb(join(mkdtempSync(join(tmpdir(), "hs-code-loop-implicit-")), "test.db"));
    delete process.env["HOMESERVER_MONITOR_API_KEYS"];
    const { resetConfig } = await import("../src/homeserver/config.js");
    resetConfig();
    const { startGateway } = await import("../src/homeserver/gateway.js");
    const implicit = await startGateway();
    gatewayPort = implicit.port;
    stopGateway = implicit.stop;

    const list = await rpcRaw(gatewayPort, { jsonrpc: "2.0", id: 4, method: "tools/list" });
    const direct = await rpcRaw(gatewayPort, callBody(5, "code_loop_start"));
    expect(list).not.toContain("code_loop");
    expect(direct.replace("code_loop_start", "§")).toBe(
      (await rpcRaw(gatewayPort, callBody(5, "zz_no_such_tool"))).replace("zz_no_such_tool", "§"),
    );
  });
});
