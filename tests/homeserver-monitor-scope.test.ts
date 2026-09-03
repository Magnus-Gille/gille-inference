import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, initDb } from "../src/db.js";
import {
  commitKeyRotation,
  mintKey,
  preflightKeyRotation,
  stageKeyRotation,
  type KeyDefaults,
} from "../src/homeserver/keystore.js";

/**
 * Read-only MONITOR scope (gille-inference#35).
 *
 * A monitor key (HOMESERVER_MONITOR_API_KEYS) may read GET /ledger so a dashboard like
 * Heimdall can populate its capability map — but it must NOT be able to proxy/delegate
 * inference or touch /admin/*. Guests/users still may not read the ledger; admin is
 * unaffected. Static keys only (no minted store key needed).
 */

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "GET" && req.url === "/running") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ running: [] }));
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mellum", object: "model" }] }));
      return;
    }
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

const ADMIN_KEY = "admin-key-monitor-test";
const USER_KEY = "user-key-monitor-test";
const MONITOR_KEY = "monitor-key-monitor-test";
const DEFAULTS: KeyDefaults = { rpm: 1_000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };
const ORIGINAL_FEEDBACK_FILE = process.env["HOMESERVER_FEEDBACK_FILE"];
let MINTED_MONITOR_KEY = "";

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let runtimeDir = "";

beforeAll(async () => {
  runtimeDir = mkdtempSync(join(tmpdir(), "hs-monitor-test-"));
  initDb(join(runtimeDir, "test.db"));
  await startUpstream();

  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  // Public feedback is exercised below; keep its append-only store isolated from repository data.
  process.env["HOMESERVER_FEEDBACK_FILE"] = join(runtimeDir, "feedback.jsonl");
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  // Static keys across all three tiers — config is read once at first import, so set before it.
  process.env["HOMESERVER_ADMIN_API_KEYS"] = ADMIN_KEY;
  process.env["HOMESERVER_API_KEYS"] = USER_KEY;
  process.env["HOMESERVER_MONITOR_API_KEYS"] = MONITOR_KEY;
  MINTED_MONITOR_KEY = mintKey(
    { alias: "heimdall-monitor", tier: "guest", scope: "monitor" },
    DEFAULTS
  ).plaintextKey;

  const gw = await import("../src/homeserver/gateway.js");
  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  closeDb();
  rmSync(runtimeDir, { recursive: true, force: true });
  if (ORIGINAL_FEEDBACK_FILE === undefined) delete process.env["HOMESERVER_FEEDBACK_FILE"];
  else process.env["HOMESERVER_FEEDBACK_FILE"] = ORIGINAL_FEEDBACK_FILE;
});

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}
const auth = (key: string) => ({ Authorization: `Bearer ${key}` });

async function expectMonitorRouteDenied(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe("route_not_allowed");
}

