/**
 * Integration coverage for POST /admin/routing-table/reload (issue #7) over the live gateway:
 *   • admin-gated (guest → 403), same requireAdmin() idiom as every other /admin route.
 *   • genuinely reloads a MODIFIED docs/m5-routing.json without a process restart — proves the
 *     "gateway adoption does not depend on an undocumented manual restart" AC by writing a new file
 *     to disk, hitting the endpoint, and observing routingTarget() (the SAME reader the T3
 *     macro-router uses) reflect the change in this same live process.
 *   • a corrupt table on disk is a 500, never a process crash — the gateway keeps serving other
 *     routes afterward.
 * The default-path file read is redirected to a real private temporary file in this test worker.
 * Reload and corrupt-file handling use the real loader and HTTP endpoint while parallel suites
 * can continue reading the committed routing table. No production path override is introduced.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initDb } from "../src/db.js";

const REAL_TABLE_PATH = resolve(__dirname, "../docs/m5-routing.json");
const routingFiles = vi.hoisted(() => ({ real: "", fixture: "" }));
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: new Proxy(actual.readFileSync, {
    apply(target, thisArg, args) {
      if (routingFiles.fixture !== "" && args[0] === routingFiles.real) args[0] = routingFiles.fixture;
      return Reflect.apply(target, thisArg, args);
    },
  }) };
});

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let ownerKey = "";
let guestKey = "";
let originalBytes = "";

beforeAll(async () => {
  originalBytes = readFileSync(REAL_TABLE_PATH, "utf8");

  const dir = mkdtempSync(join(tmpdir(), "hs-routing-reload-gw-test-"));
  routingFiles.real = REAL_TABLE_PATH;
  routingFiles.fixture = join(dir, "m5-routing.json");
  writeFileSync(routingFiles.fixture, originalBytes, "utf8");
  initDb(join(dir, "test.db"));

  process.env["LMSTUDIO_BASE_URL"] = "http://127.0.0.1:1/v1"; // unused by this route
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];

  const ks = await import("../src/homeserver/keystore.js");
  const defs = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
  ownerKey = ks.mintKey({ alias: "routing-reload-owner", tier: "owner", scope: "admin" }, defs).plaintextKey;
  guestKey = ks.mintKey({ alias: "routing-reload-guest", tier: "guest", modelAllowList: ["m1"] }, defs).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  writeFileSync(routingFiles.fixture, originalBytes, "utf8");
  const rt = await import("../src/homeserver/routing-table.js");
  rt.resetRoutingTable();
  if (stopGateway) await stopGateway();
  routingFiles.fixture = "";
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}
function auth(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

function postReload(key: string): Promise<Response> {
  return fetch(url("/admin/routing-table/reload"), { method: "POST", headers: auth(key) });
}

describe("POST /admin/routing-table/reload (#7)", () => {
  it("is admin-gated — a guest key gets 403 and the live table is untouched", async () => {
    const res = await postReload(guestKey);
    expect(res.status).toBe(403);
  });

  it("reloads a modified docs/m5-routing.json WITHOUT a process restart", async () => {
    const rt = await import("../src/homeserver/routing-table.js");
    const before = JSON.parse(originalBytes) as { routing: Record<string, unknown>; escalateToFrontier: string[] };
    const modified = {
      ...before,
      generatedAt: "2026-07-20T23:00:00.000Z",
      routing: {
        ...before.routing,
        "routing-reload-canary-probe": { model: "mellum", passRate: 1, tokPerSec: 100, verdict: "delegate-local", attempts: 1 },
      },
    };
    writeFileSync(routingFiles.fixture, JSON.stringify(modified, null, 2) + "\n", "utf8");

    try {
      const res = await postReload(ownerKey);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { reloaded: boolean; routableTaskTypes: number };
      expect(body.reloaded).toBe(true);

      // The proof: routingTarget() — the SAME reader the T3 macro-router consumes — now resolves
      // the new task type, in THIS SAME live process, with no restart between the write and here.
      expect(rt.routingTarget("routing-reload-canary-probe")).toBe("mellum");
    } finally {
      writeFileSync(routingFiles.fixture, originalBytes, "utf8");
      rt.resetRoutingTable();
      await postReload(ownerKey); // restore the live process's view too
    }
  });

  it("a corrupt table on disk is a 500, never a process crash — the gateway keeps serving", async () => {
    const rt = await import("../src/homeserver/routing-table.js");
    writeFileSync(routingFiles.fixture, "{ not valid json", "utf8");
    try {
      const res = await postReload(ownerKey);
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("internal_error");
      // Parallel readers must never see this test's intentionally broken bytes.
      expect(await readFile(REAL_TABLE_PATH, "utf8")).toBe(originalBytes);

      // The gateway process itself is still alive and serving other admin routes.
      const health = await fetch(url("/admin/keys"), { headers: auth(ownerKey) });
      expect(health.status).toBe(200);
    } finally {
      writeFileSync(routingFiles.fixture, originalBytes, "utf8");
      rt.resetRoutingTable();
      await postReload(ownerKey);
    }
  });
});
