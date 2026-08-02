import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { createM5Client } from "../client/m5-client.mjs";
import { resetConfig, loadConfig } from "../src/homeserver/config.js";
import { mintKey } from "../src/homeserver/keystore.js";
import { startGateway } from "../src/homeserver/gateway.js";

type FilesCapability = {
  files_enabled: boolean;
  files_reason: string;
  resolved_root_count: number | null;
};

type ToolDef = {
  name: string;
  description: string;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
  inputSchema: { type: string; properties: Record<string, unknown> };
};

type Harness = {
  ownerKey: string;
  guestKey: string;
  gatewayPort: number;
  upstreamHits: () => number;
  lastPrompt: () => string;
  stop: () => Promise<void>;
};

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const ASK_FILES_META_KEY = "gille-inference/ask_capabilities";
let aliasSeq = 0;
const ENV_KEYS = [
  "LMSTUDIO_BASE_URL",
  "HOMESERVER_HOST",
  "HOMESERVER_PORT",
  "HOMESERVER_MAX_INFLIGHT",
  "HOMESERVER_PER_REQUEST_MAX_TOKENS",
  "HOMESERVER_KEY_DEFAULT_RPM",
  "HOMESERVER_KEY_DEFAULT_TPM",
  "HOMESERVER_REDEEM_RPM",
  "HOMESERVER_BLIND_CONTEXT_ROOTS",
  "HOMESERVER_API_KEYS",
  "HOMESERVER_ADMIN_API_KEYS",
] as const;
const ORIGINAL_ENV = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));

async function createHarness(blindContextRoots: string | undefined): Promise<Harness> {
  const dbDir = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-db-"));
  initDb(join(dbDir, "test.db"));

  let upstreamHits = 0;
  let lastPrompt = "";
  const upstream: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
      upstreamHits += 1;
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString()) as {
          messages?: Array<{ role?: string; content?: string }>;
        };
        lastPrompt = parsed.messages?.find((m) => m.role === "user")?.content ?? "";
      } catch {
        lastPrompt = "";
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

  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_REDEEM_RPM"] = "10000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  if (blindContextRoots === undefined) delete process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"];
  else process.env["HOMESERVER_BLIND_CONTEXT_ROOTS"] = blindContextRoots;
  resetConfig();

  const ownerKey = mintKey(
    { alias: `bc-discovery-owner-${++aliasSeq}`, tier: "owner", modelAllowList: ["any-model"] },
    DEFAULTS
  ).plaintextKey;
  const guestKey = mintKey(
    { alias: `bc-discovery-guest-${++aliasSeq}`, tier: "guest", modelAllowList: ["any-model"] },
    DEFAULTS
  ).plaintextKey;

  const handle = await startGateway();
  return {
    ownerKey,
    guestKey,
    gatewayPort: handle.port,
    upstreamHits: () => upstreamHits,
    lastPrompt: () => lastPrompt,
    stop: async () => {
      await handle.stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      resetConfig();
    },
  };
}

afterEach(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

async function rpc(port: number, key: string, body: unknown): Promise<Response> {
  return fetch(mcpUrl(port), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

async function listTools(port: number, key: string): Promise<Array<ToolDef>> {
  const res = await rpc(port, key, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as { result: { tools: Array<ToolDef> } };
  return parsed.result.tools;
}

async function listModels(
  port: number,
  key: string
): Promise<{ text: string; structuredContent?: { ask_capabilities: FilesCapability } }> {
  const res = await rpc(port, key, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_models", arguments: {} },
  });
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as {
    result: {
      content: Array<{ text: string }>;
      structuredContent?: { ask_capabilities: FilesCapability };
    };
  };
  return {
    text: parsed.result.content[0]!.text,
    structuredContent: parsed.result.structuredContent,
  };
}

async function ask(
  port: number,
  key: string,
  args: Record<string, unknown>
): Promise<{ text: string; isError: boolean }> {
  const res = await rpc(port, key, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "ask", arguments: args },
  });
  expect(res.status).toBe(200);
  const parsed = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } };
  return { text: parsed.result.content[0]!.text, isError: parsed.result.isError };
}

function askTool(tools: Array<ToolDef>): ToolDef {
  const tool = tools.find((t) => t.name === "ask");
  expect(tool).toBeDefined();
  return tool!;
}

function askCapability(tool: ToolDef): FilesCapability {
  expect(tool.annotations).toBeUndefined();
  const capability = tool._meta?.[ASK_FILES_META_KEY];
  expect(capability).toBeDefined();
  return capability as FilesCapability;
}