describe("read-only monitor scope (#35)", () => {
  it("monitor key CAN read GET /ledger (200 + report/recent)", async () => {
    const res = await fetch(url("/ledger"), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report?: unknown; recent?: unknown };
    expect(body).toHaveProperty("report");
    expect(body).toHaveProperty("recent");
  });

  it("minted monitor scope uses the same read-only route fence", async () => {
    const ledger = await fetch(url("/ledger"), { headers: auth(MINTED_MONITOR_KEY) });
    expect(ledger.status).toBe(200);
    const inference = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { ...auth(MINTED_MONITOR_KEY), "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
    });
    await expectMonitorRouteDenied(inference);
    const admin = await fetch(url("/admin/keys"), { headers: auth(MINTED_MONITOR_KEY) });
    await expectMonitorRouteDenied(admin);
  });

  it("rotation preflight requires an actual successful gateway request by the replacement", async () => {
    const old = mintKey(
      { alias: "monitor-rotation", tier: "guest", scope: "monitor" },
      DEFAULTS
    );
    const staged = stageKeyRotation("monitor-rotation", {}, DEFAULTS, { overlapSeconds: 3_600 });

    expect(() => preflightKeyRotation(staged.plan.planId)).toThrow(/no successful.*gateway/i);
    const rejected = await fetch(url("/ledger"), { headers: auth("invalid-replacement-token") });
    expect(rejected.status).toBe(401);
    expect(() => preflightKeyRotation(staged.plan.planId)).toThrow(/no successful.*gateway/i);

    const accepted = await fetch(url("/ledger"), { headers: auth(staged.plaintextKey) });
    expect(accepted.status).toBe(200);
    expect(preflightKeyRotation(staged.plan.planId)).toMatchObject({
      replacementAlias: staged.newAlias,
      preflightUseCount: 1,
    });
    commitKeyRotation(staged.plan.planId);

    expect((await fetch(url("/ledger"), { headers: auth(old.plaintextKey) })).status).toBe(401);
    expect((await fetch(url("/ledger"), { headers: auth(staged.plaintextKey) })).status).toBe(200);
  });

  // #227: GET /ledger/:id must honor the same read-only monitor scope as GET /ledger — the
  // pre-dispatch monitor allowlist below is the actual auth gate a monitor key hits first.
  it("monitor key CAN read GET /ledger/:id (#227)", async () => {
    const { recordDelegation } = await import("../src/homeserver/ledger.js");
    const id = recordDelegation({ taskType: "monitor-scope-ledger-id-test", modelId: "m1", prompt: "x", outcome: "pass" });
    const res = await fetch(url(`/ledger/${id}`), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id?: string };
    expect(body.id).toBe(id);
  });

  it("monitor ledger projections never expose reviewer note bytes", async () => {
    const { recordDelegation, recordReviewerUsefulness } = await import("../src/homeserver/ledger.js");
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "m1",
      prompt: "x",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "pass",
      notes: "ref:gille-inference#112 check:manual",
      judgedBy: "grimnir-session-2026-08-01",
    })).toMatchObject({ kind: "recorded" });

    const res = await fetch(url(`/ledger/${id}`), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviewerUsefulness: string | null;
      reviewerUsefulnessNotes: string | null;
      reviewerUsefulnessNotesPresent: boolean;
      reviewerUsefulnessNoteChars: number;
    };
    expect(body.reviewerUsefulness).toBe("pass");
    expect(body.reviewerUsefulnessNotes).toBeNull();
    expect(body.reviewerUsefulnessNotesPresent).toBe(true);
    expect(body.reviewerUsefulnessNoteChars).toBe("ref:gille-inference#112 check:manual".length);
    expect(JSON.stringify(body)).not.toContain("ref:gille-inference#112 check:manual");
  });

  it("GET /ledger stays content-blind for monitor readers even when recent rows have reviewer notes", async () => {
    const { recordDelegation, recordReviewerUsefulness } = await import("../src/homeserver/ledger.js");
    const id = recordDelegation({
      taskType: "review-bounded",
      modelId: "m1",
      prompt: "x",
      outcome: "pass",
      verifier: "reviewBoundedVerifier",
      source: "gateway",
    });
    expect(recordReviewerUsefulness({
      ledgerId: id,
      usefulness: "partial",
      notes: "ref:gille-inference#112 followup:manual",
      judgedBy: "grimnir-session-2026-08-01",
    })).toMatchObject({ kind: "recorded" });

    const res = await fetch(url("/ledger"), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: unknown[]; recent: Array<Record<string, unknown>> };
    expect(JSON.stringify(body)).not.toContain("ref:gille-inference#112 followup:manual");

    const recentRow = body.recent.find((row) => row["id"] === id);
    expect(recentRow).toBeDefined();
    expect(recentRow).not.toHaveProperty("reviewerUsefulnessNotes");
    expect(recentRow).not.toHaveProperty("reviewerUsefulnessNotesPresent");
    expect(recentRow).not.toHaveProperty("reviewerUsefulnessNoteChars");
  });

  it("monitor key CANNOT proxy inference — POST /v1/chat/completions is 403", async () => {
    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { ...auth(MONITOR_KEY), "content-type": "application/json" },
      body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
    });
    await expectMonitorRouteDenied(res);
  });

  it("monitor key CANNOT delegate — POST /delegate is 403", async () => {
    const res = await fetch(url("/delegate"), {
      method: "POST",
      headers: { ...auth(MONITOR_KEY), "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    await expectMonitorRouteDenied(res);
  });

  it("monitor key CANNOT hit admin — GET /admin/keys is 403", async () => {
    const res = await fetch(url("/admin/keys"), { headers: auth(MONITOR_KEY) });
    await expectMonitorRouteDenied(res);
  });

  it("guest/user key still CANNOT read /ledger (403)", async () => {
    const res = await fetch(url("/ledger"), { headers: auth(USER_KEY) });
    expect(res.status).toBe(403);
  });

  it("admin key can still read /ledger (200) — unchanged", async () => {
    const res = await fetch(url("/ledger"), { headers: auth(ADMIN_KEY) });
    expect(res.status).toBe(200);
  });

  it("no token is still 401 on /ledger", async () => {
    const res = await fetch(url("/ledger"));
    expect(res.status).toBe(401);
  });

  // The monitor scope must hold even on PUBLIC routes dispatched before the main auth gate.
  it("monitor key is blocked on the public POST /portal/feedback (403)", async () => {
    const res = await fetch(url("/portal/feedback"), {
      method: "POST",
      headers: { ...auth(MONITOR_KEY), "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    await expectMonitorRouteDenied(res);
  });

  it("monitor key blocked on GET /hs (403) but allowed on GET /healthz (200)", async () => {
    const hs = await fetch(url("/hs"), { headers: auth(MONITOR_KEY) });
    await expectMonitorRouteDenied(hs);
    const health = await fetch(url("/healthz"), { headers: auth(MONITOR_KEY) });
    expect(health.status).toBe(200);
  });

  it("anonymous (no-token) feedback still works — public route unaffected by the monitor gate", async () => {
    const res = await fetch(url("/portal/feedback"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "anon hello" }),
    });
    expect(res.status).toBe(200);
  });

  // gille-inference#44 — monitor scope should be able to read GET /models
  it("monitor key CAN read GET /models (200 + models array)", async () => {
    const res = await fetch(url("/models"), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models?: unknown };
    expect(body).toHaveProperty("models");
    expect(Array.isArray(body.models)).toBe(true);
  });

  it("monitor key CAN read the content-blind M5 usage summary", async () => {
    const res = await fetch(url("/ops/summary"), { headers: auth(MONITOR_KEY) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("generatedAt");
    expect(body).toHaveProperty("activeRequests");
    expect(body).toHaveProperty("last24Hours");
    expect(body).toHaveProperty("last24HoursByTier");
    expect(body).toHaveProperty("last7Days");
    expect(body).toHaveProperty("daily");
    expect(JSON.stringify(body)).not.toMatch(/alias|key_hash|prompt|response|content/i);
  });

  it("guest/user and anonymous callers cannot read the usage summary", async () => {
    expect((await fetch(url("/ops/summary"), { headers: auth(USER_KEY) })).status).toBe(403);
    expect((await fetch(url("/ops/summary"))).status).toBe(401);
  });

  it("monitor key still CANNOT hit a non-allowed route — GET /admin/keys stays 403", async () => {
    const res = await fetch(url("/admin/keys"), { headers: auth(MONITOR_KEY) });
    await expectMonitorRouteDenied(res);
  });
});
