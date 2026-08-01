import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../src/db.js";
import { resetConfig } from "../src/homeserver/config.js";
import { recordDelegation } from "../src/homeserver/ledger.js";

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

const touchedEnv = [
  "LMSTUDIO_BASE_URL",
  "HOMESERVER_BACKEND",
  "HOMESERVER_HOST",
  "HOMESERVER_PORT",
  "HOMESERVER_API_KEYS",
  "HOMESERVER_ADMIN_API_KEYS",
  "HOMESERVER_MONITOR_API_KEYS",
  "HOMESERVER_KEY_DEFAULT_RPM",
  "HOMESERVER_KEY_DEFAULT_TPM",
] as const;
const savedEnv = new Map<string, string | undefined>();
for (const key of touchedEnv) savedEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of touchedEnv) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetConfig();
});

async function canBindLoopback(): Promise<boolean> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    return true;
  } catch {
    return false;
  } finally {
    if (probe.listening) {
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    }
  }
}

const LOOPBACK_AVAILABLE = await canBindLoopback();
const itIfLoopback = LOOPBACK_AVAILABLE ? it : it.skip;

async function startModelStub(): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "m1", object: "model" }] }));
      return;
    }
    if (req.url?.includes("/running")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [{ model: "m1", state: "ready", cmd: "-c 4096" }] }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  return { server, port };
}

interface GatewaySetupResult {
  token?: string;
  ownerMonitorToken?: string;
}

interface GatewayRunContext extends GatewaySetupResult {
  url: (path: string) => string;
}

async function withGateway(
  setup: () => Promise<GatewaySetupResult>,
  run: (ctx: GatewayRunContext) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "hs-reviewer-usefulness-smoke-"));
  initDb(join(dir, "test.db"));
  const upstream = await startModelStub();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstream.port}/v1`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  resetConfig();

  const setupResult = await setup();
  const { startGateway } = await import("../src/homeserver/gateway.js");
  const handle = await startGateway();
  try {
    await run({
      url: (path) => `http://127.0.0.1:${handle.port}${path}`,
      token: setupResult.token,
      ownerMonitorToken: setupResult.ownerMonitorToken,
    });
  } finally {
    await handle.stop();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
}

describe("PUT /ledger/:id/reviewer-usefulness — real socket smoke", () => {
  itIfLoopback("requires a minted owner-admin key on the live socket path", async () => {
    await withGateway(
      async () => {
        process.env["HOMESERVER_ADMIN_API_KEYS"] = "static-admin-key";
        delete process.env["HOMESERVER_API_KEYS"];
        delete process.env["HOMESERVER_MONITOR_API_KEYS"];
        const { mintKey } = await import("../src/homeserver/keystore.js");
        const minted = mintKey({ alias: "reviewer-smoke-admin", tier: "owner", scope: "admin" }, DEFAULTS);
        return { token: minted.plaintextKey };
      },
      async ({ url, token }) => {
        const ledgerId = recordDelegation({
          taskType: "review-bounded",
          modelId: "m1",
          prompt: "gille review-bounded contract v1 ...",
          outcome: "pass",
          verifier: "reviewBoundedVerifier",
        });

        const ok = await fetch(url(`/ledger/${ledgerId}/reviewer-usefulness`), {
          method: "PUT",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ usefulness: "pass", notes: "ref:gille-inference#112 check:manual" }),
        });
        expect(ok.status).toBe(201);

        const staticAdmin = await fetch(url(`/ledger/${ledgerId}/reviewer-usefulness`), {
          method: "PUT",
          headers: {
            authorization: "Bearer static-admin-key",
            "content-type": "application/json",
          },
          body: JSON.stringify({ usefulness: "pass" }),
        });
        expect(staticAdmin.status).toBe(403);
      },
    );
  });

  itIfLoopback("denies loopback implicit-admin on the live socket path", async () => {
    await withGateway(
      async () => {
        delete process.env["HOMESERVER_ADMIN_API_KEYS"];
        delete process.env["HOMESERVER_API_KEYS"];
        delete process.env["HOMESERVER_MONITOR_API_KEYS"];
        return {};
      },
      async ({ url }) => {
        const ledgerId = recordDelegation({
          taskType: "review-bounded",
          modelId: "m1",
          prompt: "gille review-bounded contract v1 ...",
          outcome: "pass",
          verifier: "reviewBoundedVerifier",
        });

        const res = await fetch(url(`/ledger/${ledgerId}/reviewer-usefulness`), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ usefulness: "pass" }),
        });
        expect(res.status).toBe(403);
      },
    );
  });

  itIfLoopback("keeps review-lane capability coverage on the real socket path", async () => {
    await withGateway(
      async () => {
        process.env["HOMESERVER_ADMIN_API_KEYS"] = "static-admin-key";
        delete process.env["HOMESERVER_API_KEYS"];
        delete process.env["HOMESERVER_MONITOR_API_KEYS"];
        const { mintKey } = await import("../src/homeserver/keystore.js");
        const mintedAdmin = mintKey({ alias: "review-lane-smoke-admin", tier: "owner", scope: "admin" }, DEFAULTS);
        const mintedOwnerMonitor = mintKey({ alias: "review-lane-smoke-owner-monitor", tier: "owner", scope: "monitor" }, DEFAULTS);
        return { token: mintedAdmin.plaintextKey, ownerMonitorToken: mintedOwnerMonitor.plaintextKey };
      },
      async ({ url, token, ownerMonitorToken }) => {
        const owner = await fetch(url("/v1/capabilities/review-lane"), {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(owner.status).toBe(200);
        expect(await owner.json()).toMatchObject({
          endpoint: "/v1/capabilities/review-lane",
          reviewerUsefulnessRecording: {
            available: true,
            authorization: "minted-owner-admin",
            availabilityReason: "allowed",
          },
        });

        const ownerMonitor = await fetch(url("/v1/capabilities/review-lane"), {
          headers: { authorization: `Bearer ${ownerMonitorToken}` },
        });
        expect(ownerMonitor.status).toBe(403);
        expect(await ownerMonitor.json()).toMatchObject({
          error: {
            code: "route_not_allowed",
          },
        });
      },
    );
  });
});
