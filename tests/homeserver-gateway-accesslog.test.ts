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
import { initDb } from "../src/db.js";
import {
  createAccessLogger,
  setDefaultLogger,
  defaultLogger as originalDefaultLogger,
  type AccessLogRecord,
} from "../src/homeserver/access-log.js";

// Captured log lines per test (reset in afterEach)
let captured: string[] = [];

let upstream: Server;
let upstreamPort = 0;

function startUpstream(): Promise<void> {
  upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
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

const DEFAULTS = { rpm: 1000, tpm: 1_000_000, dailyTokenBudget: 0, maxParallel: 1 };

beforeAll(async () => {
  // Isolate DB
  const dir = mkdtempSync(join(tmpdir(), "hs-accesslog-test-"));
  initDb(join(dir, "test.db"));

  await startUpstream();

  // Set env BEFORE importing the gateway (config is read at startGateway() time)
  process.env["LMSTUDIO_BASE_URL"] = `http://127.0.0.1:${upstreamPort}/v1`;
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
  mintKey = ks.mintKey;

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
});
