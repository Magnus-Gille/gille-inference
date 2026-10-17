import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";
import { resetConfig } from "../src/homeserver/config.js";

/**
 * The startup-exclusive fence is a process-start safety boundary.  It must cover every
 * inference lane until its operator-declared UTC deadline, survive a gateway restart, and
 * remain independent of the mutable maintenance/window controls.
 */

let upstream: Server;
let upstreamPort = 0;
let upstreamInferenceCalls = 0;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";

const envKeys = [
  "LMSTUDIO_BASE_URL",
  "HOMESERVER_HOST",
  "HOMESERVER_PORT",
  "HOMESERVER_MAX_INFLIGHT",
  "HOMESERVER_PER_REQUEST_MAX_TOKENS",
  "HOMESERVER_KEY_DEFAULT_RPM",
  "HOMESERVER_KEY_DEFAULT_TPM",
  "HOMESERVER_MAINTENANCE_RETRY_AFTER_S",
  "HOMESERVER_MAINTENANCE_MODE",
  "HOMESERVER_STARTUP_EXCLUSIVE_UNTIL",
  "HOMESERVER_API_KEYS",
  "HOMESERVER_ADMIN_API_KEYS",
] as const;
const previousEnv = new Map<string, string | undefined>();

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions") upstreamInferenceCalls += 1;
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "m1", object: "model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl-startup-fence",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }));
    });
  });
  return new Promise((resolve) => upstream.listen(0, "127.0.0.1", () => {
    upstreamPort = (upstream.address() as { port: number }).port;
    resolve();
  }));
}

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}`, "content-type": "application/json" };
}

function chat(key: string): Promise<Response> {
  return fetch(url("/v1/chat/completions"), {
    method: "POST",
    headers: auth(key),
    body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
  });
}

async function setMaintenance(key: string, on: boolean): Promise<Response> {
  return fetch(url("/admin/maintenance"), {
    method: "POST",
    headers: auth(key),
    body: JSON.stringify({ on }),
  });
}

async function maintenanceStatus(): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url("/admin/maintenance"), {
    method: "GET",
    headers: auth(ownerKey),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function openWindow(): Promise<{ status: number; token: string }> {
  const response = await fetch(url("/admin/maintenance/window"), {
    method: "POST",
    headers: auth(ownerKey),
    body: JSON.stringify({ action: "open", ttlSeconds: 60, drainTimeoutSeconds: 1 }),
  });
  const body = await response.json() as { token?: string };
  return { status: response.status, token: body.token ?? "" };
}

async function closeWindow(token: string): Promise<Response> {
  return fetch(url("/admin/maintenance/window"), {
    method: "POST",
    headers: auth(ownerKey),
    body: JSON.stringify({ action: "close", token }),
  });
}

beforeAll(async () => {
  for (const key of envKeys) previousEnv.set(key, process.env[key]);

  const dir = mkdtempSync(join(tmpdir(), "hs-startup-exclusive-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_MAINTENANCE_RETRY_AFTER_S"] = "17";
  process.env["HOMESERVER_STARTUP_EXCLUSIVE_UNTIL"] = new Date(Date.now() + 60_000).toISOString();
  delete process.env["HOMESERVER_MAINTENANCE_MODE"];
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  resetConfig();

  const ks = await import("../src/homeserver/keystore.js");
  const defs = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
  ownerKey = ks.mintKey({ alias: "startup-exclusive-owner", tier: "owner", scope: "admin" }, defs).plaintextKey;
  guestKey = ks.mintKey({ alias: "startup-exclusive-guest", tier: "guest", modelAllowList: ["m1"] }, defs).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway({
    maintenanceWindowDependencies: {
      acquireLease: async () => ({ release: async () => {} }),
      observeRunning: async () => [{ model: "m1", state: "ready", ttlSeconds: 30 }],
    },
  });
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  for (const key of envKeys) {
    const previous = previousEnv.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
  resetConfig();
});

describe("startup exclusive maintenance fence", () => {
  it("blocks both lanes, survives mutable controls, and remains after a same-env restart", async () => {
    const initial = await maintenanceStatus();
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ maintenance: true, mode: "exclusive" });

    expect((await chat(ownerKey)).status).toBe(503);
    expect((await chat(guestKey)).status).toBe(503);
    expect(upstreamInferenceCalls).toBe(0);

    const disabled = await setMaintenance(ownerKey, false);
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ maintenance: true, mode: "exclusive" });
    expect((await maintenanceStatus()).body).toMatchObject({ maintenance: true, mode: "exclusive" });

    const opened = await openWindow();
    expect(opened.status).toBe(201);
    expect(opened.token).toHaveLength(36);
    expect((await chat(ownerKey)).status).toBe(503);
    const closed = await closeWindow(opened.token);
    expect(closed.status).toBe(200);
    expect((await maintenanceStatus()).body).toMatchObject({ maintenance: true, mode: "exclusive" });
    expect((await chat(ownerKey)).status).toBe(503);
    expect((await chat(guestKey)).status).toBe(503);
    expect(upstreamInferenceCalls).toBe(0);

    await stopGateway!();
    stopGateway = null;
    resetConfig();
    const gw = await import("../src/homeserver/gateway.js");
    const restarted = await gw.startGateway({
      maintenanceWindowDependencies: {
        acquireLease: async () => ({ release: async () => {} }),
        observeRunning: async () => [{ model: "m1", state: "ready", ttlSeconds: 30 }],
      },
    });
    gatewayPort = restarted.port;
    stopGateway = restarted.stop;

    const afterRestart = await maintenanceStatus();
    expect(afterRestart.status).toBe(200);
    expect(afterRestart.body).toMatchObject({ maintenance: true, mode: "exclusive" });
    expect((await chat(ownerKey)).status).toBe(503);
    expect((await chat(guestKey)).status).toBe(503);
    expect(upstreamInferenceCalls).toBe(0);

    // The operator's final restart removes only the startup override after manager work ends.
    await stopGateway!();
    stopGateway = null;
    delete process.env["HOMESERVER_STARTUP_EXCLUSIVE_UNTIL"];
    resetConfig();
    const restored = await gw.startGateway({
      maintenanceWindowDependencies: {
        acquireLease: async () => ({ release: async () => {} }),
        observeRunning: async () => [{ model: "m1", state: "ready", ttlSeconds: 30 }],
      },
    });
    gatewayPort = restored.port;
    stopGateway = restored.stop;
    expect((await maintenanceStatus()).body).toMatchObject({ maintenance: false, mode: "off" });
    expect((await chat(ownerKey)).status).toBe(200);
    expect((await chat(guestKey)).status).toBe(200);
    expect(upstreamInferenceCalls).toBe(2);
  });
});
