import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * Integration coverage for bench/maintenance mode (#108) over the live gateway:
 *   • /admin/maintenance is admin-gated (guest → 403) and returns the status schema.
 *   • POST validates the body — missing / non-boolean / a bare JSON `null` all → 400 (not 500).
 *   • Toggling {on:true} makes a GUEST /v1/chat/completions return 503 server_busy with the
 *     configured Retry-After, while an OWNER request is still served; {on:false} restores guests.
 * Runs in its own process (vitest isolates files), with its own DB + env + module graph.
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

const RETRY_AFTER = 17; // distinctive value so the header assertion is unambiguous
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-maint-test-"));
  initDb(join(dir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_MAINTENANCE_RETRY_AFTER_S"] = String(RETRY_AFTER);
  // Boot with maintenance OFF; the tests engage it at runtime via the admin route.
  delete process.env["HOMESERVER_MAINTENANCE_MODE"];
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  const defs = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
  ownerKey = ks.mintKey({ alias: "maint-owner", tier: "owner" }, defs).plaintextKey;
  // Guest needs the model on its allow-list to be served when maintenance is off.
  guestKey = ks.mintKey({ alias: "maint-guest", tier: "guest", modelAllowList: ["m1"] }, defs).plaintextKey;

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

describe("/admin/maintenance — admin gating + body validation (#108)", () => {
  afterAll(async () => {
    await setMaintenance(ownerKey, false); // leave the box un-reserved for sibling describes
  });

  it("GET as a guest is 403 (admin-only)", async () => {
    const res = await fetch(url("/admin/maintenance"), { method: "GET", headers: auth(guestKey) });
    expect(res.status).toBe(403);
  });

  it("POST as a guest is 403 (admin-only)", async () => {
    const res = await setMaintenance(guestKey, true);
    expect(res.status).toBe(403);
  });

  it("GET as owner returns the status schema, maintenance:false at boot", async () => {
    const res = await fetch(url("/admin/maintenance"), { method: "GET", headers: auth(ownerKey) });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { maintenance: boolean; maxInflight: number };
    expect(j.maintenance).toBe(false);
    expect(typeof j.maxInflight).toBe("number");
  });

  it("POST {on:true} as owner flips it on and echoes the new state", async () => {
    const res = await setMaintenance(ownerKey, true);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { maintenance: boolean };
    expect(j.maintenance).toBe(true);
    await setMaintenance(ownerKey, false);
  });

  for (const [label, body] of [
    ["missing on", "{}"],
    ["non-boolean on", '{"on":"yes"}'],
    ["a bare null body", "null"],
    ["a JSON array body", "[1,2]"],
  ] as const) {
    it(`POST with ${label} → 400 (never a 500)`, async () => {
      const res = await fetch(url("/admin/maintenance"), {
        method: "POST",
        headers: auth(ownerKey),
        body,
      });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: { code: string } };
      expect(j.error.code).toBe("invalid_request_error");
    });
  }
});

describe("maintenance mode gates guest traffic on the live route (#108)", () => {
  afterAll(async () => {
    await setMaintenance(ownerKey, false);
  });

  it("guest chat is served when maintenance is off", async () => {
    await setMaintenance(ownerKey, false);
    const res = await chat(guestKey);
    expect(res.status).toBe(200);
  });

  it("guest chat is 503 server_busy with the configured Retry-After when on; owner still served", async () => {
    await setMaintenance(ownerKey, true);

    const g = await chat(guestKey);
    expect(g.status).toBe(503);
    expect(g.headers.get("retry-after")).toBe(String(RETRY_AFTER));
    const gj = (await g.json()) as { error: { code: string } };
    expect(gj.error.code).toBe("server_busy");

    const o = await chat(ownerKey);
    expect(o.status).toBe(200); // owners are never blocked by maintenance

    await setMaintenance(ownerKey, false);
    const again = await chat(guestKey);
    expect(again.status).toBe(200); // toggling off restores guest service
  });
});

// #105 follow-up: an unattended batch job (weekly Model Scout) engages maintenance mode around
// an ephemeral GPU test window via this exact HTTP route. ttlSeconds is the crash-safety net —
// if the job dies before it can POST {on:false}, guests must not stay locked out forever.
describe("/admin/maintenance ttlSeconds — auto-expiry safety net (#105)", () => {
  afterAll(async () => {
    await setMaintenance(ownerKey, false);
  });

  async function setMaintenanceWithTtl(key: string, on: boolean, ttlSeconds: number): Promise<Response> {
    return fetch(url("/admin/maintenance"), {
      method: "POST",
      headers: auth(key),
      body: JSON.stringify({ on, ttlSeconds }),
    });
  }

  it("accepts ttlSeconds and echoes maintenance:true immediately", async () => {
    const res = await setMaintenanceWithTtl(ownerKey, true, 60);
    expect(res.status).toBe(200);
    const j = (await res.json()) as { maintenance: boolean };
    expect(j.maintenance).toBe(true);
    await setMaintenance(ownerKey, false);
  });

  for (const bad of [-1, 0, NaN, Infinity, "60"]) {
    it(`rejects an invalid ttlSeconds (${String(bad)}) with 400, never a 500`, async () => {
      const res = await fetch(url("/admin/maintenance"), {
        method: "POST",
        headers: auth(ownerKey),
        body: JSON.stringify({ on: true, ttlSeconds: bad }),
      });
      expect(res.status).toBe(400);
      const j = (await res.json()) as { error: { code: string } };
      expect(j.error.code).toBe("invalid_request_error");
    });
  }

  it("self-expires and lets guest traffic back in with NO further calls (simulated crashed job)", async () => {
    await setMaintenanceWithTtl(ownerKey, true, 0.05); // 50ms — deliberately never turned off again

    const blocked = await chat(guestKey);
    expect(blocked.status).toBe(503);

    await new Promise((r) => setTimeout(r, 150));

    const recovered = await chat(guestKey);
    expect(recovered.status).toBe(200);
  });

  // A caller that mirrors the same JSON shape for both on/off calls (e.g. always includes
  // ttlSeconds) must not get spuriously rejected turning maintenance OFF — ttlSeconds is
  // provably irrelevant when on:false (admission.ts discards it), so validating it here would
  // reject a semantically-valid request for no reason.
  for (const irrelevant of [0, -1, NaN, "60"]) {
    it(`ignores an invalid ttlSeconds (${String(irrelevant)}) when on:false — never 400s`, async () => {
      const res = await setMaintenanceWithTtl(ownerKey, false, irrelevant as number);
      expect(res.status).toBe(200);
      const j = (await res.json()) as { maintenance: boolean };
      expect(j.maintenance).toBe(false);
    });
  }
});
