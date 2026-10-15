import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let backend: Server;
let base: string;
let stop: (() => Promise<void>) | undefined;
let failing: boolean;
let attempts: number;
let now: number;
let admin: string;
let agent: string;
let guest: string;
let second: string;
let runningState: string | undefined;
let holdNext: boolean;
let notifyHeld: (() => void) | undefined;
let releaseHeld: (() => void) | undefined;
let db: ReturnType<typeof import("../src/db.js").getDb>;
const limits = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 10_000_000, maxParallel: 2 };

beforeEach(async () => {
  vi.resetModules();
  now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  failing = true;
  attempts = 0;
  runningState = undefined;
  holdNext = false;
  notifyHeld = undefined;
  releaseHeld = undefined;
  backend = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") {
      res.end(JSON.stringify(req.url === "/running" ? { running: runningState === undefined ? [] : [
        { model: "fixture-model", state: runningState, cmd: "private-backend-command" },
      ] } : {
        data: [{ id: "fixture-model" }, { id: "other-model" }],
      }));
      return;
    }
    req.resume();
    req.on("end", () => {
      attempts++;
      const finish = (failed: boolean) => {
        res.statusCode = failed ? 500 : 200;
        res.end(JSON.stringify(failed ? { error: { message: "private-backend-detail" } } : {
          choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
        }));
      };
      if (holdNext) {
        holdNext = false;
        releaseHeld = () => finish(false);
        notifyHeld?.();
      } else finish(failing);
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = backend.address();
  if (address === null || typeof address === "string") throw new Error("fixture listener missing");
  vi.stubEnv("LMSTUDIO_BASE_URL", `http://127.0.0.1:${address.port}/v1`);
  vi.stubEnv("HOMESERVER_BACKEND", "llamaswap");
  vi.stubEnv("HOMESERVER_HOST", "127.0.0.1");
  vi.stubEnv("HOMESERVER_PORT", "0");
  vi.stubEnv("HOMESERVER_REQUEST_LOG", "on");
  vi.stubEnv("HOMESERVER_ACCESS_LOG", "off");
  vi.stubEnv("HOMESERVER_OWNER_REQUEST_LOG", "off");
  vi.stubEnv("HOMESERVER_API_KEYS", "fixture-legacy");
  vi.stubEnv("HOMESERVER_ADMIN_API_KEYS", "fixture-static-admin");
  vi.stubEnv("HOMESERVER_MONITOR_API_KEYS", "fixture-monitor");
  vi.stubEnv("HOMESERVER_HOST_MEMORY_ADMISSION", "off");
  const database = await import("../src/db.js");
  db = database.initDb(join(mkdtempSync(join(tmpdir(), "reliability-diagnostics-")), "fixture.db"));
  const { mintKey } = await import("../src/homeserver/keystore.js");
  admin = mintKey({ alias: "fixture-admin", tier: "owner", scope: "admin" }, limits).plaintextKey;
  agent = mintKey({ alias: "fixture-agent", tier: "owner", scope: "agent" }, limits).plaintextKey;
  guest = mintKey({ alias: "fixture-guest", tier: "guest" }, limits).plaintextKey;
  second = mintKey({ alias: "fixture-second", tier: "owner", scope: "agent" }, limits).plaintextKey;
  const gateway = await (await import("../src/homeserver/gateway.js")).startGateway();
  base = `http://127.0.0.1:${gateway.port}`;
  stop = gateway.stop;
  await (await import("../src/homeserver/catalogue.js")).warmCatalogue();
});

afterEach(async () => {
  releaseHeld?.();
  await stop?.();
  stop = undefined;
  await new Promise<void>((resolve) => backend.close(() => resolve()));
  db.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function chat(key = agent, model = "fixture-model") {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "synthetic" }], max_tokens: 16 }),
  });
}

async function ask(key = agent) {
  return (await fetch(`${base}/mcp`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "ask", arguments: { model: "fixture-model", prompt: "synthetic", max_tokens: 16 },
    } }),
  })).json();
}