function expectCapabilityText(text: string, capability: FilesCapability): void {
  expect(text).toContain("Current ask.files capability:");
  expect(text).toContain(`files_enabled: ${capability.files_enabled}`);
  expect(text).toContain(`files_reason: ${capability.files_reason}`);
  expect(text).toContain(
    `resolved_root_count: ${capability.resolved_root_count === null ? "null" : capability.resolved_root_count}`
  );
  expect(text).not.toContain(`- files_enabled: ${capability.files_enabled}`);
}

describe("MCP blind-context discovery", () => {
  it("treats an explicit empty roots env like unset: disabled, owner-only, and discoverable before ask", async () => {
    const harness = await createHarness("");
    try {
      const tools = await listTools(harness.gatewayPort, harness.ownerKey);
      const askDef = askTool(tools);
      const capability = askCapability(askDef);
      expect(capability).toEqual({
        files_enabled: false,
        files_reason: "unconfigured",
        resolved_root_count: 0,
      });
      expect(askDef.description).toContain("Call list_models for the fresh, content-blind ask.files capability state before using file attachments.");
      expect(askDef.description).not.toMatch(/currently disabled/i);

      const models = await listModels(harness.gatewayPort, harness.ownerKey);
      expect(models.structuredContent?.ask_capabilities).toEqual(capability);
      expectCapabilityText(models.text, capability);

      const result = await ask(harness.gatewayPort, harness.ownerKey, {
        model: "any-model",
        prompt: "hi",
        files: ["/etc/hostname"],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/HOMESERVER_BLIND_CONTEXT_ROOTS is not configured/i);
      expect(harness.upstreamHits()).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it("surfaces configured-but-unusable roots without leaking paths and agrees across tools/list, list_models, and ask", async () => {
    const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-invalid-"));
    const missingRoot = join(base, "missing", "nope");
    const regularFileRoot = join(base, "not-a-directory.txt");
    writeFileSync(regularFileRoot, "not a directory");
    const harness = await createHarness(`${missingRoot}:${regularFileRoot}`);
    try {
      const tools = await listTools(harness.gatewayPort, harness.ownerKey);
      const askDef = askTool(tools);
      const capability = askCapability(askDef);
      expect(capability).toEqual({
        files_enabled: false,
        files_reason: "no_resolved_roots",
        resolved_root_count: 0,
      });
      expect(askDef.description).not.toMatch(/resolve to no real directories/i);
      expect(JSON.stringify(askDef)).not.toContain(missingRoot);
      expect(JSON.stringify(askDef)).not.toContain(regularFileRoot);

      const models = await listModels(harness.gatewayPort, harness.ownerKey);
      expect(models.structuredContent?.ask_capabilities).toEqual(capability);
      expectCapabilityText(models.text, capability);
      expect(JSON.stringify(models)).not.toContain(missingRoot);
      expect(JSON.stringify(models)).not.toContain(regularFileRoot);

      const result = await ask(harness.gatewayPort, harness.ownerKey, {
        model: "any-model",
        prompt: "hi",
        files: ["/etc/hostname"],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/none of the configured HOMESERVER_BLIND_CONTEXT_ROOTS resolve to a real directory/i);
      expect(harness.upstreamHits()).toBe(0);
    } finally {
      await harness.stop();
    }
  });

  it("advertises only the bounded resolved-root count for an owner on mixed valid/invalid roots and keeps config immutable", async () => {
    const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-mixed-"));
    const allowedRoot = join(base, "allowed");
    const allowedRootAlias = join(base, "allowed-link");
    const missingRoot = join(base, "missing");
    mkdirSync(allowedRoot);
    symlinkSync(allowedRoot, allowedRootAlias);
    writeFileSync(join(allowedRoot, "notes.txt"), "the secret ingredient is basil");
    const harness = await createHarness(`${allowedRoot}:${allowedRoot}:${allowedRootAlias}:${missingRoot}`);
    try {
      const before = [...loadConfig().blindContextRoots];
      const tools = await listTools(harness.gatewayPort, harness.ownerKey);
      const askDef = askTool(tools);
      const capability = askCapability(askDef);
      expect(capability).toEqual({
        files_enabled: true,
        files_reason: "enabled",
        resolved_root_count: 1,
      });
      expect(askDef.description).not.toMatch(/currently enabled/i);
      expect(JSON.stringify(askDef)).not.toContain(allowedRoot);
      expect(JSON.stringify(askDef)).not.toContain(allowedRootAlias);
      expect(JSON.stringify(askDef)).not.toContain(missingRoot);

      const models = await listModels(harness.gatewayPort, harness.ownerKey);
      expect(models.structuredContent?.ask_capabilities).toEqual(capability);
      expectCapabilityText(models.text, capability);
      expect(JSON.stringify(models)).not.toContain(allowedRoot);
      expect(JSON.stringify(models)).not.toContain(allowedRootAlias);
      expect(JSON.stringify(models)).not.toContain(missingRoot);
      expect(loadConfig().blindContextRoots).toEqual(before);

      const result = await ask(harness.gatewayPort, harness.ownerKey, {
        model: "any-model",
        prompt: "What is the secret ingredient?",
        files: [join(allowedRoot, "notes.txt")],
      });
      expect(result.isError).toBe(false);
      expect(result.text).toBe("STUBBED COMPLETION");
      expect(harness.upstreamHits()).toBe(1);
      expect(harness.lastPrompt()).toContain("the secret ingredient is basil");
    } finally {
      await harness.stop();
    }
  });

  it("keeps ask(files) live-revalidated even if discovery was cached earlier", async () => {
    const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-live-"));
    const allowedRoot = join(base, "allowed");
    mkdirSync(allowedRoot);
    writeFileSync(join(allowedRoot, "notes.txt"), "hello");
    const harness = await createHarness(allowedRoot);
    try {
      const before = [...loadConfig().blindContextRoots];
      const initialAskDef = askTool(await listTools(harness.gatewayPort, harness.ownerKey));
      expect(askCapability(initialAskDef)).toEqual({
        files_enabled: true,
        files_reason: "enabled",
        resolved_root_count: 1,
      });

      rmSync(allowedRoot, { recursive: true, force: true });

      const result = await ask(harness.gatewayPort, harness.ownerKey, {
        model: "any-model",
        prompt: "hi",
        files: [join(allowedRoot, "notes.txt")],
      });
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/configured.*roots resolve to a real director/i);
      expect(harness.upstreamHits()).toBe(0);
      expect(loadConfig().blindContextRoots).toEqual(before);
    } finally {
      await harness.stop();
    }
  });

  it("reports guest discovery truthfully without exposing owner-only root capability", async () => {
    const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-guest-"));
    const allowedRoot = join(base, "allowed");
    mkdirSync(allowedRoot);
    writeFileSync(join(allowedRoot, "notes.txt"), "hello");
    const harness = await createHarness(allowedRoot);
    try {
      const tools = await listTools(harness.gatewayPort, harness.guestKey);
      const askDef = askTool(tools);
      const capability = askCapability(askDef);
      expect(capability).toEqual({
        files_enabled: false,
        files_reason: "owner_tier_required",
        resolved_root_count: null,
      });
      expect(askDef.description).not.toMatch(/guest-tier keys are rejected before any blind-context root check/i);
      expect(JSON.stringify(askDef)).not.toContain(allowedRoot);

      const models = await listModels(harness.gatewayPort, harness.guestKey);
      expect(models.structuredContent?.ask_capabilities).toEqual(capability);
      expectCapabilityText(models.text, capability);
      expect(JSON.stringify(models)).not.toContain(allowedRoot);
    } finally {
      await harness.stop();
    }
  });

  it("feeds the real gateway list_models result to the packaged m5 client end-to-end", async () => {
    const base = mkdtempSync(join(tmpdir(), "hs-mcp-bc-discovery-client-"));
    const allowedRoot = join(base, "allowed");
    mkdirSync(allowedRoot);
    writeFileSync(join(allowedRoot, "notes.txt"), "hello");
    const harness = await createHarness(allowedRoot);
    try {
      const client = await createM5Client({
        gatewayUrl: `http://127.0.0.1:${harness.gatewayPort}`,
        endpoint: "private",
        profile: "codex",
        credentialStore: { resolve: async () => harness.ownerKey },
      });

      await expect(client.models()).resolves.toEqual({
        models: [{ id: "any-model", description: "general" }],
        ask_capabilities: {
          files_enabled: true,
          files_reason: "enabled",
          resolved_root_count: 1,
        },
      });
    } finally {
      await harness.stop();
    }
  });

  it("preserves the empty-catalog text while still surfacing the current ask.files state", async () => {
    const harness = await createHarness(undefined);
    const openOwnerKey = mintKey({ alias: `bc-discovery-open-${++aliasSeq}`, tier: "owner" }, DEFAULTS).plaintextKey;
    try {
      const askDef = askTool(await listTools(harness.gatewayPort, openOwnerKey));
      const capability = askCapability(askDef);
      const models = await listModels(harness.gatewayPort, openOwnerKey);

      expect(models.text.startsWith("No models are available to this key.")).toBe(true);
      expect(models.structuredContent?.ask_capabilities).toEqual(capability);
      expectCapabilityText(models.text, capability);
    } finally {
      await harness.stop();
    }
  });
});
