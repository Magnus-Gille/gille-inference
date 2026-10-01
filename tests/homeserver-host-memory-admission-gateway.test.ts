import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import type { HostMemoryReadResult } from "../src/homeserver/host-memory-admission.js";

/**
 * #350 gateway-level host-memory admission: fake llama-swap upstream, injected host reader/log
 * sink (no real host files). Each mode needs its own gateway start because config is read at start.
 */

const GIB = 1024 ** 3;
let upstream: Server;
let upstreamPort = 0;
let runningCalls = 0; // all /running hits (other gateway subsystems also observe residency)
let featureRunningCalls = 0; // only the host-memory feature's residency getter
let chatCalls = 0;
let runningModels: Array<{ model: string; state: string }> = [];
let runningDelayMs = 0;
let memory: HostMemoryReadResult = { ok: true, memory: snapshot(100, 10) };
let logs: Record<string, unknown>[] = [];
let ownerKey = "";

function snapshot(totalGib: number, availGib: number): Extract<HostMemoryReadResult, { ok: true }>["memory"] {
  return {
    memTotalBytes: totalGib * GIB,
    memAvailableBytes: availGib * GIB,
    cmaFreeBytes: null,
    gttUsedBytes: null,
    gttTotalBytes: null,
  };
}

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/running" && req.method === "GET") {
      runningCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: runningModels }));
      return;
    }
    if (path === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      chatCalls++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "c1",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    }),
  );
}

async function withGateway(
  env: Record<string, string>,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const keys = ["HOMESERVER_HOST_MEMORY_ADMISSION", "HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB"];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  // loadConfig() caches per module instance; a fresh graph is needed per mode.
  const { vi } = await import("vitest");
  vi.resetModules();
  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway({
    hostMemoryAdmissionDependencies: {
      getRunning: async () => {
        featureRunningCalls++;
        if (runningDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, runningDelayMs));
        return runningModels.map((m) => ({ ...m, ttlSeconds: null }));
      },
      readMemory: async () => memory,
      log: (rec) => logs.push(rec),
    },
  });
  try {
    await fn(handle.port);
  } finally {
    await handle.stop();
    for (const k of keys) delete process.env[k];
  }
}

async function chat(port: number, model: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
  });
}

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-hostmem-gateway-"));
  const dbPath = join(dir, "test.db");
  initDb(dbPath);
  // Modules are reloaded per mode; later instances open the same file through this path.
  process.env["EVAL_DB_PATH"] = dbPath;
  await startUpstream();
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["LLAMASWAP_BASE_URL"] = `http://127.0.0.1:${upstreamPort}`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  const ks = await import("../src/homeserver/keystore.js");
  ownerKey = ks.mintKey({ alias: "hostmem-owner", tier: "owner" }, DEFAULTS).plaintextKey;
});

afterAll(async () => {
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  runningCalls = 0;
  featureRunningCalls = 0;
  chatCalls = 0;
  runningModels = [];
  runningDelayMs = 0;
  memory = { ok: true, memory: snapshot(100, 10) };
  logs = [];
});

const BUDGETS = { HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB: "big=60,other=40" };

