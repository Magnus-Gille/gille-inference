import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * Auth-bypass regression suite (Fix #1).
 *
 * This file deliberately runs the gateway in the *keystore-only* configuration:
 * HOMESERVER_API_KEYS / HOMESERVER_ADMIN_API_KEYS are UNSET, but at least one store key is
 * minted. In that configuration an unauthenticated request must NOT be granted implicit
 * admin — the implicit-admin bootstrap is only safe when there are truly zero credentials.
 *
 * It must use its own process (env + DB + module graph), because config is read once and
 * cached at first import, and the env here is incompatible with the spine suite's env.
 */

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "cmpl-1",
          choices: [{ message: { role: "assistant", content: "ok" } }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        })
      );
    });
  });
  return new Promise((resolve) =>
    upstream.listen(0, "127.0.0.1", () => {
      upstreamPort = (upstream.address() as { port: number }).port;
      resolve();
    })
  );
}

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-auth-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  // Critically: NO static keys configured. Only a minted store key exists.
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  // Mint a store key BEFORE startGateway so listKeys() is non-empty at bind time.
  ks.mintKey({ alias: "auth-test-owner", tier: "owner" }, {
    rpm: 1000,
    tpm: 1_000_000,
    dailyTokenBudget: 0,
    maxParallel: 2,
  });

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

describe("gateway auth bypass — keystore-only config (Fix #1)", () => {
  it("no-token request to /admin/keys is 401, NOT implicit admin", async () => {
    const res = await fetch(url("/admin/keys"), { method: "GET" });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });

  it("no-token request to /v1/chat/completions is 401, NOT served", async () => {
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
    const j = (await res.json()) as { error: { code: string } };
    expect(j.error.code).toBe("invalid_api_key");
  });
});
