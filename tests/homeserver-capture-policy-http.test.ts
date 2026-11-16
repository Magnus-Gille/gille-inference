import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb } from "../src/db.js";

/** INFER-344: GET /portal/capture-policy over the real gateway (no inference, no log access). */

let port = 0;
let stop: (() => Promise<void>) | null = null;
const keys: Record<string, string> = {};
const LIMITS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-cap-policy-")), "test.db"));
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_OWNER_REQUEST_LOG"] = "on";
  delete process.env["HOMESERVER_API_KEYS"];
  delete process.env["HOMESERVER_ADMIN_API_KEYS"];
  const ks = await import("../src/homeserver/keystore.js");
  keys["agent"] = ks.mintKey({ alias: "cp-agent-ALIAS", tier: "owner", scope: "agent" }, LIMITS).plaintextKey;
  keys["ask"] = ks.mintKey({ alias: "cp-ask", tier: "owner", scope: "ask" }, LIMITS).plaintextKey;
  keys["guest"] = ks.mintKey({ alias: "cp-guest", tier: "guest", scope: "inference" }, LIMITS).plaintextKey;
  const gw = await import("../src/homeserver/gateway.js");
  const h = await gw.startGateway();
  port = h.port;
  stop = h.stop;
});
afterAll(async () => { if (stop) await stop(); });

const get = (key: string | null) =>
  fetch(`http://127.0.0.1:${port}/portal/capture-policy`, key ? { headers: { authorization: `Bearer ${key}` } } : {});

describe("GET /portal/capture-policy", () => {
  it("requires authentication", async () => {
    expect((await get(null)).status).toBe(401);
  });

  it("owner agent: content on chat/ask, no-store, content-free", async () => {
    const res = await get(keys["agent"]!);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.principal).toEqual({ tier: "owner", scope: "agent" });
    expect(body.routes.chat.capture).toBe("content");
    expect(body.routes.chat.retention.horizon_days).toBe("unknown");
    expect(body.routes.code_loop.available).toBe(true);
    expect(text).not.toContain("ALIAS");
    expect(text).not.toContain(keys["agent"]!);
  });

  it("guest: metadata only, never content", async () => {
    const body = await (await get(keys["guest"]!)).json();
    expect(body.principal).toEqual({ tier: "guest", scope: "inference" });
    expect(body.routes.chat.capture).toBe("metadata_only");
    expect(body.routes.code_loop.available).toBe(false);
  });

  it("ask scope may use the preflight (closed allow-list includes it)", async () => {
    const res = await get(keys["ask"]!);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.routes.ask.capture).toBe("content");
    expect(body.routes.chat.available).toBe(false);
  });
});
