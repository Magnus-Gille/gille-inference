/**
 * Access-log integration tests for the gateway (Finding 6).
 *
 * Injects a capturing logger via setDefaultLogger, starts a real gateway against a mock
 * upstream, and asserts:
 *   (a) a normal /v1/chat/completions request emits EXACTLY ONE gateway_request line
 *   (b) with accessLogHealthz off (default), a /healthz request emits ZERO lines
 *   (c) an error path (401 unauth) emits exactly one line with the right status/outcome
 *
 * Restores the default logger after each test.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  createAccessLogger,
  setDefaultLogger,
  defaultLogger as originalDefaultLogger,
  type AccessLogRecord,
} from "../src/homeserver/access-log.js";
import { renderMetrics } from "../src/homeserver/metrics.js";

// Captured log lines per test (reset in afterEach)
let captured: string[] = [];

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/api/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        models: [{
          type: "llm",
          key: "m1",
          display_name: "m1",
          loaded_instances: [],
        }],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "cmpl-1",
        choices: [{ message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
      })
    );
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
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let warmCatalogue: typeof import("../src/homeserver/catalogue.js").warmCatalogue;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeAll(async () => {
  // Isolate DB
  const dir = mkdtempSync(join(tmpdir(), "hs-accesslog-test-"));
  initDb(join(dir, "test.db"));

  await startUpstream();

  // Set env BEFORE importing the gateway (config is read at startGateway() time)
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
  process.env["HOMESERVER_BACKEND"] = "lmstudio";
  process.env["HOMESERVER_HOST"] = "127.0.0.1";
  process.env["HOMESERVER_PORT"] = "0";
  process.env["HOMESERVER_MAX_INFLIGHT"] = "2";
  process.env["HOMESERVER_PER_REQUEST_MAX_TOKENS"] = "256";
  process.env["HOMESERVER_KEY_DEFAULT_RPM"] = "1000";
  process.env["HOMESERVER_KEY_DEFAULT_TPM"] = "1000000";
  process.env["HOMESERVER_ADMIN_API_KEYS"] = "alog-admin-key";
  // Default: accessLogHealthz NOT set (= off)
  delete process.env["HOMESERVER_ACCESS_LOG_HEALTHZ"];

  const gw = await import("../src/homeserver/gateway.js");
  const ks = await import("../src/homeserver/keystore.js");
  const catalogue = await import("../src/homeserver/catalogue.js");
  mintKey = ks.mintKey;
  warmCatalogue = catalogue.warmCatalogue;

  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  if (stopGateway) await stopGateway();
  await new Promise<void>((r) => upstream.close(() => r()));
  // Restore the original logger at the end of the suite
  setDefaultLogger(originalDefaultLogger);
});

afterEach(() => {
  // Restore the original logger after each test so other test files aren't affected
  setDefaultLogger(originalDefaultLogger);
  captured = [];
});

function installCapturingLogger(): void {
  captured = [];
  setDefaultLogger(createAccessLogger((line) => captured.push(line)));
}

function url(path: string): string {
  return `http://127.0.0.1:${gatewayPort}${path}`;
}

describe("gateway access-log integration", () => {
  it("(a) normal /v1/chat/completions emits EXACTLY ONE gateway_request line", async () => {
    installCapturingLogger();
    const owner = mintKey({ alias: "alog-owner-a", tier: "owner" }, DEFAULTS);

    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(200);

    // Exactly one log line
    expect(captured).toHaveLength(1);
    const rec = JSON.parse(captured[0]!) as AccessLogRecord;
    expect(rec.event).toBe("gateway_request");
    expect(rec.route).toBe("/v1/chat/completions");
    expect(rec.status).toBe(200);
    expect(rec.outcome).toBe("ok");
    expect(rec.method).toBe("POST");
  });

  it("(b) /healthz with accessLogHealthz off (default) emits ZERO log lines", async () => {
    installCapturingLogger();

    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);

    // Default healthz logging is off — no lines emitted
    expect(captured).toHaveLength(0);
  });

  it("(c) 401 unauthenticated request emits exactly one line with status 401 / outcome auth_failed", async () => {
    installCapturingLogger();

    const res = await fetch(url("/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bad-token" },
      body: JSON.stringify({ model: "m1", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);

    // Exactly one log line
    expect(captured).toHaveLength(1);
    const rec = JSON.parse(captured[0]!) as AccessLogRecord;
    expect(rec.event).toBe("gateway_request");
    expect(rec.status).toBe(401);
    expect(rec.outcome).toBe("auth_failed");
    expect(rec.errorClass).toBe("invalid_api_key");
  });

  it("(d) DELETE /admin/keys/:alias logs the templated route, not the raw alias (#229)", async () => {
    installCapturingLogger();
    mintKey({ alias: "alog-admin-target", tier: "guest" }, DEFAULTS);

    const res = await fetch(url("/admin/keys/alog-admin-target"), {
      method: "DELETE",
      headers: { authorization: "Bearer alog-admin-key" },
    });
    expect(res.status).toBe(200);

    expect(captured).toHaveLength(1);
    const rec = JSON.parse(captured[0]!) as AccessLogRecord;
    expect(rec.route).toBe("/admin/keys/:alias");
  });

  it("(e) a non-admin DELETE /admin/keys/:alias still logs the templated route, not the raw alias (Codex review, #229)", async () => {
    const nonAdmin = mintKey({ alias: "alog-non-admin", tier: "guest" }, DEFAULTS);
    installCapturingLogger();

    const res = await fetch(url("/admin/keys/some-alias"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${nonAdmin.plaintextKey}` },
    });
    expect(res.status).toBe(403);

    expect(captured).toHaveLength(1);
    const rec = JSON.parse(captured[0]!) as AccessLogRecord;
    expect(rec.route).toBe("/admin/keys/:alias");
  });

  it("(f) GET /v1/images/generations/jobs/% (malformed id) logs the templated route, not the raw path (Codex review, #229)", async () => {
    installCapturingLogger();
    const guest = mintKey({ alias: "alog-img-malformed", tier: "guest" }, DEFAULTS);

    const res = await fetch(url("/v1/images/generations/jobs/%"), {
      headers: { authorization: `Bearer ${guest.plaintextKey}` },
    });
    expect(res.status).toBe(400);

    expect(captured).toHaveLength(1);
    const rec = JSON.parse(captured[0]!) as AccessLogRecord;
    expect(rec.route).toBe("/v1/images/generations/jobs/:id");
  });

  it("(g) /delegate preserves the caller model for the response and ledger but canonicalizes every access/request record", async () => {
    installCapturingLogger();
    await warmCatalogue();
    const owner = mintKey({
      alias: "alog-delegate-secret",
      tier: "owner",
      scope: "admin",
    }, DEFAULTS);
    const secretModelId = "sk-delegate-model-secret-9f2a";
    const prompt = "private delegate prompt must not enter telemetry";

    const response = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ prompt, taskType: "extract", modelId: secretModelId }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { modelId: string; ledgerId: string };
    expect(body.modelId).toBe(secretModelId);
    expect(body.ledgerId).toEqual(expect.any(String));

    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    const decision = records.find((record) => record.event === "delegate_decision");
    const gateway = records.find((record) => record.event === "gateway_request");
    expect(records.filter((record) => record.event === "delegate_decision")).toHaveLength(1);
    expect(records.filter((record) => record.event === "gateway_request")).toHaveLength(1);
    expect(decision).toMatchObject({ model: "unknown", taskType: "extract" });
    expect(gateway).toMatchObject({ route: "/delegate", model: "unknown", status: 200 });

    const requestRow = getDb()
      .prepare("SELECT * FROM request_log WHERE alias = ? ORDER BY ts DESC LIMIT 1")
      .get(owner.record.alias) as Record<string, unknown>;
    expect(requestRow.model).toBe("unknown");

    // Routing, response, and ledger identity remain caller-exact; only telemetry is canonicalized.
    const ledgerRow = getDb()
      .prepare("SELECT model_id FROM delegations WHERE id = ?")
      .get(body.ledgerId) as { model_id: string };
    expect(ledgerRow.model_id).toBe(secretModelId);

    const serializedTelemetry = JSON.stringify({ records, requestRow });
    expect(serializedTelemetry).not.toContain(secretModelId);
    expect(serializedTelemetry).not.toContain(prompt);
  });

  it("(h) /delegate exports a trusted configured model and collapses arbitrary IDs to one bounded sentinel", async () => {
    installCapturingLogger();
    await warmCatalogue();
    const owner = mintKey({
      alias: "alog-delegate-bounded",
      tier: "owner",
      scope: "admin",
    }, DEFAULTS);
    const requestedModelIds = ["m1", "caller-model-a", "caller-model-b"];

    for (const modelId of requestedModelIds) {
      const response = await fetch(url("/delegate"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
        body: JSON.stringify({ prompt: "bounded telemetry probe", taskType: "extract", modelId }),
      });
      expect(response.status).toBe(200);
      expect((await response.json() as { modelId: string }).modelId).toBe(modelId);
    }

    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    const decisions = records.filter((record) => record.event === "delegate_decision");
    const gateways = records.filter((record) => record.event === "gateway_request");
    expect(decisions.map((record) => record.model)).toEqual(["m1", "unknown", "unknown"]);
    expect(gateways.map((record) => record.model)).toEqual(["m1", "unknown", "unknown"]);

    const requestRows = getDb()
      .prepare("SELECT model FROM request_log WHERE alias = ? ORDER BY rowid ASC")
      .all(owner.record.alias) as Array<{ model: string }>;
    expect(requestRows.slice(-3).map((row) => row.model)).toEqual(["m1", "unknown", "unknown"]);
    expect(new Set(requestRows.slice(-3).map((row) => row.model)).size).toBe(2);
    const serializedTelemetry = JSON.stringify({ records, requestRows });
    expect(serializedTelemetry).not.toContain("caller-model-a");
    expect(serializedTelemetry).not.toContain("caller-model-b");
    const metrics = renderMetrics();
    expect(metrics).toContain('model="m1"');
    expect(metrics).toContain('model="unknown"');
    expect(metrics).not.toContain("caller-model-a");
    expect(metrics).not.toContain("caller-model-b");
  });
});
