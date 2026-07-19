import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/**
 * Fix #2 (HIGH-1) — per-IP throttle on the unauthenticated public surface.
 *
 * Isolated suite: a LOW HOMESERVER_REDEEM_RPM is set BEFORE importing config/gateway (config is
 * cached at first import), so the (N+1)th redeem from one IP inside the window returns 429. The
 * config-cached-once constraint is why this lives in its own file rather than the portal suite
 * (which deliberately runs with a high limit). The window throttles by client IP — all requests
 * here originate from 127.0.0.1, i.e. one bucket.
 */

const LIMIT = 3; // HOMESERVER_REDEEM_RPM for this suite

let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-throttle-test-"));
  initDb(join(dir, "test.db"));

  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_REDEEM_RPM"] = String(LIMIT);
  process.env["HOMESERVER_PUBLIC_WINDOW_MS"] = "600000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  // Point LM Studio somewhere harmless — no inference runs in this suite.
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1";

  const ks = await import("../src/homeserver/keystore.js");
  mintKey = ks.mintKey;
  // Seed a store key so the gateway does not bootstrap implicit-admin on loopback.
  mintKey({ alias: "throttle-seed-owner", tier: "owner" }, { rpm: 60, tpm: 60_000, dailyTokenBudget: 0, maxParallel: 1 });

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

function redeem(): Promise<Response> {
  return fetch(url("/portal/redeem"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    // An invalid code: the throttle gate runs BEFORE redemption, so the code never matters.
    body: JSON.stringify({ code: "inv_never-valid" }),
  });
}

describe("per-IP redeem throttle (Fix #2 / HIGH-1)", () => {
  it("the (N+1)th redeem from one IP within the window → 429 with Retry-After", async () => {
    // First LIMIT attempts pass the throttle (they fail redemption itself with 409, not 429).
    for (let i = 0; i < LIMIT; i++) {
      const r = await redeem();
      expect(r.status).not.toBe(429);
    }
    // The very next attempt is throttled.
    const blocked = await redeem();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const j = (await blocked.json()) as { error: { code: string; type: string } };
    expect(j.error.code).toBe("rate_limit_exceeded");
    expect(j.error.type).toBe("rate_limit_error");
  });
});
