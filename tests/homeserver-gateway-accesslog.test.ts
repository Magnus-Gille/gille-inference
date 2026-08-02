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

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb, initDb } from "../src/db.js";
import {
  createAccessLogger,
  setDefaultLogger,
  defaultLogger,
  type AccessLogRecord,
  type AccessLogger,
} from "../src/homeserver/access-log.js";
import { renderMetrics, resetMetrics } from "../src/homeserver/metrics.js";

// Captured log lines per test (reset in afterEach)
let captured: string[] = [];

let upstream: Server;
let upstreamPort = 0;
let upstreamModelRequests: string[] = [];
let originalDefaultLogger: AccessLogger;

const MUTATED_ENV_KEYS = [
  "LMSTUDIO_BASE_URL",
  "HOMESERVER_BACKEND",
  "HOMESERVER_HOST",
  "HOMESERVER_PORT",
  "HOMESERVER_MAX_INFLIGHT",
  "HOMESERVER_PER_REQUEST_MAX_TOKENS",
  "HOMESERVER_KEY_DEFAULT_RPM",
  "HOMESERVER_KEY_DEFAULT_TPM",
  "HOMESERVER_ADMIN_API_KEYS",
  "HOMESERVER_ACCESS_LOG_HEALTHZ",
] as const;
let originalEnv = new Map<string, string | undefined>();

function restoreEnvironment(): void {
  for (const key of MUTATED_ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

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
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unexpected mock route" }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: { model?: unknown };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: unknown };
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid mock request JSON" }));
        return;
      }
      if (typeof body.model === "string") upstreamModelRequests.push(body.model);
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

let gatewayPort = 0;
let stopGateway: (() => Promise<void>) | null = null;
let mintKey: typeof import("../src/homeserver/keystore.js").mintKey;
let warmCatalogue: typeof import("../src/homeserver/catalogue.js").warmCatalogue;
let resetCatalogueCache: typeof import("../src/homeserver/catalogue.js").resetCatalogueCache;
let resetConfig: typeof import("../src/homeserver/config.js").resetConfig;

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeAll(async () => {
  // Capture the object value before startGateway or any test replaces the live ESM binding.
  originalDefaultLogger = defaultLogger;
  originalEnv = new Map(MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]));

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
  const config = await import("../src/homeserver/config.js");
  mintKey = ks.mintKey;
  warmCatalogue = catalogue.warmCatalogue;
  resetCatalogueCache = catalogue.resetCatalogueCache;
  resetConfig = config.resetConfig;

  const handle = await gw.startGateway();
  gatewayPort = handle.port;
  stopGateway = handle.stop;
});

afterAll(async () => {
  try {
    if (stopGateway) await stopGateway();
    await new Promise<void>((r) => upstream.close(() => r()));
  } finally {
    // Restore every process-global value this suite mutates, including absent values.
    setDefaultLogger(originalDefaultLogger);
    resetMetrics();
    resetCatalogueCache();
    restoreEnvironment();
    resetConfig();
  }
});

beforeEach(() => {
  resetMetrics();
  upstreamModelRequests = [];
});

afterEach(() => {
  // Restore the original logger after each test so other test files aren't affected
  setDefaultLogger(originalDefaultLogger);
  resetMetrics();
  resetCatalogueCache();
  captured = [];
});