describe("reliability failure evidence and operator access", () => {
  it("backs off only the failing key/model across HTTP and MCP without another backend attempt", async () => {
    for (let i = 0; i < 3; i++) expect((await ask()).result.isError).toBe(true);
    expect(attempts).toBe(3);
    const blocked = await chat();
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toMatchObject({ error: {
      code: "model_temporarily_unavailable", backoff: {
        scope: "key_model", retry_after_seconds: 30,
        unavailable_until: new Date(now + 30_000).toISOString(),
      },
    } });
    expect(blocked.headers.get("retry-after")).toBe("30");
    expect(attempts).toBe(3);
    expect((await chat(second)).status).toBe(502);
    expect(attempts).toBe(4);
    expect((await chat(agent, "other-model")).status).toBe(502);
    expect(attempts).toBe(5);
    now += 30_001;
    failing = false;
    expect((await chat()).status).toBe(200);
    expect(attempts).toBe(6);
  });

  it("gives an MCP backoff a safe structured reason and logs its own correlation ID", async () => {
    for (let i = 0; i < 3; i++) await chat();
    const result = (await ask()).result;
    expect(result.isError).toBe(true);
    expect(result._meta).toMatchObject({ m5_code: "model_temporarily_unavailable", retryable: true,
      retry_after_seconds: 30, backoff: { scope: "key_model" } });
    expect(result._meta.request_id).toMatch(/^[0-9a-f-]{36}$/);
    const row = db.prepare("SELECT id, alias, error_class, admission FROM request_log WHERE id = ?")
      .get(result._meta.request_id);
    expect(row).toMatchObject({ alias: "fixture-agent", error_class: "model_temporarily_unavailable", admission: "n/a" });
    expect(JSON.stringify(result)).not.toContain("private-backend-detail");
    expect(attempts).toBe(3);
  });

  it("does not share a key-model failure guard between unidentifiable static callers", async () => {
    for (let i = 0; i < 4; i++) expect((await chat("fixture-legacy")).status).toBe(502);
    expect(attempts).toBe(4);
  });

  it("keeps the fixed backoff when an earlier admitted request finishes successfully", async () => {
    const held = new Promise<void>((resolve) => { notifyHeld = resolve; });
    holdNext = true;
    const earlierRequest = chat();
    await held;
    for (let i = 0; i < 3; i++) expect((await ask()).result.isError).toBe(true);
    expect(attempts).toBe(4);
    now += 1_000;
    releaseHeld?.();
    releaseHeld = undefined;
    expect((await earlierRequest).status).toBe(200);
    const blocked = await chat();
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get("retry-after")).toBe("29");
    expect(attempts).toBe(4);
    now += 29_001;
    failing = false;
    expect((await chat()).status).toBe(200);
    expect(attempts).toBe(5);
  });

  it("exposes bounded retained incident rows only to a minted owner-admin", async () => {
    await ask();
    const url = `${base}/ops/incidents?from=${now - 1000}&to=${now}&limit=20`;
    for (const key of [agent, guest, "fixture-monitor", "fixture-static-admin"]) {
      expect((await fetch(url, { headers: { authorization: `Bearer ${key}` } })).status).toBe(403);
    }
    expect((await fetch(url)).status).toBe(401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${admin}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ status: "available", coverage: "retained_rows_only", causality: "not_established" });
    expect(body.requests).toContainEqual(expect.objectContaining({ caller_alias: "fixture-agent", route: "/mcp/ask" }));
    expect(JSON.stringify(body)).not.toMatch(/key_hash|private-backend-detail|synthetic/);
  });

  it("rejects malformed or excessive incident windows with a fixed non-reflecting error", async () => {
    for (const query of ["from=private-secret&to=1", "from=0&to=86400001", `from=${now}&to=${now}&limit=501`]) {
      const response = await fetch(`${base}/ops/incidents?${query}`, { headers: { authorization: `Bearer ${admin}` } });
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("private-secret");
    }
  });

  it("observes only granted model residency and the caller's limits without implying loadability", async () => {
    const rpc = async (model: string, key = agent) => (await fetch(`${base}/mcp`, {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
        name: "model_status", arguments: { model },
      } }),
    })).json();
    const result = (await rpc("fixture-model")).result;
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ model: "fixture-model", residency: "not_resident",
      source: "backend_catalogue_running_snapshot", inference: "not_checked", loadable_now: "unknown",
      swap_cost_ms: null, protected: "unknown", backoff: null,
      limits: { scope: "key", rpm: { limit: 1000, window: "60s" }, max_parallel: 2 } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-agent|key_hash|private-backend-detail|command/);
    expect((await rpc("ungranted-private-input")).result.isError).toBe(true);
    const shared = (await rpc("fixture-model", "fixture-legacy")).result;
    expect(shared.structuredContent.limits.scope).toBe("shared_static_tier");
    for (const [state, residency] of [["loading", "unknown"], ["ready", "resident"], ["unloading", "unknown"]]) {
      runningState = state;
      const observation = (await rpc("fixture-model")).result;
      expect(observation.structuredContent.residency).toBe(residency);
      expect(observation.structuredContent.loadable_now).toBe("unknown");
      expect(JSON.stringify(observation)).not.toContain("private-backend-command");
    }
    expect(attempts).toBe(0);
  });
});
