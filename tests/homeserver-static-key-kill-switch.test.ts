import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { resetConfig } from "../src/homeserver/config.js";
import { mintKey, restrictKey, revokeKey, type KeyDefaults } from "../src/homeserver/keystore.js";
import { startGateway } from "../src/homeserver/gateway.js";
import { cmdKeys, parseArgs } from "../src/homeserver/cli.js";

/**
 * INFER-152 end-to-end: the gateway answers 401 `invalid_api_key` for a revoked key, an expired
 * key, and a static key while HOMESERVER_DISABLE_STATIC_KEYS is on; with the switch off a static
 * key still works exactly as before. Each case starts a real loopback gateway; config is rebuilt
 * from the environment per start via resetConfig().
 */

const DEFAULTS: KeyDefaults = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };
const STATIC_ADMIN = "planted-static-admin-3b7e51";
const STATIC_USER = "planted-static-user-a41c09";
const STATIC_MONITOR = "planted-static-monitor-d82f66";
const ENV_NAMES = [
  "HOMESERVER_HOST", "HOMESERVER_PORT", "HOMESERVER_ADMIN_API_KEYS", "HOMESERVER_API_KEYS",
  "HOMESERVER_MONITOR_API_KEYS", "HOMESERVER_DISABLE_STATIC_KEYS",
] as const;

const saved: Record<string, string | undefined> = {};
let stop: (() => Promise<void>) | null = null;
let port = 0;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  initDb(join(mkdtempSync(join(tmpdir(), "hs-kill-switch-")), "test.db"));
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = STATIC_ADMIN;
  process.env["HOMESERVER_API_KEYS"] = STATIC_USER;
  process.env["HOMESERVER_MONITOR_API_KEYS"] = STATIC_MONITOR;
  delete process.env["HOMESERVER_DISABLE_STATIC_KEYS"];
  logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  if (stop) await stop();
  stop = null;
  logSpy.mockRestore();
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  resetConfig();
});

async function boot(): Promise<void> {
  resetConfig();
  const handle = await startGateway();
  port = handle.port;
  stop = handle.stop;
}