function installCapturingLogger(onRecord?: (record: AccessLogRecord) => void): void {
  captured = [];
  setDefaultLogger(createAccessLogger((line) => {
    captured.push(line);
    onRecord?.(JSON.parse(line) as AccessLogRecord);
  }));
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
    // Exercise the cold-catalogue fail-closed path explicitly. The background refresh may finish
    // during the call, but an arbitrary caller id must remain absent from every telemetry sink.
    resetCatalogueCache();
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
    expect(upstreamModelRequests).toEqual([secretModelId]);

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
    const metrics = renderMetrics();
    expect(metrics).toContain(
      'homeserver_requests_total{model="unknown",outcome="ok",tier="owner"} 1',
    );
    expect(metrics).not.toContain(secretModelId);
  });

  it("(h) /delegate exports a trusted resident model and collapses arbitrary IDs to one bounded sentinel", async () => {
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
    expect(upstreamModelRequests).toEqual(requestedModelIds);

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
    expect(metrics).toContain(
      'homeserver_requests_total{model="m1",outcome="ok",tier="owner"} 1',
    );
    expect(metrics).toContain(
      'homeserver_requests_total{model="unknown",outcome="ok",tier="owner"} 2',
    );
    expect(metrics).not.toContain("caller-model-a");
    expect(metrics).not.toContain("caller-model-b");
  });

  it("(i) /delegate telemetry ignores a principal allow-list and fails closed before orchestration", async () => {
    installCapturingLogger();
    await warmCatalogue();
    const staleAllowedModel = "stale-allow-listed-secret-41c9";
    const owner = mintKey({
      alias: "alog-delegate-scoped",
      tier: "owner",
      scope: "admin",
      modelAllowList: [staleAllowedModel],
    }, DEFAULTS);

    // Existing policy rejects scoped /delegate keys before orchestration. Even on that early path,
    // a resident model excluded by the principal list remains useful telemetry, while a stale id
    // present only in that list must collapse to the bounded sentinel.
    for (const modelId of ["m1", staleAllowedModel]) {
      const response = await fetch(url("/delegate"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
        body: JSON.stringify({ prompt: "early failure probe", taskType: "extract", modelId }),
      });
      expect(response.status).toBe(403);
    }

    expect(upstreamModelRequests).toEqual([]);
    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    expect(records.filter((record) => record.event === "delegate_decision")).toHaveLength(0);
    const gateways = records.filter((record) => record.event === "gateway_request");
    expect(gateways).toHaveLength(2);
    expect(gateways.map((record) => record.model)).toEqual(["m1", "unknown"]);
    expect(gateways.map((record) => record.outcome)).toEqual(["forbidden", "forbidden"]);

    const requestRows = getDb()
      .prepare("SELECT model, outcome FROM request_log WHERE alias = ? ORDER BY rowid ASC")
      .all(owner.record.alias) as Array<{ model: string; outcome: string }>;
    expect(requestRows).toEqual([
      { model: "m1", outcome: "forbidden" },
      { model: "unknown", outcome: "forbidden" },
    ]);

    const metrics = renderMetrics();
    expect(metrics).toContain(
      'homeserver_requests_total{model="m1",outcome="forbidden",tier="owner"} 1',
    );
    expect(metrics).toContain(
      'homeserver_requests_total{model="unknown",outcome="forbidden",tier="owner"} 1',
    );
    expect(JSON.stringify({ records, requestRows, metrics })).not.toContain(staleAllowedModel);
  });

  it("(j) /delegate reuses one trusted served-model snapshot across decision and gateway telemetry", async () => {
    await warmCatalogue();
    let invalidatedAfterDecision = false;
    installCapturingLogger((record) => {
      if (record.event === "delegate_decision") {
        invalidatedAfterDecision = true;
        resetCatalogueCache();
      }
    });
    const owner = mintKey({
      alias: "alog-delegate-one-snapshot",
      tier: "owner",
      scope: "admin",
    }, DEFAULTS);

    const response = await fetch(url("/delegate"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
      body: JSON.stringify({ prompt: "snapshot consistency probe", taskType: "extract", modelId: "m1" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.modelId).toBe("m1");
    expect(body).not.toHaveProperty("telemetryModel");
    expect(invalidatedAfterDecision).toBe(true);
    expect(upstreamModelRequests).toEqual(["m1"]);

    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    expect(records.filter((record) => record.event === "delegate_decision").map((record) => record.model)).toEqual(["m1"]);
    expect(records.filter((record) => record.event === "gateway_request").map((record) => record.model)).toEqual(["m1"]);
    const requestRow = getDb()
      .prepare("SELECT model FROM request_log WHERE alias = ? ORDER BY rowid DESC LIMIT 1")
      .get(owner.record.alias) as { model: string };
    expect(requestRow.model).toBe("m1");
    expect(renderMetrics()).toContain(
      'homeserver_requests_total{model="m1",outcome="ok",tier="owner"} 1',
    );
  });

  it("(k) /delegate keeps existing empty/whitespace execution while telemetry never emits none", async () => {
    installCapturingLogger();
    await warmCatalogue();
    const owner = mintKey({
      alias: "alog-delegate-blank-success",
      tier: "owner",
      scope: "admin",
    }, DEFAULTS);
    const callerModelIds = ["", "   "];
    const expectedOutcomeModelIds = ["(none)", "   "];
    const ledgerModelIds: string[] = [];
    const responseBodies: Array<{
      modelId: string;
      ledgerId?: string;
      delegated: boolean;
      escalate: boolean;
    }> = [];

    for (let index = 0; index < callerModelIds.length; index++) {
      const response = await fetch(url("/delegate"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
        body: JSON.stringify({ prompt: "blank model execution probe", taskType: "extract", modelId: callerModelIds[index] }),
      });
      expect(response.status).toBe(200);
      const body = await response.json() as typeof responseBodies[number];
      responseBodies.push(body);
      expect(body.modelId).toBe(expectedOutcomeModelIds[index]);
      if (body.ledgerId !== undefined) {
        const ledgerRow = getDb()
          .prepare("SELECT model_id FROM delegations WHERE id = ?")
          .get(body.ledgerId) as { model_id: string };
        ledgerModelIds.push(ledgerRow.model_id);
      }
    }

    // Existing execution semantics: empty reaches the no-loaded-model escalation with no ledger
    // write; whitespace is routed and persisted verbatim. Telemetry alone normalizes both.
    expect(responseBodies[0]).toMatchObject({ modelId: "(none)", delegated: false, escalate: true });
    expect(responseBodies[0]!.ledgerId).toBeUndefined();
    expect(responseBodies[1]).toMatchObject({ modelId: "   ", delegated: true, escalate: true });
    expect(upstreamModelRequests).toEqual(["   "]);
    expect(ledgerModelIds).toEqual(["   "]);
    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    expect(records.filter((record) => record.event === "delegate_decision").map((record) => record.model)).toEqual(["unknown", "unknown"]);
    expect(records.filter((record) => record.event === "gateway_request").map((record) => record.model)).toEqual(["unknown", "unknown"]);
    expect(records.every((record) => record.model !== null && record.model !== "none")).toBe(true);
    const requestRows = getDb()
      .prepare("SELECT model FROM request_log WHERE alias = ? ORDER BY rowid ASC")
      .all(owner.record.alias) as Array<{ model: string }>;
    expect(requestRows.map((row) => row.model)).toEqual(["unknown", "unknown"]);
    const metrics = renderMetrics();
    expect(metrics).toContain('homeserver_requests_total{model="unknown",outcome="ok",tier="owner"} 2');
    expect(metrics).not.toContain('model="none"');
  });

  it("(l) /delegate maps empty/whitespace IDs to unknown on the existing early-failure path", async () => {
    installCapturingLogger();
    await warmCatalogue();
    const owner = mintKey({
      alias: "alog-delegate-blank-early",
      tier: "owner",
      scope: "admin",
      modelAllowList: ["m1"],
    }, DEFAULTS);
    const responseBodies: string[] = [];

    for (const modelId of ["", "   "]) {
      const response = await fetch(url("/delegate"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${owner.plaintextKey}` },
        body: JSON.stringify({ prompt: "blank early failure probe", taskType: "extract", modelId }),
      });
      expect(response.status).toBe(403);
      responseBodies.push(await response.text());
    }

    // Existing policy rejects both values identically before orchestration or upstream execution.
    expect(new Set(responseBodies).size).toBe(1);
    expect(JSON.parse(responseBodies[0]!) as unknown).toMatchObject({
      error: { code: "model_not_allowed" },
    });
    expect(upstreamModelRequests).toEqual([]);
    const records = captured.map((line) => JSON.parse(line) as AccessLogRecord);
    expect(records.filter((record) => record.event === "delegate_decision")).toHaveLength(0);
    expect(records.filter((record) => record.event === "gateway_request").map((record) => record.model)).toEqual(["unknown", "unknown"]);
    const requestRows = getDb()
      .prepare("SELECT model FROM request_log WHERE alias = ? ORDER BY rowid ASC")
      .all(owner.record.alias) as Array<{ model: string }>;
    expect(requestRows.map((row) => row.model)).toEqual(["unknown", "unknown"]);
    const metrics = renderMetrics();
    expect(metrics).toContain(
      'homeserver_requests_total{model="unknown",outcome="forbidden",tier="owner"} 2',
    );
    expect(metrics).not.toContain('model="none"');
  });
});
