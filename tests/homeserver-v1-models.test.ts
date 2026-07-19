import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * GET /v1/models — OpenAI-compatible model listing, filtered to the key's allow-list.
 * Backed by a stub llama-swap (serves /v1/models + /running) via the llamaswap backend.
 */

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = req.url || "";
    if (u.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "alpha" }, { id: "beta" }, { id: "gamma" }] }));
      return;
    }
    if (u.startsWith("/running")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "c", choices: [{ message: { role: "assistant", content: "ok" } }], usage: { total_tokens: 1 } }));
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
let ownerKey = "";
let guestKey = "";
const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-v1models-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  ownerKey = ks.mintKey({ alias: "v1models-owner", tier: "owner" }, DEFAULTS).plaintextKey;
  guestKey = ks.mintKey({ alias: "v1models-guest", tier: "guest", modelAllowList: ["alpha"] }, DEFAULTS).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
});

const url = (path: string): string => `http://127.0.0.1:${gatewayPort}${path}`;

describe("GET /v1/models (OpenAI-compatible, allow-list filtered)", () => {
  it("returns the OpenAI list shape for an unrestricted (owner) key", async () => {
    const r = await fetch(url("/v1/models"), { headers: { Authorization: `Bearer ${ownerKey}` } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { object: string; data: Array<{ id: string; object: string; owned_by: string }> };
    expect(j.object).toBe("list");
    // The chat models from the backend, plus the speech-to-text model (whisper-1) which the
    // gateway advertises for any key permitted to use it (empty allow-list = all).
    expect(j.data.map((m) => m.id).sort()).toEqual(["alpha", "beta", "gamma", "whisper-1"]);
    expect(j.data[0]!.object).toBe("model");
    expect(j.data[0]!.owned_by).toBe("home-gateway");
  });

  it("filters to the key's model allow-list", async () => {
    const r = await fetch(url("/v1/models"), { headers: { Authorization: `Bearer ${guestKey}` } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { data: Array<{ id: string }> };
    expect(j.data.map((m) => m.id)).toEqual(["alpha"]);
  });

  it("rejects an unauthenticated request", async () => {
    const r = await fetch(url("/v1/models"));
    expect(r.status).toBe(401);
  });
});