function get(path: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function expect401(res: Response): Promise<void> {
  expect(res.status).toBe(401);
  expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key");
}

describe("gateway rejects retired minted keys (INFER-152)", () => {
  it("accepts a valid admin key, then 401s it once revoked", async () => {
    const minted = mintKey({ alias: "svc", tier: "owner", scope: "admin" }, DEFAULTS);
    await boot();
    expect((await get("/admin/keys", minted.plaintextKey)).status).toBe(200);

    expect(revokeKey("svc")).toBe(true);
    await expect401(await get("/admin/keys", minted.plaintextKey));
  });

  it("401s an expired key", async () => {
    const minted = mintKey({ alias: "short", tier: "owner", scope: "admin" }, DEFAULTS);
    await boot();
    expect((await get("/admin/keys", minted.plaintextKey)).status).toBe(200);

    getDb().prepare("UPDATE api_keys SET expires_at = ? WHERE alias = 'short'")
      .run("2000-01-01T00:00:00.000Z");
    await expect401(await get("/admin/keys", minted.plaintextKey));
  });

  it("restrict narrows a live key: /admin/keys goes from 200 to 403 with no key change", async () => {
    const minted = mintKey({ alias: "narrowed", tier: "owner", scope: "admin" }, DEFAULTS);
    await boot();
    expect((await get("/admin/keys", minted.plaintextKey)).status).toBe(200);

    restrictKey("narrowed", { scope: "agent" });
    const res = await get("/admin/keys", minted.plaintextKey);
    expect(res.status).toBe(403);
  });
});

describe("HOMESERVER_DISABLE_STATIC_KEYS (INFER-152)", () => {
  it("switch off (default): static admin and user keys still authenticate", async () => {
    await boot();
    expect((await get("/admin/keys", STATIC_ADMIN)).status).toBe(200);
    expect((await get("/healthz", STATIC_MONITOR)).status).toBe(200);
    expect((await get("/portal/me", STATIC_USER)).status).toBe(200);
    expect(logSpy.mock.calls.flat().join("\n")).toMatch(/kill switch HOMESERVER_DISABLE_STATIC_KEYS: off.*admin=1 user=1 monitor=1/);
  });

  it("switch on: every static key gets the same 401 as an unknown key", async () => {
    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "on";
    await boot();
    await expect401(await get("/admin/keys", STATIC_ADMIN));
    await expect401(await get("/portal/me", STATIC_USER));
    await expect401(await get("/admin/keys", "never-configured-token"));
    const monitor = await get("/ledger", STATIC_MONITOR);
    expect(monitor.status).toBe(401);

    const log = logSpy.mock.calls.flat().join("\n");
    expect(log).toMatch(/kill switch HOMESERVER_DISABLE_STATIC_KEYS: on \(admin,user,monitor\); ignoring admin=1 user=1 monitor=1/);
    for (const secret of [STATIC_ADMIN, STATIC_USER, STATIC_MONITOR]) expect(log).not.toContain(secret);
  });

  it("switch on does not affect minted keys", async () => {
    const minted = mintKey({ alias: "svc", tier: "owner", scope: "admin" }, DEFAULTS);
    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "on";
    await boot();
    expect((await get("/admin/keys", minted.plaintextKey)).status).toBe(200);
  });

  it("a per-list switch disables only the named lists", async () => {
    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "admin";
    await boot();
    await expect401(await get("/admin/keys", STATIC_ADMIN));
    expect((await get("/portal/me", STATIC_USER)).status).toBe(200);
    expect((await get("/healthz", STATIC_MONITOR)).status).toBe(200);
  });

  it("aborts startup on an invalid value without echoing it", async () => {
    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "bogus-switch-value";
    resetConfig();
    let message = "";
    try {
      await startGateway();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("HOMESERVER_DISABLE_STATIC_KEYS");
    expect(message).not.toContain("bogus-switch-value");
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("bogus-switch-value");
  });

  it("refuses a LAN bind whose only keys are disabled static keys", async () => {
    process.env["HOMESERVER_HOST"] = "0.0.0.0";
    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "on";
    resetConfig();
    await expect(startGateway()).rejects.toThrow(/no API keys/i);
  });
});

function post(path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

describe("a value shared by several lists (INFER-152 B1)", () => {
  const SHARED = "planted-shared-static-8c2d17";

  for (const disabled of ["admin", "user"] as const) {
    it(`a token in admin+user is refused everywhere when '${disabled}' is disabled`, async () => {
      process.env["HOMESERVER_ADMIN_API_KEYS"] = SHARED;
      process.env["HOMESERVER_API_KEYS"] = SHARED;
      delete process.env["HOMESERVER_MONITOR_API_KEYS"];
      process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = disabled;
      await boot();
      await expect401(await get("/admin/keys", SHARED));
      await expect401(await get("/portal/me", SHARED));
    });
  }

  it("with the switch off the shared token still authenticates (admin list wins, as before)", async () => {
    process.env["HOMESERVER_ADMIN_API_KEYS"] = SHARED;
    process.env["HOMESERVER_API_KEYS"] = SHARED;
    await boot();
    expect((await get("/admin/keys", SHARED)).status).toBe(200);
  });

  it("startup warns with a count only when a value is configured in several lists", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      process.env["HOMESERVER_ADMIN_API_KEYS"] = `${SHARED},unique-admin-only`;
      process.env["HOMESERVER_API_KEYS"] = SHARED;
      process.env["HOMESERVER_MONITOR_API_KEYS"] = SHARED;
      await boot();
      const out = warn.mock.calls.flat().join("\n");
      expect(out).toMatch(/\[auth\] 1 static credential value\(s\) are configured in more than one list/);
      expect(out).not.toContain(SHARED);
      expect(out).not.toContain("unique-admin-only");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not warn when the lists are disjoint", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await boot();
      expect(warn.mock.calls.flat().join("\n")).not.toMatch(/more than one list/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("every bearer-consuming surface honours the switch (INFER-152 N3)", () => {
  it("a disabled static key gets 401 on /mcp, /metrics and /portal/me; a live one does not", async () => {
    await boot();
    const control = await post("/mcp", STATIC_USER, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(control.status).toBe(200);
    await stop!();
    stop = null;

    process.env["HOMESERVER_DISABLE_STATIC_KEYS"] = "on";
    await boot();
    for (const token of [STATIC_ADMIN, STATIC_USER, STATIC_MONITOR]) {
      await expect401(await post("/mcp", token, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
      await expect401(await get("/metrics", token));
      await expect401(await get("/portal/me", token));
    }
  });
});

describe("the switch and lists share one configuration path (INFER-152 N1)", () => {
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;

  function withDotenv(contents: string): void {
    const dir = mkdtempSync(join(tmpdir(), "hs-dotenv-"));
    writeFileSync(join(dir, ".env"), contents);
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(dir);
  }

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
  });

  it("a switch set only in .env takes effect for the gateway", async () => {
    for (const name of ENV_NAMES) delete process.env[name];
    process.env["HOMESERVER_HOST"] = "127.0.0.1";
    process.env["HOMESERVER_PORT"] = "0";
    withDotenv("HOMESERVER_ADMIN_API_KEYS=dotenv-admin-token\nHOMESERVER_API_KEYS=dotenv-user-token\nHOMESERVER_DISABLE_STATIC_KEYS=admin\n");
    await boot();
    await expect401(await get("/admin/keys", "dotenv-admin-token"));
    expect((await get("/portal/me", "dotenv-user-token")).status).toBe(200);
  });

  it("inventory counts and the switch come from the same .env", () => {
    for (const name of ENV_NAMES) delete process.env[name];
    withDotenv("HOMESERVER_ADMIN_API_KEYS=aaa-planted,bbb-planted\nHOMESERVER_DISABLE_STATIC_KEYS=admin\n");
    const out = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      cmdKeys(parseArgs(["inventory", "--static", "--json"]));
      const text = out.mock.calls.flat().join("\n");
      const report = JSON.parse(text).legacyStaticCredentialCounts;
      expect(report.counts).toMatchObject({ admin: 2, total: 2 });
      expect(report.killSwitch.admin).toBe(true);
      expect(report.note).toMatch(/THIS process/);
      expect(text).not.toMatch(/planted/);
    } finally {
      out.mockRestore();
    }
  });
});
