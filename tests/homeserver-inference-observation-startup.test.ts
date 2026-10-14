import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, getDb } from "../src/db.js";
import { mintKey } from "../src/homeserver/keystore.js";
import { resetConfig } from "../src/homeserver/config.js";
import { startGateway } from "../src/homeserver/gateway.js";

let stop: (() => Promise<void>) | null = null;
afterEach(async () => { if (stop) await stop(); stop = null; });

async function firstObservation(legacy: boolean, enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "observation-startup-"));
  initDb(join(dir, "fixture.sqlite"));
  if (legacy) {
    // An empty pre-node/filter-epoch collector table, before its existing lazy migration.
    getDb().exec("CREATE TABLE request_log (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, alias TEXT, tier TEXT, key_hash TEXT, model TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, outcome TEXT NOT NULL, error_class TEXT, prompt_tokens INTEGER, completion_tokens INTEGER, total_tokens INTEGER, queue_wait_ms INTEGER, ttft_ms INTEGER, total_ms INTEGER NOT NULL, admission TEXT)");
  }
  expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'request_log'").get() !== undefined).toBe(legacy);
  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:9";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_REQUEST_LOG"] = enabled ? "on" : "off";
  process.env["HOMESERVER_ACCESS_LOG"] = "off";
  process.env["HOMESERVER_GPU_LEASE_DIR"] = join(dir, "leases");
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  const key = mintKey({ alias: "synthetic-startup-owner", tier: "owner", scope: "agent" },
    { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 }).plaintextKey;
  resetConfig();
  const gateway = await startGateway();
  stop = gateway.stop;
  const response = await fetch("http://127.0.0.1:" + gateway.port + "/portal/me", {
    headers: { authorization: "Bearer " + key },
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ inferenceObservation: unknown }>;
}

describe("first owner inference-history observation", () => {
  it.each([false, true])("initializes the enabled collector before reading a fresh/legacy database (%s)", async (legacy) => {
    const body = await firstObservation(legacy);
    expect(body.inferenceObservation).toEqual({
      source: "request_log", scope: "m5_global", status: "none", lastSuccessfulAt: null,
    });
  });

  it("does not initialize or query disabled telemetry on the first request", async () => {
    const body = await firstObservation(false, false);
    expect(body.inferenceObservation).toEqual({
      source: "request_log", scope: "m5_global", status: "disabled", lastSuccessfulAt: null,
    });
    expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name = 'request_log'").get()).toBeUndefined();
  });
});
