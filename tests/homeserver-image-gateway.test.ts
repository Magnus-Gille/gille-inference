import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import { getRequestLog } from "../src/homeserver/request-log.js";
import { getOwnerLog } from "../src/homeserver/owner-log.js";
import { renderMetrics } from "../src/homeserver/metrics.js";

/**
 * POST /v1/images/generations (+ async job GET/DELETE) — OpenAI-compatible text→image.
 *
 * A MOCK image sidecar stands in for the box's sd-server. SECRET_PROMPT_MARKER proves the prompt
 * never lands in request_log / metrics / a guest's owner-log.
 */

const SECRET_PROMPT_MARKER = "ZZZ_SECRET_IMAGE_PROMPT_ that must never be logged ZZZ";
const FAST = 100, BALANCED = 200, HIGH = 300; // credits per image, per tier

let sidecar: Server;
let sidecarPort = 0;
let gateEnabled = false;
let releaseGate: (() => void) | null = null;
let mode: "ok" | "fault" | "empty" = "ok";
let sidecarHits = 0;

function startSidecar(): Promise<void> {
  sidecar = createServer((req: IncomingMessage, res: ServerResponse) => {
    const u = req.url || "";
    // Also stand in for the chat backend (llama-swap) so GET /v1/models works in this suite.
    if (req.method === "GET" && u.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "alpha" }] }));
      return;
    }
    if (req.method === "GET" && u.startsWith("/running")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      sidecarHits++;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { n?: number };
      if (gateEnabled) await new Promise<void>((resolve) => (releaseGate = resolve));
      if (mode === "fault") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      const n = body.n ?? 1;
      const data = mode === "empty"
        ? []
        : Array.from({ length: n }, (_, i) => ({ b64_json: Buffer.from(`png-${i}`).toString("base64") }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ created: 0, data }));
    });
  });
  return new Promise((resolve) =>
    sidecar.listen(0, "127.0.0.1", () => {
      sidecarPort = (sidecar.address() as { port: number }).port;
      resolve();
    })
  );
}

let startGateway: typeof import("../src/homeserver/gateway.js").startGateway;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let lookupKey: typeof import("../src/homeserver/keystore.js").lookupKey;
let setConfig: typeof import("../src/homeserver/config.js").setConfig;
let resetQuotaWindows: typeof import("../src/homeserver/quota.js").resetQuotaWindows;

let port = 0;
let inertPort = 0;
let stop: (() => Promise<void>) | null = null;
let stopInert: (() => Promise<void>) | null = null;
let offPort = 0;
let stopOff: (() => Promise<void>) | null = null;

const DEFAULTS = { rpm: 1000, tpm: 0, dailyTokenBudget: 0, maxParallel: 2 };

beforeAll(async () => {
  initDb(join(mkdtempSync(join(tmpdir(), "hs-img-gw-")), "test.db"));
  await startSidecar();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${sidecarPort}/v1`;
  process.env["HOMESERVER_BACKEND"] = "llamaswap";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "1"; // so the worker holding the slot starves a guest → 503
  process.env["HOMESERVER_OWNER_QUEUE_MAX_MS"] = "300";
  process.env["HOMESERVER_IMAGE_URL"] = `http://127.0.0.1:${sidecarPort}`;
  process.env["HOMESERVER_IMAGE_MAX_N"] = "4";
  process.env["HOMESERVER_IMAGE_CREDITS_PER_IMAGE_FAST"] = String(FAST);
  process.env["HOMESERVER_IMAGE_CREDITS_PER_IMAGE_BALANCED"] = String(BALANCED);
  process.env["HOMESERVER_IMAGE_CREDITS_PER_IMAGE_HIGH"] = String(HIGH);
  process.env["HOMESERVER_IMAGE_RESULT_DIR"] = join(mkdtempSync(join(tmpdir(), "hs-img-res-")), "out");
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "0";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "admin-static-key";
  process.env["HOMESERVER_API_KEYS"] = "legacy-user-key";

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const cfgMod = await import("../src/homeserver/config.js");
  const q = await import("../src/homeserver/quota.js");
  startGateway = gw.startGateway;
  mintKey = ks.mintKey;
  lookupKey = ks.lookupKey;
  setConfig = cfgMod.setConfig;
  resetQuotaWindows = q.resetQuotaWindows;

  const h = await startGateway();
  port = h.port;
  stop = h.stop;

  // A second gateway with NO image sidecar configured → the whole image surface is inert.
  setConfig({ imageUrl: "" });
  const inert = await startGateway();
  inertPort = inert.port;
  stopInert = inert.stop;
  // Restore the singleton for tidiness (the primary gateway captured its own cfg object).
  setConfig({ imageUrl: `http://127.0.0.1:${sidecarPort}` });

  // A separate gateway captures the config snapshot with owner logging disabled.
  setConfig({ ownerRequestLog: "off" });
  const off = await startGateway();
  offPort = off.port;
  stopOff = off.stop;
  setConfig({ ownerRequestLog: "on" });
});