describe("HTTP chat host-memory admission (#350)", () => {
  it("mode off forwards and makes no /running call or log", async () => {
    await withGateway({}, async (port) => {
      const res = await chat(port, "big");
      expect(res.status).toBe(200);
    });
    expect(chatCalls).toBe(1);
    expect(featureRunningCalls).toBe(0);
    expect(logs).toHaveLength(0);
  });

  it("shadow forwards even when the decision is refuse, and logs enforced:false", async () => {
    await withGateway({ HOMESERVER_HOST_MEMORY_ADMISSION: "shadow", ...BUDGETS }, async (port) => {
      const res = await chat(port, "big");
      expect(res.status).toBe(200);
    });
    expect(chatCalls).toBe(1);
    expect(featureRunningCalls).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "host_memory_admission",
      mode: "shadow",
      outcome: "refuse",
      reason: "insufficient_memory",
      enforced: false,
    });
  });

  it("enforce + refuse returns 503 insufficient_memory with Retry-After and never reaches upstream", async () => {
    await withGateway(
      { HOMESERVER_HOST_MEMORY_ADMISSION: "enforce", HOMESERVER_HOST_MEMORY_RETRY_AFTER_SECONDS: "17", ...BUDGETS },
      async (port) => {
        const res = await chat(port, "big");
        expect(res.status).toBe(503);
        expect(res.headers.get("retry-after")).toBe("17");
        const body = (await res.json()) as { error: { code: string; message: string } };
        expect(body.error.code).toBe("insufficient_memory");
        expect(body.error.message).toContain("big");
        // The slot was released: a follow-up that is not refused is admitted (maxInflight default 2,
        // but a leaked slot would also trip server_busy for repeated refusals).
        runningModels = [{ model: "big", state: "ready" }];
        const ok = await chat(port, "big");
        expect(ok.status).toBe(200);
      },
    );
    expect(chatCalls).toBe(1);
    delete process.env["HOMESERVER_HOST_MEMORY_RETRY_AFTER_SECONDS"];
  });

  it("enforce + model already ready forwards", async () => {
    runningModels = [{ model: "big", state: "ready" }];
    await withGateway({ HOMESERVER_HOST_MEMORY_ADMISSION: "enforce", ...BUDGETS }, async (port) => {
      expect((await chat(port, "big")).status).toBe(200);
    });
    expect(chatCalls).toBe(1);
    // No start is needed, so steady-state traffic adds no log line.
    expect(featureRunningCalls).toBe(1);
    expect(logs).toHaveLength(0);
  });

  it("enforce + no budget returns 503 memory_admission_unavailable without Retry-After", async () => {
    await withGateway({ HOMESERVER_HOST_MEMORY_ADMISSION: "enforce", ...BUDGETS }, async (port) => {
      const res = await chat(port, "undeclared");
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBeNull();
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("memory_admission_unavailable");
      expect(body.error.message).toContain("undeclared");
      expect(body.error.message).toContain("budget_unknown");
    });
    expect(chatCalls).toBe(0);
  });

  it("a caller that disconnects during the observation never reaches upstream", async () => {
    // Would be allowed: plenty of memory. The caller leaves while residency is still being observed.
    memory = { ok: true, memory: snapshot(200, 190) };
    runningDelayMs = 300;
    await withGateway({ HOMESERVER_HOST_MEMORY_ADMISSION: "enforce", ...BUDGETS }, async (port) => {
      const gone = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${ownerKey}` },
        body: JSON.stringify({ model: "big", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }),
        signal: gone.signal,
      }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 80));
      gone.abort();
      await pending;
      await new Promise((resolve) => setTimeout(resolve, 450));
      expect(featureRunningCalls).toBe(1);
      expect(chatCalls).toBe(0);
      // The slot was released: a later request is served.
      runningDelayMs = 0;
      expect((await chat(port, "big")).status).toBe(200);
      expect(chatCalls).toBe(1);
    });
  });

  it("repeated refusals do not leak admission slots", async () => {
    await withGateway({ HOMESERVER_HOST_MEMORY_ADMISSION: "enforce", ...BUDGETS }, async (port) => {
      for (let i = 0; i < 6; i++) {
        const res = await chat(port, "big");
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("insufficient_memory");
      }
    });
  });
});

describe("MCP ask host-memory admission (#350)", () => {
  it("enforce + refuse returns code insufficient_memory without reaching upstream", async () => {
    process.env["HOMESERVER_HOST_MEMORY_ADMISSION"] = "enforce";
    process.env["HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB"] = "big=60";
    const { vi } = await import("vitest");
    vi.resetModules();
    const { loadConfig } = await import("../src/homeserver/config.js");
    const { runChatCompletion } = await import("../src/homeserver/mcp.js");
    const { AdmissionController } = await import("../src/homeserver/admission.js");
    const { lookupKey, mintKey } = await import("../src/homeserver/keystore.js");
    try {
      const k = mintKey({ alias: "hostmem-mcp", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
      const rec = lookupKey(k.plaintextKey)!;
      const controller = new AdmissionController({ maxInflight: 2, ownerQueueMaxMs: 1000, retryAfterAtCapSeconds: 2 });
      const r = await runChatCompletion(
        {
          alias: rec.alias,
          tier: rec.tier,
          modelAllowList: rec.modelAllowList,
          limits: { rpm: rec.rpm, tpm: rec.tpm, dailyTokenBudget: rec.dailyTokenBudget },
          maxParallel: rec.maxParallel,
          keyHash: rec.keyHash,
          creditLimit: rec.creditLimit,
        },
        loadConfig(),
        controller,
        { inc: () => {}, dec: () => {}, current: () => 0 },
        { model: "big", messages: [{ role: "user", content: "hi" }], maxTokens: 8 },
        { getRunning: async () => [], readMemory: async () => memory, log: (rec2) => logs.push(rec2) },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe("insufficient_memory");
        expect(r.message).toContain("big");
      }
      expect(chatCalls).toBe(0);
      expect(lookupKey(k.plaintextKey)!.creditsUsed).toBe(0);
      expect(controller.snapshot().inflight).toBe(0);
    } finally {
      delete process.env["HOMESERVER_HOST_MEMORY_ADMISSION"];
      delete process.env["HOMESERVER_HOST_MEMORY_MODEL_BUDGETS_GIB"];
    }
  });
});
