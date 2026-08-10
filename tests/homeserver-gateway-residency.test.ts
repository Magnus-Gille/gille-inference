import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { appendModelLifecycleEvent } from "../src/homeserver/model-lifecycle.js";

let upstream: Server;
let upstreamPort = 0;
let runningStatus = 200;
let runningModels: unknown[] = [];
let upstreamRequests: string[] = [];
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let adminKey = "";
let monitorKey = "residency-monitor-static";
let guestKey = "";
let agentKey = "";

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    upstreamRequests.push(`${req.method ?? ""} ${req.url ?? ""}`);
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/running" && req.method === "GET") {
      res.writeHead(runningStatus, { "content-type": "application/json" });
      res.end(runningStatus === 200 ? JSON.stringify({ running: runningModels }) : "unavailable");
      return;
    }
    if (path === "/v1/models" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen-main" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolve) => {
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    });
  });
}

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-residency-gateway-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["LLAMASWAP_BASE_URL"] = `http://127.0.0.1:${upstreamPort}`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_REQUEST_LOG"] = "off";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "residency-admin-static";
  process.env["HOMESERVER_MONITOR_API_KEYS"] = monitorKey;
  process.env["HOMESERVER_API_KEYS"] = "residency-user-static";

  const keystore = await import("../src/homeserver/keystore.js");
  const requestLog = await import("../src/homeserver/request-log.js");
  requestLog.ensureRequestLogSchema();
  adminKey = keystore.mintKey({ alias: "residency-owner-admin", tier: "owner", scope: "admin" }, DEFAULTS).plaintextKey;
  agentKey = keystore.mintKey({ alias: "residency-owner-agent", tier: "owner", scope: "agent" }, DEFAULTS).plaintextKey;
  guestKey = keystore.mintKey({ alias: "residency-guest", tier: "guest" }, DEFAULTS).plaintextKey;

  const gateway = await import("../src/homeserver/gateway.js");
  const handle = await gateway.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

beforeEach(() => {
  runningStatus = 200;
  runningModels = [];
  upstreamRequests = [];
  getDb().exec("DELETE FROM request_log");
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

async function getResidency(token?: string): Promise<Response> {
  return fetch(url("/models/residency"), {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

function insertSuccessfulUse(
  model: string,
  ts: number,
  alias: string | null = null,
  node: "m5" | "orin" = "m5",
): void {
  getDb()
    .prepare(
      `INSERT INTO request_log (id, ts, alias, model, node, route, status, outcome, total_ms)
       VALUES (@id, @ts, @alias, @model, @node, @route, @status, @outcome, 1)`
    )
    .run({
      id: `residency-${node}-${ts}`,
      ts,
      alias,
      model,
      node,
      route: "/v1/chat/completions",
      status: 200,
      outcome: "ok",
    });
}

function insertLifecycleStart(model: string, ts: number): void {
  appendModelLifecycleEvent({
    ts: new Date(ts).toISOString(),
    model,
    event: "ready",
    state: "ready",
    ttlSeconds: 60,
    cause: "snapshot",
  });
}

describe("GET /models/residency", () => {
  it("returns the safe diagnostic and narrow last-use shape to an admin", async () => {
    const ts = Date.now() - 1_000;
    runningModels = [
      {
        model: "qwen-main",
        state: "ready",
        ttl: 60,
        cmd: "llama-server --api-key secret",
        proxy: "http://127.0.0.1:9000",
        requestId: "raw-request-id",
        keyHash: "raw-key-hash",
        tokens: 99,
        content: "raw-content",
        ip: "192.0.2.1",
      },
    ];
    insertSuccessfulUse("qwen-main", ts, "residency-owner");
    insertSuccessfulUse("qwen-main", ts + 500, "orin-owner-must-not-escape", "orin");

    const response = await getResidency(adminKey);
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<Record<string, unknown>> };
    // Without a current lifecycle epoch, lastUse is evidence only; retention must fail closed.
    expect(body).toEqual({
      models: [
        {
          model: "qwen-main",
          state: "ready",
          ttl: 60,
          classification: "unknown",
          lastUse: {
            ts,
            alias: "residency-owner",
            route: "/v1/chat/completions",
            outcome: "ok",
          },
        },
      ],
    });
    expect(Object.keys(body.models[0] ?? {}).sort()).toEqual([
      "classification",
      "lastUse",
      "model",
      "state",
      "ttl",
    ]);
    expect(JSON.stringify(body)).not.toMatch(/cmd|proxy|request.?id|key.?hash|token|content|ip|secret/i);
    expect(upstreamRequests.filter((request) => request === "GET /running").length).toBeGreaterThanOrEqual(1);
    expect(upstreamRequests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it("allows the existing read-only monitor principal", async () => {
    const ts = Date.now() - 1_000;
    runningModels = [{ model: "qwen-main", state: "ready", ttl: 60 }];
    insertSuccessfulUse("qwen-main", ts, "residency-owner-secret-alias");
    insertLifecycleStart("qwen-main", ts);

    const response = await getResidency(monitorKey);
    expect(response.status).toBe(200);
    const body = await response.json() as { models: Array<Record<string, unknown>> };
    expect(body).toEqual({
      models: [
        {
          model: "qwen-main",
          state: "ready",
          ttl: 60,
          classification: "ttl_retained",
          lastUse: {
            ts,
            route: "/v1/chat/completions",
            outcome: "ok",
          },
        },
      ],
    });
    expect(body.models[0]?.lastUse).not.toHaveProperty("alias");
    expect(JSON.stringify(body)).not.toContain("residency-owner-secret-alias");
  });

  it("fails closed for unauthenticated, guest, ordinary agent, and legacy user callers", async () => {
    for (const token of [undefined, guestKey, agentKey, "residency-user-static"]) {
      const response = await getResidency(token);
      expect(response.status).toBe(token === undefined ? 401 : 403);
    }
    expect(upstreamRequests.some((request) => request === "GET /running")).toBe(false);
  });

  it("returns a safe 503 without a models array when the backend snapshot is unavailable", async () => {
    runningStatus = 503;
    runningModels = [{ model: "qwen-main", state: "ready", cmd: "secret" }];

    const response = await getResidency(adminKey);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
    expect(upstreamRequests.filter((request) => request === "GET /running").length).toBeGreaterThanOrEqual(1);
    expect(upstreamRequests.some((request) => request.startsWith("POST "))).toBe(false);
  });

  it.each([[null], [{}]])("returns 503 for malformed /running entries %j", async (running) => {
    runningModels = running;

    const response = await getResidency(adminKey);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });
});