afterAll(async () => {
  if (stop) await stop();
  if (stopInert) await stopInert();
  if (stopOff) await stopOff();
  await new Promise<void>((r) => sidecar.close(() => r()));
});

beforeEach(() => {
  resetQuotaWindows();
  gateEnabled = false;
  releaseGate = null;
  mode = "ok";
  sidecarHits = 0;
});

function gen(p: number, token: string | null, body: unknown): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${p}/v1/images/generations`, { method: "POST", headers, body: JSON.stringify(body) });
}
function setMaintenance(on: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/admin/maintenance`, {
    method: "POST",
    headers: { authorization: "Bearer admin-static-key", "content-type": "application/json" },
    body: JSON.stringify({ on, mode: on ? "exclusive" : undefined, ttlSeconds: on ? 60 : undefined }),
  });
}
function jobReq(method: string, token: string, id: string, targetPort = port): Promise<Response> {
  return fetch(`http://127.0.0.1:${targetPort}/v1/images/generations/jobs/${id}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}
const credits = (k: string): number => lookupKey(k)!.creditsUsed;

async function poll(token: string, id: string, want: string, timeoutMs = 4000, targetPort = port): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await jobReq("GET", token, id, targetPort);
    const j = (await r.json()) as Record<string, unknown>;
    if (j["status"] === want || Date.now() > deadline) return j;
    await new Promise((res) => setTimeout(res, 25));
  }
}

describe("POST /v1/images/generations — sync fast tier", () => {
  it("401 for an unauthenticated request", async () => {
    const r = await gen(port, null, { prompt: "x", model: "image-fast" });
    expect(r.status).toBe(401);
  });

  it("returns n b64 images and debits n × per-image credits; content-blind", async () => {
    const k = mintKey({ alias: "img-sync", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: SECRET_PROMPT_MARKER, model: "image-fast", n: 2 });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { created: number; data: Array<{ b64_json: string }> };
    expect(j.data).toHaveLength(2);
    expect(typeof j.data[0]!.b64_json).toBe("string");
    expect(credits(k.plaintextKey)).toBe(2 * FAST);

    // Content-blind: the prompt marker is in NO request_log row and NOT in the metrics text.
    const logged = JSON.stringify(getRequestLog(500));
    expect(logged).not.toContain(SECRET_PROMPT_MARKER);
    expect(renderMetrics()).not.toContain(SECRET_PROMPT_MARKER);
    // The image counter advanced for the canonical model id.
    expect(renderMetrics()).toMatch(/homeserver_images_total\{model="image-fast"\}/);
    // A guest is NEVER content-logged.
    expect(JSON.stringify(getOwnerLog(500))).not.toContain(SECRET_PROMPT_MARKER);
  });

  it("owner-logs a minted OWNER sync image request with its prompt marker", async () => {
    const marker = "OWNER_IMAGE_SYNC_CAPTURE_MARKER";
    const k = mintKey({ alias: "img-owner-sync", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: marker, model: "image-fast" });
    expect(r.status).toBe(200);
    expect((await r.json() as { data: unknown[] }).data).toHaveLength(1);
    const row = getOwnerLog(500).find((entry) => entry.alias === "img-owner-sync");
    expect(row).toBeDefined();
    expect(row!.route).toBe("image");
    expect(row!.messagesJson).toContain(marker);
    expect(row!.completion).toBe("1 image(s) generated");
  });

  it("does not owner-log the legacy static admin key for a successful image", async () => {
    const marker = "STATIC_ADMIN_IMAGE_PROMPT";
    const before = getOwnerLog(500).filter((entry) => entry.alias === "static:admin").length;
    const r = await gen(port, "admin-static-key", { prompt: marker, model: "image-fast" });
    expect(r.status).toBe(200);
    const after = getOwnerLog(500);
    expect(after.filter((entry) => entry.alias === "static:admin")).toHaveLength(before);
    expect(JSON.stringify(after)).not.toContain(marker);
  });

  it("does not owner-log a minted OWNER when owner logging is disabled", async () => {
    const marker = "OWNER_IMAGE_OFF_MARKER";
    const k = mintKey({ alias: "img-owner-off", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(offPort, k.plaintextKey, { prompt: marker, model: "image-fast" });
    expect(r.status).toBe(200);
    expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-off")).toBe(false);
    expect(JSON.stringify(getOwnerLog(500))).not.toContain(marker);
  });

  it("does not owner-log a minted OWNER on a sync sidecar failure or empty response", async () => {
    mode = "fault";
    const failed = mintKey({ alias: "img-owner-sync-failure", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const failureResponse = await gen(port, failed.plaintextKey, { prompt: "OWNER_IMAGE_FAILURE_MARKER", model: "image-fast" });
    expect(failureResponse.status).toBe(502);
    expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-sync-failure")).toBe(false);
    expect(JSON.stringify(getOwnerLog(500))).not.toContain("OWNER_IMAGE_FAILURE_MARKER");

    mode = "empty";
    const empty = mintKey({ alias: "img-owner-sync-empty", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const emptyResponse = await gen(port, empty.plaintextKey, { prompt: "OWNER_IMAGE_EMPTY_MARKER", model: "image-fast" });
    expect(emptyResponse.status).toBe(502);
    expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-sync-empty")).toBe(false);
    expect(JSON.stringify(getOwnerLog(500))).not.toContain("OWNER_IMAGE_EMPTY_MARKER");
  });

  it("403 when the key's allow-list excludes the model (no charge)", async () => {
    const k = mintKey({ alias: "img-allow", tier: "guest", creditLimit: 1_000_000, modelAllowList: ["image-fast"] }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-high" });
    expect(r.status).toBe(403);
    expect(credits(k.plaintextKey)).toBe(0);
  });

  it("400 for an unknown model", async () => {
    const k = mintKey({ alias: "img-badmodel", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "dall-e" });
    expect(r.status).toBe(400);
  });

  it("402 overdraft refused up-front, never hits the sidecar", async () => {
    // creditLimit below worst-case (n=2 × FAST = 200) → reservation fails → 402 before dispatch.
    const k = mintKey({ alias: "img-poor", tier: "guest", creditLimit: 100 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast", n: 2 });
    expect(r.status).toBe(402);
    expect(credits(k.plaintextKey)).toBe(0);
    expect(sidecarHits).toBe(0);
  });

  it("429 when the per-key RPM window is exceeded", async () => {
    const k = mintKey({ alias: "img-rpm", tier: "guest", creditLimit: 1_000_000, rpm: 1 }, DEFAULTS);
    const r1 = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast" });
    expect(r1.status).toBe(200);
    const r2 = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast" });
    expect(r2.status).toBe(429);
  });

  it("describes TPM refusal in image units and never dispatches the request", async () => {
    const k = mintKey({ alias: "img-tpm-units", tier: "guest", creditLimit: 1_000_000, tpm: 1 }, { ...DEFAULTS, tpm: 1 });
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast", n: 2 });
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: { code: string; message: string; quota: Record<string, unknown> } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("1 image unit per minute");
    expect(body.error.message).toContain("request includes 2 image units");
    expect(body.error.message).not.toContain("tokens");
    expect(body.error.quota).toMatchObject({ reason: "tpm", limit: 1, requested: 2, counted: false });
    expect(r.headers.get("x-ratelimit-limit")).toBe("1");
    expect(r.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(r.headers.get("x-ratelimit-reset")).toBe(r.headers.get("retry-after"));
    expect(credits(k.plaintextKey)).toBe(0);
    expect(sidecarHits).toBe(0);
  });

  it("describes daily image quota in image units and rolls back the rejected reservation", async () => {
    const k = mintKey(
      { alias: "img-daily-units", tier: "guest", creditLimit: 1_000_000, tpm: 1_000, dailyTokenBudget: 1 },
      { ...DEFAULTS, tpm: 1_000, dailyTokenBudget: 1 },
    );
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast", n: 2 });
    expect(r.status).toBe(429);
    const body = (await r.json()) as { error: { code: string; message: string; quota: Record<string, unknown> } };
    expect(body.error.code).toBe("rate_limit_exceeded");
    expect(body.error.message).toContain("1 image unit per UTC day");
    expect(body.error.message).toContain("request includes 2 image units");
    expect(body.error.message).not.toContain("tokens");
    expect(body.error.quota).toMatchObject({ reason: "daily", window: "utc_day", limit: 1, requested: 2, counted: false });
    expect(r.headers.get("x-ratelimit-limit")).toBe("1");
    expect(r.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(r.headers.get("x-ratelimit-reset")).toBe(r.headers.get("retry-after"));
    expect(credits(k.plaintextKey)).toBe(0);
    expect(sidecarHits).toBe(0);
    const daily = getDb().prepare("SELECT tokens FROM key_usage_daily WHERE alias = ? AND day = ?")
      .get("img-daily-units", new Date().toISOString().slice(0, 10)) as { tokens: number } | undefined;
    expect(daily?.tokens ?? 0).toBe(0);
  });

  it("502 + full refund when the sidecar faults", async () => {
    mode = "fault";
    const k = mintKey({ alias: "img-502", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-fast", n: 2 });
    expect(r.status).toBe(502);
    expect(credits(k.plaintextKey)).toBe(0);
  });
});

describe("async balanced/high tiers + jobs", () => {
  it("exclusive maintenance rejects an owner async image before credits, queue, or sidecar work", async () => {
    const owner = mintKey({ alias: "img-owner-exclusive", tier: "owner", scope: "admin", creditLimit: 1_000_000 }, DEFAULTS);
    const engaged = await setMaintenance(true);
    expect(engaged.status).toBe(200);

    try {
      const response = await gen(port, owner.plaintextKey, { prompt: "x", model: "image-balanced" });
      const body = await response.json() as { error?: { code?: string } };
      const queued = getDb().prepare("SELECT COUNT(*) AS count FROM image_jobs WHERE alias = ?")
        .get("img-owner-exclusive") as { count: number };

      expect(response.status).toBe(503);
      expect(body.error?.code).toBe("server_busy");
      expect(credits(owner.plaintextKey)).toBe(0);
      expect(queued.count).toBe(0);
      expect(sidecarHits).toBe(0);
    } finally {
      const restored = await setMaintenance(false);
      expect(restored.status).toBe(200);
    }
  });

  it("202 → poll → succeeded with bytes; debits after completion", async () => {
    const k = mintKey({ alias: "img-async", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-balanced", n: 2 });
    expect(r.status).toBe(202);
    const sub = (await r.json()) as { id: string; status: string };
    expect(sub.status).toBe("queued");
    expect(sub.id).toMatch(/^imgjob_/);
    const done = await poll(k.plaintextKey, sub.id, "succeeded");
    expect(done["status"]).toBe("succeeded");
    expect((done["data"] as unknown[]).length).toBe(2);
    expect(credits(k.plaintextKey)).toBe(2 * BALANCED);

    const rows = getRequestLog(500).filter((row) => row.alias === "img-async");
    const submissions = rows.filter((row) => row.route === "/v1/images/generations");
    const completions = rows.filter((row) => row.route === "image");
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ admission: "n/a", status: 202 });
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ node: "m5", admission: "admitted", status: 200, model: "image-balanced" });
  });

  it("owner-logs a minted OWNER async image only after the job succeeds", async () => {
    const marker = "OWNER_IMAGE_ASYNC_CAPTURE_MARKER";
    const k = mintKey({ alias: "img-owner-async", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    gateEnabled = true;
    try {
      const r = await gen(port, k.plaintextKey, { prompt: marker, model: "image-balanced" });
      expect(r.status).toBe(202);
      const sub = (await r.json()) as { id: string };
      const deadline = Date.now() + 2000;
      while (sidecarHits === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sidecarHits).toBeGreaterThan(0);
      expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-async")).toBe(false);
      openGateForCleanup();
      const done = await poll(k.plaintextKey, sub.id, "succeeded");
      expect(done.status).toBe("succeeded");
    } finally {
      openGateForCleanup();
    }
    const row = getOwnerLog(500).find((entry) => entry.alias === "img-owner-async");
    expect(row).toBeDefined();
    expect(row!.route).toBe("image");
    expect(row!.messagesJson).toContain(marker);
    expect(row!.completion).toBe("1 image(s) generated");
  });

  it("does not owner-log a successful async image when owner logging is disabled", async () => {
    const marker = "OWNER_IMAGE_ASYNC_OFF_MARKER";
    const k = mintKey({ alias: "img-owner-async-off", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(offPort, k.plaintextKey, { prompt: marker, model: "image-balanced" });
    expect(r.status).toBe(202);
    const sub = (await r.json()) as { id: string };
    const done = await poll(k.plaintextKey, sub.id, "succeeded", 4000, offPort);
    expect(done.status).toBe("succeeded");
    expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-async-off")).toBe(false);
    expect(JSON.stringify(getOwnerLog(500))).not.toContain(marker);
  });

  it("does not owner-log an async OWNER when the sidecar returns no images", async () => {
    mode = "empty";
    const k = mintKey({ alias: "img-owner-async-empty", tier: "owner", scope: "agent", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "OWNER_IMAGE_ASYNC_EMPTY_MARKER", model: "image-balanced" });
    expect(r.status).toBe(202);
    const sub = (await r.json()) as { id: string };
    const failed = await poll(k.plaintextKey, sub.id, "failed");
    expect(failed.status).toBe("failed");
    expect(getOwnerLog(500).some((entry) => entry.alias === "img-owner-async-empty")).toBe(false);
    expect(JSON.stringify(getOwnerLog(500))).not.toContain("OWNER_IMAGE_ASYNC_EMPTY_MARKER");
  });

  it("#229: GET jobs/% (malformed percent-encoding) → 400 invalid_request_error, not 500", async () => {
    const k = mintKey({ alias: "img-malformed-id", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await jobReq("GET", k.plaintextKey, "%");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_request_error");
  });

  it("#229: DELETE jobs/% (malformed percent-encoding) → 400 invalid_request_error, not 500 (Codex review)", async () => {
    const k = mintKey({ alias: "img-malformed-id-delete", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await jobReq("DELETE", k.plaintextKey, "%");
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("invalid_request_error");
  });

  it("a cross-key job read returns a bare 404", async () => {
    const a = mintKey({ alias: "img-a", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const b = mintKey({ alias: "img-b", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, a.plaintextKey, { prompt: "x", model: "image-balanced" });
    const { id } = (await r.json()) as { id: string };
    const cross = await jobReq("GET", b.plaintextKey, id);
    expect(cross.status).toBe(404);
  });

  it("DELETE cancels + refunds, idempotently", async () => {
    gateEnabled = true; // hold the dispatch so the job stays running
    const k = mintKey({ alias: "img-cancel", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, k.plaintextKey, { prompt: "x", model: "image-balanced", n: 2 });
    const { id } = (await r.json()) as { id: string };
    // Wait until the worker has actually picked it up and is blocked on the gate.
    const deadline = Date.now() + 2000;
    while (sidecarHits === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));

    const d1 = await jobReq("DELETE", k.plaintextKey, id);
    expect(d1.status).toBe(200);
    expect((await d1.json() as { status: string }).status).toBe("cancelled");
    expect(credits(k.plaintextKey)).toBe(0);
    const d2 = await jobReq("DELETE", k.plaintextKey, id); // idempotent
    expect(d2.status).toBe(200);
    openGateForCleanup();
  });

  it("coexistence: a running async job holds the single slot → an honest guest gets 503", async () => {
    gateEnabled = true;
    const owner = mintKey({ alias: "img-coexist", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await gen(port, owner.plaintextKey, { prompt: "x", model: "image-balanced" });
    expect(r.status).toBe(202);
    // Wait until the worker is dispatching (slot held, mock blocked on the gate).
    const deadline = Date.now() + 2000;
    while (sidecarHits === 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 20));

    const guest = mintKey({ alias: "img-guest-busy", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const busy = await gen(port, guest.plaintextKey, { prompt: "x", model: "image-fast" });
    expect(busy.status).toBe(503);
    expect(credits(guest.plaintextKey)).toBe(0); // refunded — never ran
    openGateForCleanup();
  });
});

describe("/v1/models advertisement + inert behaviour", () => {
  it("the image tiers appear on /v1/models when the sidecar is configured", async () => {
    const k = mintKey({ alias: "img-models", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers: { authorization: `Bearer ${k.plaintextKey}` } });
    const j = (await r.json()) as { data: Array<{ id: string }> };
    const ids = j.data.map((m) => m.id);
    expect(ids).toEqual(expect.arrayContaining(["image-fast", "image-balanced", "image-high"]));
  });

  it("the inert gateway (no sidecar) 404s the route and omits image-* from /v1/models", async () => {
    const k = mintKey({ alias: "img-inert", tier: "guest", creditLimit: 1_000_000 }, DEFAULTS);
    const post = await gen(inertPort, k.plaintextKey, { prompt: "x", model: "image-fast" });
    expect(post.status).toBe(404);
    const r = await fetch(`http://127.0.0.1:${inertPort}/v1/models`, { headers: { authorization: `Bearer ${k.plaintextKey}` } });
    const j = (await r.json()) as { data: Array<{ id: string }> };
    expect(j.data.map((m) => m.id)).not.toContain("image-fast");
  });
});

/** Open the mock gate so a held dispatch finishes, freeing the single admission slot for later tests. */
function openGateForCleanup(): void {
  gateEnabled = false;
  if (releaseGate) releaseGate();
  releaseGate = null;
}
